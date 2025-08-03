/* ==========================================================
   server.js – Hex-Board lobby + map-vote + faction picker
   (now with deterministic map seed & CORS support)
   ---------------------------------------------------------- */
const express = require('express');
const http    = require('http');
const cors    = require('cors');           // ← NEW
const { Server } = require('socket.io');
const crypto  = require('crypto');

const app  = express();
const srv  = http.createServer(app);

/* ----------------------------------------------------------
   CORS  (allow frontend at hexagamehub.com to talk to us)
---------------------------------------------------------- */
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'https://hexagamehub.com';

app.use(
  cors({
    origin: ALLOWED_ORIGIN,            // set '*' while testing if you like
    methods: ['GET', 'POST'],
    credentials: false
  })
);

const io = new Server(srv, {
  cors: {
    origin: ALLOWED_ORIGIN,
    methods: ['GET', 'POST']
  }
});

const PORT = process.env.PORT || 3000;

/* ----------------------------------------------------------
   Static files
---------------------------------------------------------- */
app.use(express.static(__dirname + '/public'));

/* ----------------------------------------------------------
   In-memory room tracking (not persisted)
---------------------------------------------------------- */
/*
room = {
  desiredPlayers,
  mapVotes:{id:mapType},
  mapType,
  seed,
  players:[{nick,socket,factionId}],
  pickIdx,
  availableFactions:[1..8]
}
*/
const rooms = {};

/* helpers ------------------------------------------------- */
function randomId(len = 4){
  return crypto.randomBytes(len).toString('base64url').slice(0, len).toUpperCase();
}
function mostVoted(votes){
  const tally={}, order=Object.values(votes);
  let winner=null,max=0;
  order.forEach(v=>{
    tally[v]=(tally[v]||0)+1;
    if(tally[v] > max){ max=tally[v]; winner=v; }
  });
  return winner;
}
function shuffle(arr){
  for(let i=arr.length-1;i>0;i--){
    const j=Math.floor(Math.random()*(i+1));
    [arr[i],arr[j]]=[arr[j],arr[i]];
  }
  return arr;
}


/* ----------------------------------------------------------
   Socket.IO handlers
---------------------------------------------------------- */
io.on('connection', socket => {

  /* ===== JOIN ===== */
  socket.on('join', ({ nickname, desiredPlayers }) => {
    /* find or create room */
    let roomId = Object.keys(rooms).find(r => {
      const rm = rooms[r];
      return rm.desiredPlayers === desiredPlayers &&
             rm.players.length  < desiredPlayers;
    });
    if (!roomId) {
      roomId = randomId();
      rooms[roomId] = {
        desiredPlayers,
        mapVotes:{},
        players:[],
        availableFactions:[1,2,3,4,5,6,7,8]
      };
    }

    /* add player */
    socket.join(roomId);
    rooms[roomId].players.push({ nick:nickname, socket, factionId:null });
    sendLobbyState(roomId);

    /* start map-selection phase when room is full */
    const room = rooms[roomId];
    if (room.players.length === desiredPlayers) {
      const maps = ['hexagon','thin','star','unique'];
      desiredPlayers === 1
        ? socket.emit('singlePlayerChoose', maps)
        : io.to(roomId).emit('voteMap', maps);
    }
  });

  /* ===== RE-JOIN AFTER PAGE REDIRECT ===== */
  socket.on('rejoin', ({ roomId }) => {
    socket.join(roomId);                       // fresh socket back in its room
  });

  /* ===== WORKER placed sync ===== */
  socket.on('workerPlaced', data => {
    const { roomId } = data;
    socket.to(roomId).emit('workerPlaced', data);   // relay to everyone else
  });

  /* ===== MAP VOTE (multiplayer) ===== */
  socket.on('vote', ({ roomId, mapType }) => {
    const rm = rooms[roomId]; if (!rm) return;

    rm.mapVotes[socket.id] = mapType;                  // keyed by socket.id
    if (Object.keys(rm.mapVotes).length === rm.players.length) {
      rm.mapType = mostVoted(rm.mapVotes);
      rm.seed    = rm.seed ?? crypto.randomBytes(4).readUInt32LE();
      startFactionPhase(roomId);
    }
  });

  /* ===== MAP pick (single-player) ===== */
  socket.on('singleChoice', ({ roomId, mapType }) => {
    const rm = rooms[roomId]; if (!rm) return;

    rm.mapType = mapType;
    rm.seed    = rm.seed ?? crypto.randomBytes(4).readUInt32LE();

    const p = rm.players[0];
    p.socket.emit('gameStart',{
      roomId,
      mapType,
      factionId : p.factionId,
      seed      : rm.seed,
      turnOrder : [p.factionId]                // solo list for consistency
    });
    delete rooms[roomId];
  });

  /* ===== FACTION pick ===== */
  socket.on('pickFaction', ({ roomId, factionId }) => {
    const rm = rooms[roomId]; if (!rm) return;

    const player = rm.players.find(p => p.socket === socket);
    if (!player || !rm.availableFactions.includes(factionId)) return;

    player.factionId = factionId;
    rm.availableFactions = rm.availableFactions.filter(x => x !== factionId);
    rm.pickIdx++;

    sendChooseFaction(roomId);

    /* everyone picked? */
    if (rm.pickIdx === rm.players.length) {
      rm.seed = rm.seed ?? crypto.randomBytes(4).readUInt32LE();    // safety

      /* build placement order list (lowest faction id starts) */
      const turnOrder = rm.players
                           .map(p => p.factionId)
                           .sort((a, b) => a - b);

      rm.players.forEach(p => {
        p.socket.emit('gameStart',{
          roomId,
          mapType  : rm.mapType,
          factionId: p.factionId,
          seed     : rm.seed,
          turnOrder
        });
      });
      delete rooms[roomId];
    }
  });

  /* ===== TOWN placed sync ===== */
  socket.on('townPlaced', data => {
    const { roomId } = data;
    socket.to(roomId).emit('townPlaced', data);       // broadcast placement
  });

  /* ===== PRODUCTION tick relay ===== */
  socket.on('productionTick', payload => {
    const { roomId } = payload || {};
    if (roomId) io.to(roomId).emit('productionTickAck', payload);
  });

});


/* ----------------------------------------------------------
   Helper broadcasts
---------------------------------------------------------- */
function sendLobbyState(roomId){
  const rm = rooms[roomId];
  io.to(roomId).emit('lobbyState',{
    roomId,
    players: rm.players.map(p=>p.nick),
    needed : rm.desiredPlayers
  });
}

function startFactionPhase(roomId){
  const rm = rooms[roomId];
  rm.pickIdx = 0;
  shuffle(rm.players);          // random player order once
  sendChooseFaction(roomId);
}

function sendChooseFaction(roomId){
  const rm = rooms[roomId];
  rm.players.forEach((p, idx)=>{
    p.socket.emit('chooseFaction',{
      available: rm.availableFactions,
      isTurn   : idx === rm.pickIdx
    });
  });
}

/* ---------------------------------------------------------- */
srv.listen(PORT, ()=>
  console.log(`► Hex-Board server running on http://localhost:${PORT}`)
);
