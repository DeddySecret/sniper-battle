const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const path = require("path");

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
app.use(express.static(path.join(__dirname, "public")));

const players = new Map();
const rooms = new Map();

function send(ws, data) {
  if (ws.readyState === 1) ws.send(JSON.stringify(data));
}
function broadcast(room, data, except) {
  for (const p of players.values()) {
    if (p.room === room && p.ws !== except) send(p.ws, data);
  }
}
function roomCount(room) {
  let n = 0;
  for (const p of players.values()) if (p.room === room) n++;
  return n;
}
function safeRoom(value) {
  return String(value || "DUEL").toUpperCase().replace(/[^A-Z0-9_-]/g, "").slice(0, 12) || "DUEL";
}
function publicPlayer(p) {
  return { id: p.id, x: p.x, z: p.z, yaw: p.yaw, hp: p.hp, score: p.score, ready: true };
}

wss.on("connection", ws => {
  const id = Math.random().toString(36).slice(2, 9);
  const p = { id, ws, room: null, x: 0, z: 0, yaw: 0, hp: 100, score: 0, lastShot: 0 };
  players.set(id, p);

  ws.on("message", raw => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch { return; }

    if (m.type === "join") {
      const room = safeRoom(m.room);
      if (p.room) return;
      if (roomCount(room) >= 2) return send(ws, { type: "error", message: "В комнате уже два игрока." });
      p.room = room;
      p.x = roomCount(room) === 1 ? 5 : -5;
      p.z = 0;
      send(ws, { type: "joined", id, room, x: p.x, z: p.z, players: [...players.values()].filter(q => q.room === room && q.id !== id).map(publicPlayer) });
      broadcast(room, { type: "playerJoined", player: publicPlayer(p) }, ws);
      broadcast(room, { type: "roomCount", count: roomCount(room) });
    }

    if (!p.room) return;

    if (m.type === "move") {
      p.x = Math.max(-19, Math.min(19, Number(m.x) || 0));
      p.z = Math.max(-19, Math.min(19, Number(m.z) || 0));
      p.yaw = Number(m.yaw) || 0;
      broadcast(p.room, { type: "playerMoved", player: publicPlayer(p) }, ws);
    }

    if (m.type === "shoot") {
      const now = Date.now();
      if (now - p.lastShot < 850) return;
      p.lastShot = now;
      const target = [...players.values()].find(q => q.room === p.room && q.id === m.target);
      if (!target || target.hp <= 0) return;
      const dx = target.x - p.x, dz = target.z - p.z;
      const dist = Math.hypot(dx, dz);
      if (dist > 32) return send(ws, { type: "shotResult", hit: false, reason: "Далеко" });
      target.hp = Math.max(0, target.hp - 50);
      if (target.hp === 0) {
        p.score++;
        setTimeout(() => {
          target.hp = 100;
          target.x = target.x < 0 ? -5 : 5;
          target.z = 0;
          send(target.ws, { type: "respawn", hp: 100 });
          broadcast(p.room, { type: "playerMoved", player: publicPlayer(target) }, target.ws);
        }, 2200);
      }
      send(ws, { type: "shotResult", hit: true, damage: 50, score: p.score });
      send(target.ws, { type: "hit", hp: target.hp, by: p.id });
      broadcast(p.room, { type: "score", scores: [...players.values()].filter(q => q.room === p.room).map(q => ({ id: q.id, score: q.score, hp: q.hp })) });
    }
  });

  ws.on("close", () => {
    const room = p.room;
    players.delete(id);
    if (room) {
      broadcast(room, { type: "playerLeft", id });
      broadcast(room, { type: "roomCount", count: roomCount(room) });
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => console.log(`Sniper Battle running on port ${PORT}`));
