const express = require("express");
const http = require("http");
const crypto = require("crypto");
const path = require("path");
const { Pool } = require("pg");
const { WebSocketServer } = require("ws");

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, maxPayload: 16 * 1024, perMessageDeflate: false });
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


const SHOP_ITEMS = [
  { id:"standard", name:"Стандартная экипировка", description:"Базовый внешний вид", price:0, type:"outfit" },
  { id:"arctic", name:"Арктический камуфляж", description:"Светлая зимняя экипировка", price:20, type:"outfit" },
  { id:"woodland", name:"Лесной камуфляж", description:"Маскировка для зелёных карт", price:35, type:"outfit" },
  { id:"gold", name:"Золотой декор винтовки", description:"Золотистые детали оружия", price:50, type:"weapon" },
  { id:"redvisor", name:"Красный визор", description:"Яркий визор шлема", price:25, type:"helmet" },
  { id:"tactical_overlay", name:"Тактический OVERLAY", description:"Открывает меню ESP, скелеты, здоровье, ники, оружие, радар и FOV. Доступно каждому игроку навсегда после покупки.", price:5000, type:"feature" }
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
      coins INTEGER NOT NULL DEFAULT 0,
      activity_window_started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      activity_seconds INTEGER NOT NULL DEFAULT 0,
      time_coins INTEGER NOT NULL DEFAULT 0,
      last_activity_at TIMESTAMPTZ,
      kill_progress INTEGER NOT NULL DEFAULT 0,
      kills INTEGER NOT NULL DEFAULT 0,
      equipped_cosmetic TEXT NOT NULL DEFAULT 'standard',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS coins INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS activity_window_started_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
    ALTER TABLE users ADD COLUMN IF NOT EXISTS activity_seconds INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS time_coins INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS last_activity_at TIMESTAMPTZ;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS kill_progress INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS kills INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS equipped_cosmetic TEXT NOT NULL DEFAULT 'standard';
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_cosmetics (
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      item_id TEXT NOT NULL,
      purchased_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY(user_id,item_id)
    )
  `);
}

app.post("/api/dev/verify", auth, (req,res) => {
  if (req.user.nick !== "Panic") return res.status(403).json({error:"Доступ запрещён."});
  const configured=process.env.DEV_OVERLAY_PASSWORD || "";
  const supplied=String(req.body.password || "");
  if(!configured) return res.status(503).json({error:"Пароль разработчика не настроен на сервере."});
  const a=Buffer.from(configured), b=Buffer.from(supplied);
  if(a.length!==b.length || !crypto.timingSafeEqual(a,b)) return res.status(401).json({error:"Неверный пароль разработчика."});
  res.json({ok:true});
});

app.get("/api/status", (req, res) => res.json({ database: !!pool, maps: MAPS }));
app.post("/api/register", async (req, res) => {
  try {
    if (!pool || !SECRET) return res.status(503).json({ error: "Сервер аккаунтов ещё не настроен. Сообщи разработчику." });
    const nick = String(req.body.nick || "").trim();
    const password = String(req.body.password || "");
    if (!/^[\p{L}\p{N}_-]{3,15}$/u.test(nick)) return res.status(400).json({ error: "Ник: 3–15 символов, только буквы, цифры, _ или -." });
    if (nick.toLocaleLowerCase("ru-RU") === "panic" && (nick !== "Panic" || !process.env.DEV_OVERLAY_PASSWORD || password !== process.env.DEV_OVERLAY_PASSWORD)) return res.status(403).json({ error: "Имя Panic зарезервировано для разработчика." });
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
app.get("/api/me", auth, async (req, res) => {
  try {
    const owned = await pool.query("SELECT 1 FROM user_cosmetics WHERE user_id=$1 AND item_id=$2", [req.user.id, "tactical_overlay"]);
    res.json({ user: { id: req.user.id, nick: req.user.nick, devOverlay: !!owned.rowCount } });
  } catch (e) { console.error("profile:", e); res.status(500).json({ error: "Не удалось загрузить профиль." }); }
});

app.get("/api/shop", auth, async (req,res) => {
  try {
    const [u, owned] = await Promise.all([
      pool.query("SELECT coins,equipped_cosmetic FROM users WHERE id=$1",[req.user.id]),
      pool.query("SELECT item_id FROM user_cosmetics WHERE user_id=$1",[req.user.id])
    ]);
    const ownedIds = new Set(["standard",...owned.rows.map(r=>r.item_id)]);
    res.json({ coins:u.rows[0].coins, equipped:u.rows[0].equipped_cosmetic, items:SHOP_ITEMS.map(item=>({...item,owned:ownedIds.has(item.id),equipped:item.type!=="feature" && u.rows[0].equipped_cosmetic===item.id})) });
  } catch(e) { console.error("shop:",e);res.status(500).json({error:"Магазин временно недоступен."}); }
});
app.post("/api/shop/buy", auth, async (req,res) => {
  const item=SHOP_ITEMS.find(x=>x.id===String(req.body.itemId||""));
  if(!item || item.id==="standard") return res.status(400).json({error:"Предмет не найден."});
  const client=await pool.connect();
  try {
    await client.query("BEGIN");
    const owned=await client.query("SELECT 1 FROM user_cosmetics WHERE user_id=$1 AND item_id=$2",[req.user.id,item.id]);
    if(owned.rowCount){await client.query("ROLLBACK");return res.status(409).json({error:"Этот предмет уже куплен."});}
    const debit=await client.query("UPDATE users SET coins=coins-$1 WHERE id=$2 AND coins >= $1 RETURNING coins",[item.price,req.user.id]);
    if(!debit.rowCount){await client.query("ROLLBACK");return res.status(400).json({error:"Недостаточно монет."});}
    await client.query("INSERT INTO user_cosmetics(user_id,item_id) VALUES($1,$2)",[req.user.id,item.id]);
    await client.query("COMMIT");
    res.json({coins:debit.rows[0].coins,itemId:item.id});
  } catch(e){await client.query("ROLLBACK");console.error("buy:",e);res.status(500).json({error:"Покупка не удалась."});}
  finally{client.release();}
});
app.post("/api/shop/equip", auth, async (req,res) => {
  const itemId=String(req.body.itemId||"");
  if(!SHOP_ITEMS.some(x=>x.id===itemId) || SHOP_ITEMS.find(x=>x.id===itemId)?.type==="feature")return res.status(400).json({error:"Этот предмет нельзя экипировать."});
  try{
    if(itemId!=="standard"){
      const owned=await pool.query("SELECT 1 FROM user_cosmetics WHERE user_id=$1 AND item_id=$2",[req.user.id,itemId]);
      if(!owned.rowCount)return res.status(403).json({error:"Сначала купи этот предмет."});
    }
    await pool.query("UPDATE users SET equipped_cosmetic=$1 WHERE id=$2",[itemId,req.user.id]);
    res.json({equipped:itemId});
  }catch(e){console.error("equip:",e);res.status(500).json({error:"Не удалось надеть предмет."});}
});
app.post("/api/activity", auth, async (req,res) => {
  try{
    const result=await pool.query(`
      UPDATE users SET
        activity_window_started_at=CASE WHEN NOW() >= activity_window_started_at + INTERVAL '24 hours' THEN NOW() ELSE activity_window_started_at END,
        activity_seconds=(CASE WHEN NOW() >= activity_window_started_at + INTERVAL '24 hours' THEN 0 ELSE activity_seconds END)
          + LEAST(90,GREATEST(0,COALESCE(EXTRACT(EPOCH FROM (NOW()-last_activity_at)),0)::INTEGER)),
        time_coins=GREATEST(
          CASE WHEN NOW() >= activity_window_started_at + INTERVAL '24 hours' THEN 0 ELSE time_coins END,
          LEAST(28,FLOOR((
            (CASE WHEN NOW() >= activity_window_started_at + INTERVAL '24 hours' THEN 0 ELSE activity_seconds END)
            + LEAST(90,GREATEST(0,COALESCE(EXTRACT(EPOCH FROM (NOW()-last_activity_at)),0)::INTEGER))
          )::NUMERIC/300)::INTEGER)
        ),
        coins=coins+GREATEST(
          0,
          LEAST(28,FLOOR((
            (CASE WHEN NOW() >= activity_window_started_at + INTERVAL '24 hours' THEN 0 ELSE activity_seconds END)
            + LEAST(90,GREATEST(0,COALESCE(EXTRACT(EPOCH FROM (NOW()-last_activity_at)),0)::INTEGER))
          )::NUMERIC/300)::INTEGER)
          - (CASE WHEN NOW() >= activity_window_started_at + INTERVAL '24 hours' THEN 0 ELSE time_coins END)
        ),
        last_activity_at=NOW()
      WHERE id=$1
      RETURNING coins,activity_seconds,time_coins
    `,[req.user.id]);
    const row=result.rows[0];
    res.json({coins:row.coins,nextTimeCoinIn:row.time_coins>=28?0:300-(row.activity_seconds%300),dailyTimeCoins:row.time_coins});
  }catch(e){console.error("activity:",e);res.status(500).json({error:"Не удалось обновить игровое время."});}
});

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


function spawnObstacles(mapId) {
  const boxes=[], circles=[];
  let seed=20261122;
  const rand=()=>{seed=(seed*1664525+1013904223)>>>0;return seed/4294967296;};
  if(mapId==="desert"){
    for(let i=0;i<18;i++){const x=(rand()-.5)*58,z=(rand()-.5)*58;if(Math.abs(x)<8&&Math.abs(z)<8)continue;const sx=1.5+rand()*3,sz=1.5+rand()*3;boxes.push({minX:x-sx/2,maxX:x+sx/2,minZ:z-sz/2,maxZ:z+sz/2});}
    for(let i=-2;i<=2;i++)boxes.push({minX:i*5-1.5,maxX:i*5+1.5,minZ:-14,maxZ:-12},{minX:i*5-1.5,maxX:i*5+1.5,minZ:12,maxZ:14});
    for(let i=0;i<22;i++){const x=(rand()-.5)*60,z=(rand()-.5)*60;if(Math.abs(x)<8&&Math.abs(z)<8)continue;circles.push({x,z,r:.38});}
  }else if(mapId==="forest"){
    for(let i=0;i<34;i++){const x=(rand()-.5)*58,z=(rand()-.5)*58;if(Math.abs(x)<7&&Math.abs(z)<7)continue;circles.push({x,z,r:.34});}
  }else if(mapId==="city"){
    for(let i=0;i<12;i++){const x=(i%4-1.5)*13,z=(Math.floor(i/4)-1)*17;if(Math.abs(x)<7&&Math.abs(z)<7)continue;boxes.push({minX:x-2.5,maxX:x+2.5,minZ:z-2.5,maxZ:z+2.5});}
  }else if(mapId==="snow"){
    for(let i=0;i<14;i++){const x=(i%7-3)*7,z=(Math.floor(i/7)*2-1)*12;boxes.push({minX:x-1.5,maxX:x+1.5,minZ:z-1.1,maxZ:z+1.1});}
  }else if(mapId==="factory"){
    for(let i=0;i<5;i++){const x=(i-2)*10;circles.push({x,z:-15,r:1.15});boxes.push({minX:x-.28,maxX:x+2.28,minZ:9,maxZ:14});}
  }else if(mapId==="mountain"){
    for(let i=0;i<15;i++){const x=(i%5-2)*12,z=(Math.floor(i/5)-1)*17;circles.push({x,z,r:2.8+(i%3)*.3});}
  }
  return {boxes,circles};
}
function chooseSpawn(mapId, roomCode, excludeId) {
  const {boxes,circles}=spawnObstacles(mapId);
  const occupied=[...players.values()].filter(q=>q.room===roomCode&&q.id!==excludeId&&!q.dead);
  const safe=(x,z)=>{
    if(x < -20.4 || x > 20.4 || z < -20.4 || z > 20.4)return false;
    for(const b of boxes){const cx=Math.max(b.minX,Math.min(x,b.maxX)),cz=Math.max(b.minZ,Math.min(z,b.maxZ));if((x-cx)**2+(z-cz)**2<.85**2)return false;}
    for(const c of circles)if(Math.hypot(x-c.x,z-c.z)<c.r+.85)return false;
    for(const p of occupied)if(Math.hypot(x-p.x,z-p.z)<2.5)return false;
    return true;
  };
  for(let i=0;i<250;i++){const x=-19.5+Math.random()*39,z=-19.5+Math.random()*39;if(safe(x,z))return{x,z};}
  for(let radius=2;radius<=19;radius+=1)for(let a=0;a<32;a++){const angle=a*Math.PI/16,x=Math.cos(angle)*radius,z=Math.sin(angle)*radius;if(safe(x,z))return{x,z};}
  return{x:0,z:0};
}

wss.on("connection", ws => {
  const socketId = crypto.randomBytes(8).toString("hex");
  const p = { id: socketId, ws, room: null, user: null, x: 0, z: 0, yaw: 0, hp: 100, score: 0, lastShot: 0, lastMoveAt: 0, dead: false };
  ws.on("message", async raw => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch { return; }
    if (m.type === "join") {
      if (p.room || p.joining) return;
      const user = readToken(m.token);
      if (!pool) return send(ws, { type: "error", message: "База аккаунтов временно недоступна." });
      if (!user) return send(ws, { type: "error", message: "Сначала войди в аккаунт." });
      const room = safeRoom(m.room);
      const roomInfo = rooms.get(room);
      if (!roomInfo) return send(ws, { type: "error", message: "Лобби больше не существует. Обнови список комнат." });
      if (roomInfo.passwordHash && !checkPassword(String(m.password || ""), roomInfo.passwordHash))
        return send(ws, { type: "error", message: "Неверный пароль комнаты." });
      if (roomCount(room) + (roomInfo.pending || 0) >= 15) return send(ws, { type: "error", message: "Лобби заполнено (максимум 15 игроков)." });
      p.joining = true; roomInfo.pending = (roomInfo.pending || 0) + 1;
      let profile;
      try { profile = await pool.query("SELECT equipped_cosmetic FROM users WHERE id=$1",[user.id]); }
      catch(e) { roomInfo.pending--; p.joining=false; console.error("profile:",e); return send(ws,{type:"error",message:"Не удалось загрузить профиль."}); }
      roomInfo.pending--; p.joining = false;
      p.user = { ...user, cosmetic: profile.rows[0]?.equipped_cosmetic || "standard" }; p.room = room; players.set(socketId, p);
      const spawn = chooseSpawn(roomInfo.mapId, room, socketId);
      p.x = spawn.x; p.z = spawn.z; p.yaw = Math.atan2(-p.x, -p.z); p.lastMoveAt = Date.now();
      send(ws, { type: "joined", id: socketId, nick: user.nick, room, roomName: roomInfo.name, mapId: roomInfo.mapId, x: p.x, z: p.z,
        players: [...players.values()].filter(q => q.room === room && q.id !== socketId).map(publicPlayer) });
      broadcast(room, { type: "playerJoined", player: publicPlayer(p) }, ws);
      broadcast(room, { type: "roomCount", count: roomCount(room) });
      return;
    }
    if (!p.room) return;
    if (m.type === "chat") {
      const text = String(m.text || "").replace(/[\\u0000-\\u001f\\u007f]/g, "").trim().slice(0, 160);
      if (!text) return;
      broadcast(p.room, { type: "chatMessage", nick: p.user.nick, text, at: Date.now() });
      return;
    }
    if (m.type === "move") {
      if (p.dead) return;
      const now = Date.now();
      const elapsed = (now - p.lastMoveAt) / 1000;
      if (elapsed < 0.045) return;
      p.lastMoveAt = now;
      const wantedX = Math.max(-21, Math.min(21, Number(m.x) || 0));
      const wantedZ = Math.max(-21, Math.min(21, Number(m.z) || 0));
      const dx = wantedX - p.x, dz = wantedZ - p.z;
      const distance = Math.hypot(dx, dz);
      const maxDistance = 8.5 * Math.min(elapsed, 0.25) + 0.08;
      const scale = distance > maxDistance ? maxDistance / distance : 1;
      p.x = Math.max(-21, Math.min(21, p.x + dx * scale));
      p.z = Math.max(-21, Math.min(21, p.z + dz * scale));
      p.yaw = Number.isFinite(Number(m.yaw)) ? Number(m.yaw) : p.yaw;
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
      pool.query(`
        UPDATE users SET kills=kills+1,kill_progress=(kill_progress+1)%5,
          coins=coins+CASE WHEN kill_progress+1>=5 THEN 1 ELSE 0 END
        WHERE id=$1
      `,[p.user.id]).catch(e=>console.error("kill reward:",e));
      send(target.ws,{type:"hit",hp:0,by:p.id,dead:true});
      broadcast(p.room,{type:"playerDied",id:target.id},target.ws);
      send(ws,{type:"shotResult",hit:true,damage:100,score:p.score});
      const deadRoom=p.room;
      setTimeout(()=>{
        if(!players.has(target.id)||target.room!==deadRoom||!target.dead)return;
        target.dead=false;target.hp=100;
        const spawn=chooseSpawn(rooms.get(deadRoom)?.mapId||"desert",deadRoom,target.id);
        target.x=spawn.x;target.z=spawn.z;target.yaw=Math.atan2(-target.x,-target.z);
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
function publicPlayer(p){return{id:p.id,nick:p.user?.nick||"Игрок",cosmetic:p.user?.cosmetic||"standard",x:p.x,z:p.z,y:p.y||0,yaw:p.yaw,hp:p.hp,score:p.score,dead:p.dead,ready:true};}

const PORT=process.env.PORT||3000;
initDb().then(()=>server.listen(PORT,"0.0.0.0",()=>console.log("Sniper Battle running on port "+PORT)))
  .catch(e=>{console.error("Database initialization failed:",e);process.exit(1);});
