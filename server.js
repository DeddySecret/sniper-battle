const express = require("express");
const http = require("http");
const crypto = require("crypto");
const path = require("path");
const { Pool } = require("pg");
const { WebSocketServer } = require("ws");

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
app.use(express.json({ limit: "32kb" }));
app.use(express.static(path.join(__dirname, "public")));

const pool = process.env.DATABASE_URL ? new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes("localhost") ? false : { rejectUnauthorized: false }
}) : null;
const SECRET = process.env.AUTH_SECRET || process.env.DATABASE_URL;
const rooms = new Map();
const players = new Map();
const MAPS = [
  { id: "desert", name: "Пустыня" },
  { id: "forest", name: "Лес" },
  { id: "city", name: "Город" },
  { id: "snow", name: "Снежная база" },
  { id: "factory", name: "Завод" },
  { id: "mountain", name: "Горный перевал" }
];

function send(ws, data) { if (ws.readyState === 1) ws.send(JSON.stringify(data)); }
function broadcast(room, data, except) {
  for (const p of players.values()) if (p.room === room && p.ws !== except) send(p.ws, data);
}
function roomCount(code) {
  let n = 0;
  for (const p of players.values()) if (p.room === code) n++;
  return n;
}
function safeRoom(value) {
  return String(value || "").toUpperCase().replace(/[^A-Z0-9_-]/g, "").slice(0, 8);
}
function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return salt + ":" + hash;
}
function checkPassword(password, stored) {
  try {
    const [salt, hash] = stored.split(":");
    const actual = crypto.scryptSync(password, salt, 64);
    return crypto.timingSafeEqual(actual, Buffer.from(hash, "hex"));
  } catch { return false; }
}
function makeToken(user) {
  const payload = Buffer.from(JSON.stringify({ id: user.id, nick: user.nick, exp: Date.now() + 30 * 86400000 })).toString("base64url");
  const sig = crypto.createHmac("sha256", SECRET).update(payload).digest("base64url");
  return payload + "." + sig;
}
function readToken(token) {
  if (!SECRET || typeof token !== "string") return null;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  const expected = crypto.createHmac("sha256", SECRET).update(payload).digest();
  let actual;
  try { actual = Buffer.from(sig, "base64url"); } catch { return null; }
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString());
    return data.exp > Date.now() ? data : null;
  } catch { return null; }
}
async function auth(req, res, next) {
  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const user = readToken(token);
  if (!user) return res.status(401).json({ error: "Войди в аккаунт, чтобы продолжить." });
  req.user = user;
  next();
}
async function initDb() {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id BIGSERIAL PRIMARY KEY,
      nick VARCHAR(15) NOT NULL,
      nick_lower VARCHAR(15) NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}
app.get("/api/status", (req, res) => res.json({ database: !!pool, maps: MAPS }));
app.post("/api/register", async (req, res) => {
  try {
    if (!pool || !SECRET) return res.status(503).json({ error: "Сервер аккаунтов ещё не настроен. Сообщи разработчику." });
    const nick = String(req.body.nick || "").trim();
    const password = String(req.body.password || "");
    if (!/^[\p{L}\p{N}_-]{3,15}$/u.test(nick)) return res.status(400).json({ error: "Ник: 3–15 символов, только буквы, цифры, _ или -." });
    if (password.length < 6 || password.length > 72) return res.status(400).json({ error: "Пароль должен быть длиной от 6 до 72 символов." });
    const hash = hashPassword(password);
    const result = await pool.query(
      "INSERT INTO users(nick,nick_lower,password_hash) VALUES($1,$2,$3) RETURNING id,nick",
      [nick, nick.toLocaleLowerCase("ru-RU"), hash]
    );
    const user = { id: result.rows[0].id, nick: result.rows[0].nick };
    res.json({ token: makeToken(user), user });
  } catch (e) {
    if (e.code === "23505") return res.status(409).json({ error: "Это имя уже занято. Выбери другое." });
    console.error("register:", e); res.status(500).json({ error: "Не удалось создать аккаунт." });
  }
});
app.post("/api/login", async (req, res) => {
  try {
    if (!pool || !SECRET) return res.status(503).json({ error: "Сервер аккаунтов ещё не настроен." });
    const nick = String(req.body.nick || "").trim();
    const password = String(req.body.password || "");
    const result = await pool.query("SELECT id,nick,password_hash FROM users WHERE nick_lower=$1", [nick.toLocaleLowerCase("ru-RU")]);
    const row = result.rows[0];
    if (!row || !checkPassword(password, row.password_hash)) return res.status(401).json({ error: "Неверный ник или пароль." });
    const user = { id: row.id, nick: row.nick };
    res.json({ token: makeToken(user), user });
  } catch (e) { console.error("login:", e); res.status(500).json({ error: "Ошибка входа." }); }
});
app.get("/api/me", auth, (req, res) => res.json({ user: { id: req.user.id, nick: req.user.nick } }));
app.get("/api/rooms", auth, (req, res) => {
  res.json({ rooms: [...rooms.values()].map(r => ({
    code: r.code, name: r.name, mapId: r.mapId, mapName: MAPS.find(m => m.id === r.mapId)?.name || r.mapId,
    private: !!r.passwordHash, count: roomCount(r.code), maxPlayers: 15
  })) });
});
app.post("/api/rooms/create", auth, (req, res) => {
  const name = String(req.body.name || "Лобби").trim().slice(0, 24) || "Лобби";
  const mapId = String(req.body.mapId || "desert");
  if (!MAPS.some(m => m.id === mapId)) return res.status(400).json({ error: "Неизвестная карта." });
  const password = String(req.body.password || "");
  if (password && (password.length < 3 || password.length > 32)) return res.status(400).json({ error: "Пароль комнаты: 3–32 символа." });
  let code;
  do { code = crypto.randomBytes(3).toString("hex").toUpperCase(); } while (rooms.has(code));
  rooms.set(code, { code, name, mapId, ownerId: String(req.user.id), passwordHash: password ? hashPassword(password) : null });
  res.json({ room: { code, name, mapId, mapName: MAPS.find(m => m.id === mapId).name, private: !!password, count: 0, maxPlayers: 15 } });
});
app.post("/api/rooms/join", auth, (req, res) => {
  const code = safeRoom(req.body.code);
  const room = rooms.get(code);
  if (!room) return res.status(404).json({ error: "Лобби не найдено." });
  if (roomCount(code) >= 15) return res.status(409).json({ error: "Лобби заполнено (максимум 15 игроков)." });
  if (room.passwordHash && !checkPassword(String(req.body.password || ""), room.passwordHash))
    return res.status(403).json({ error: "Неверный пароль комнаты." });
  res.json({ room: { code: room.code, name: room.name, mapId: room.mapId, mapName: MAPS.find(m => m.id === room.mapId).name } });
});

wss.on("connection", ws => {
  const socketId = crypto.randomBytes(8).toString("hex");
  const p = { id: socketId, ws, room: null, user: null, x: 0, z: 0, yaw: 0, hp: 100, score: 0, lastShot: 0, dead: false };
  ws.on("message", async raw => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch { return; }
    if (m.type === "join") {
      if (p.room) return;
      const user = readToken(m.token);
      if (!user) return send(ws, { type: "error", message: "Сначала войди в аккаунт." });
      const room = safeRoom(m.room);
      const roomInfo = rooms.get(room);
      if (!roomInfo) return send(ws, { type: "error", message: "Лобби больше не существует. Обнови список комнат." });
      if (roomCount(room) >= 15) return send(ws, { type: "error", message: "Лобби заполнено (максимум 15 игроков)." });
      p.user = user; p.room = room; players.set(socketId, p);
      const spawnIndex = roomCount(room) - 1;
      const spawnAngle = (spawnIndex / 15) * Math.PI * 2;
      p.x = Math.cos(spawnAngle) * 7; p.z = Math.sin(spawnAngle) * 7; p.yaw = Math.atan2(-p.x, -p.z);
      send(ws, { type: "joined", id: socketId, nick: user.nick, room, roomName: roomInfo.name, mapId: roomInfo.mapId, x: p.x, z: p.z,
        players: [...players.values()].filter(q => q.room === room && q.id !== socketId).map(publicPlayer) });
      broadcast(room, { type: "playerJoined", player: publicPlayer(p) }, ws);
      broadcast(room, { type: "roomCount", count: roomCount(room) });
      return;
    }
    if (!p.room) return;
    if (m.type === "move") {
      if (p.dead) return;
      p.x = Math.max(-21, Math.min(21, Number(m.x) || 0));
      p.z = Math.max(-21, Math.min(21, Number(m.z) || 0));
      p.yaw = Number(m.yaw) || 0;
      p.y = Math.max(0, Math.min(2.5, Number(m.y) || 0));
      broadcast(p.room, { type: "playerMoved", player: publicPlayer(p) }, ws);
    }
    if (m.type === "shoot") {
      if (p.dead) return;
      const now = Date.now(); if (now - p.lastShot < 850) return; p.lastShot = now;
      const target = [...players.values()].find(q => q.room === p.room && q.id === m.target);
      if (!target || target.dead || target.hp <= 0) return;
      if (Math.hypot(target.x-p.x,target.z-p.z)>32) return send(ws,{type:"shotResult",hit:false,reason:"Далеко"});
      target.hp=0; target.dead=true; p.score++;
      send(target.ws,{type:"hit",hp:0,by:p.id,dead:true});
      broadcast(p.room,{type:"playerDied",id:target.id},target.ws);
      send(ws,{type:"shotResult",hit:true,damage:100,score:p.score});
      const deadRoom=p.room;
      setTimeout(()=>{
        if(!players.has(target.id)||target.room!==deadRoom||!target.dead)return;
        target.dead=false;target.hp=100;
        const idx=[...players.values()].filter(q=>q.room===deadRoom&&q.id!==target.id).length%15;
        const angle=idx/15*Math.PI*2;
        target.x=Math.cos(angle)*7;target.z=Math.sin(angle)*7;target.yaw=Math.atan2(-target.x,-target.z);
        send(target.ws,{type:"respawn",hp:100,x:target.x,z:target.z,yaw:target.yaw});
        broadcast(deadRoom,{type:"playerRespawned",player:publicPlayer(target)},target.ws);
      },2000);
      broadcast(p.room,{type:"score",scores:[...players.values()].filter(q=>q.room===p.room).map(q=>({id:q.id,score:q.score,hp:q.hp}))});
    }
  });
  ws.on("close",()=>{
    const room=p.room;
    if(room){players.delete(socketId);broadcast(room,{type:"playerLeft",id:socketId});broadcast(room,{type:"roomCount",count:roomCount(room)});}
  });
});
function publicPlayer(p){return{id:p.id,nick:p.user?.nick||"Игрок",x:p.x,z:p.z,y:p.y||0,yaw:p.yaw,hp:p.hp,score:p.score,dead:p.dead,ready:true};}

const PORT=process.env.PORT||3000;
initDb().then(()=>server.listen(PORT,"0.0.0.0",()=>console.log("Sniper Battle running on port "+PORT)))
  .catch(e=>{console.error("Database initialization failed:",e);process.exit(1);});
