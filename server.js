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
  return { id: p.id, x: p.x, z: p.z, yaw: p.yaw, hp: p.hp, score: p.score, dead: p.dead, ready: true };
}

wss.on("connection", ws => {
  const id = Math.random().toString(36).slice(2, 9);
  const p = { id, ws, room: null, x: 0, z: 0, yaw: 0, hp: 100, score: 0, lastShot: 0, dead: false };
  players.set(id, p);

  ws.on("message", raw => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch { return; }

    if (m.type === "join") {
      const room = safeRoom(m.room);
      if (p.room) return;
      if (roomCount(room) >= 10) return send(ws, { type: "error", message: "Комната заполнена (максимум 10 игроков)." });
      p.room = room;
      const spawnIndex = roomCount(room) - 1;
      const spawnAngle = (spawnIndex / 10) * Math.PI * 2;
      p.x = Math.cos(spawnAngle) * 7;
      p.z = Math.sin(spawnAngle) * 7;
      p.yaw = Math.atan2(-p.x, -p.z);
      p.hp = 100;
      p.dead = false;
      send(ws, { type: "joined", id, room, x: p.x, z: p.z, players: [...players.values()].filter(q => q.room === room && q.id !== id).map(publicPlayer) });
      broadcast(room, { type: "playerJoined", player: publicPlayer(p) }, ws);
      broadcast(room, { type: "roomCount", count: roomCount(room) });
    }

    if (!p.room) return;

    if (m.type === "move") {
      if (p.dead) return;
      p.x = Math.max(-19, Math.min(19, Number(m.x) || 0));
      p.z = Math.max(-19, Math.min(19, Number(m.z) || 0));
      p.yaw = Number(m.yaw) || 0;
      broadcast(p.room, { type: "playerMoved", player: publicPlayer(p) }, ws);
    }

    if (m.type === "shoot") {
      if (p.dead) return;
      const now = Date.now();
      if (now - p.lastShot < 850) return;
      p.lastShot = now;
      const target = [...players.values()].find(q => q.room === p.room && q.id === m.target);
      if (!target || target.dead || target.hp <= 0) return;
      const dx = target.x - p.x, dz = target.z - p.z;
      const dist = Math.hypot(dx, dz);
      if (dist > 32) return send(ws, { type: "shotResult", hit: false, reason: "Далеко" });
      // A sniper rifle is a one-shot elimination against 100 HP.
      target.hp = 0;
      target.dead = true;
      p.score++;
      send(target.ws, { type: "hit", hp: 0, by: p.id, dead: true });
      broadcast(p.room, { type: "playerDied", id: target.id }, target.ws);
      send(ws, { type: "shotResult", hit: true, damage: 100, score: p.score });
      const deadRoom = p.room;
      setTimeout(() => {
        if (!players.has(target.id) || target.room !== deadRoom || !target.dead) return;
        target.dead = false;
        target.hp = 100;
        const idx = [...players.values()].filter(q => q.room === deadRoom && q.id !== target.id).length % 10;
        const angle = (idx / 10) * Math.PI * 2;
        target.x = Math.cos(angle) * 7;
        target.z = Math.sin(angle) * 7;
        target.yaw = Math.atan2(-target.x, -target.z);
        send(target.ws, { type: "respawn", hp: 100, x: target.x, z: target.z, yaw: target.yaw });
        broadcast(deadRoom, { type: "playerRespawned", player: publicPlayer(target) }, target.ws);
      }, 2000);
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
