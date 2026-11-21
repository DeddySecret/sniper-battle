import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js";

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x9ab4c1);
scene.fog = new THREE.Fog(0x9ab4c1, 28, 85);
const camera = new THREE.PerspectiveCamera(75, innerWidth/innerHeight, 0.1, 120);
camera.position.set(0, 1.7, 8);
const renderer = new THREE.WebGLRenderer({antialias:true});
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.appendChild(renderer.domElement);

scene.add(new THREE.HemisphereLight(0xddeeff, 0x786044, 2));
const sun = new THREE.DirectionalLight(0xffe2b0, 2.4);
sun.position.set(-12, 25, 10); sun.castShadow = true; scene.add(sun);

const mat = (color, roughness=1) => new THREE.MeshStandardMaterial({color, roughness});
const ground = new THREE.Mesh(new THREE.PlaneGeometry(90,90), mat(0x8b8869));
ground.rotation.x=-Math.PI/2; ground.receiveShadow=true; scene.add(ground);

function box(x,y,z,sx,sy,sz,color){
 const o=new THREE.Mesh(new THREE.BoxGeometry(sx,sy,sz),mat(color));o.position.set(x,y,z);o.castShadow=true;o.receiveShadow=true;scene.add(o);return o;
}
// Deterministic map: both players see exactly the same obstacles.
let seed = 20261122;
function rand(){ seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; }
const solidBoxes = [];
const solidCircles = [];
function addSolidBox(mesh, x,z,sx,sz){
 solidBoxes.push({minX:x-sx/2,maxX:x+sx/2,minZ:z-sz/2,maxZ:z+sz/2});
 return mesh;
}
// Map geometry is created only after the server confirms the selected map.
// Collision test: circle player against solid map props.
function blockedAt(x,z){
 const r=.42;
 if(x < -21+r || x > 21-r || z < -21+r || z > 21-r) return true;
 for(const b of solidBoxes){
  const cx=THREE.MathUtils.clamp(x,b.minX,b.maxX);
  const cz=THREE.MathUtils.clamp(z,b.minZ,b.maxZ);
  if((x-cx)*(x-cx)+(z-cz)*(z-cz)<r*r) return true;
 }
 for(const c of solidCircles) if(Math.hypot(x-c.x,z-c.z)<r+c.r) return true;
 return false;
}

// Detailed anti-materiel sniper rifle inspired by the user's reference image.
const sniper = new THREE.Group();
const gunMat=mat(0x171b1d,.42), metal=mat(0x42494d,.32), polymer=mat(0x24292b,.72), rubber=mat(0x111415,.9);
function gunPart(geo, material, x,y,z, rx=0,ry=0,rz=0){
 const m=new THREE.Mesh(geo,material);m.position.set(x,y,z);m.rotation.set(rx,ry,rz);m.castShadow=true;sniper.add(m);return m;
}
// Long barrel and muzzle
gunPart(new THREE.CylinderGeometry(.027,.038,1.55,12),metal,0,.005,-.98,Math.PI/2);
gunPart(new THREE.CylinderGeometry(.045,.045,.12,12),gunMat,0,.005,-1.77,Math.PI/2);
// Perforated handguard with visible vent holes along both sides
gunPart(new THREE.BoxGeometry(.19,.19,.92),gunMat,0,.005,-.83);
gunPart(new THREE.BoxGeometry(.205,.205,.95),metal,0,.005,-.83);
for(let i=0;i<8;i++){
 const z=-1.22+i*.11;
 gunPart(new THREE.CylinderGeometry(.022,.022,.012,10),rubber,-.106,.008,z,0,0,Math.PI/2);
 gunPart(new THREE.CylinderGeometry(.022,.022,.012,10),rubber,.106,.008,z,0,0,Math.PI/2);
}
// Receiver, magazine, pistol grip, rear stock and cheek rest
gunPart(new THREE.BoxGeometry(.23,.22,.62),gunMat,0,-.045,-.12);
gunPart(new THREE.BoxGeometry(.17,.31,.26),polymer,0,-.285,-.12);
gunPart(new THREE.BoxGeometry(.13,.22,.23),rubber,0,-.24,.03,-.25);
gunPart(new THREE.BoxGeometry(.17,.16,.55),polymer,0,-.055,.42);
gunPart(new THREE.BoxGeometry(.15,.11,.38),rubber,0,.025,.55);
gunPart(new THREE.BoxGeometry(.20,.06,.18),gunMat,0,.08,.27);
// Top Picatinny rail and scope mounts
gunPart(new THREE.BoxGeometry(.12,.035,1.18),metal,0,.14,-.55);
for(let i=0;i<15;i++) gunPart(new THREE.BoxGeometry(.14,.025,.035),gunMat,0,.165,-1.08+i*.075);
// Large optical scope with turrets
gunPart(new THREE.CylinderGeometry(.075,.075,.48,16),gunMat,0,.29,-.45,Math.PI/2);
gunPart(new THREE.CylinderGeometry(.095,.095,.08,16),metal,0,.29,-.68,Math.PI/2);
gunPart(new THREE.CylinderGeometry(.09,.09,.08,16),metal,0,.29,-.22,Math.PI/2);
gunPart(new THREE.CylinderGeometry(.045,.045,.12,12),gunMat,0,.39,-.45,0,0,Math.PI/2);
gunPart(new THREE.CylinderGeometry(.035,.035,.11,12),gunMat,0,.29,-.45,0,0,Math.PI/2);
// Bipod legs and feet under the forward handguard
for(const side of [-1,1]){
 const leg=gunPart(new THREE.CylinderGeometry(.018,.025,.48,8),metal,side*.13,-.27,-.78,0,0,side*.24);
 gunPart(new THREE.BoxGeometry(.10,.035,.07),rubber,side*.19,-.51,-.78);
}
camera.add(sniper);sniper.position.set(.34,-.28,-.58);scene.add(camera);


// Account and lobby flow: no gameplay socket exists until the player is authenticated and joins a lobby.
let authToken = localStorage.getItem("sniperBattleToken") || "";
let currentUser = null;
let selectedRoom = null;
let selectedRoomPassword = "";
let selectedMap = "desert";
const $ = id => document.getElementById(id);
async function api(path, body) {
 const response = await fetch(path, { method: body ? "POST" : "GET", headers: { "Content-Type":"application/json", ...(authToken ? { Authorization:"Bearer "+authToken } : {}) }, body: body ? JSON.stringify(body) : undefined });
 const data = await response.json().catch(()=>({error:"Ошибка сервера"}));
 if (!response.ok) throw new Error(data.error || "Ошибка запроса");
 return data;
}
function showAuth(){ $("authPanel").style.display="grid"; $("lobbyPanel").style.display="none"; $("shopPanel").style.display="none"; }
let activityTimer=null;
async function pulseActivity(){try{await api("/api/activity");}catch(e){console.warn("activity update:",e.message);}}
function startActivity(){if(activityTimer)clearInterval(activityTimer);pulseActivity();activityTimer=setInterval(pulseActivity,60000);}
function showLobby(){ devUnlocked=!!currentUser?.devOverlay; $("authPanel").style.display="none"; $("shopPanel").style.display="none"; $("lobbyPanel").style.display="grid"; $("welcomeText").textContent="Игрок: "+currentUser.nick; loadRooms();startActivity(); }
async function openShop(){
 try{
  const data=await api("/api/shop");$("shopCoins").textContent=data.coins;$("shopItems").innerHTML="";
  for(const item of data.items){
   const card=document.createElement("div");card.className="shopItem";
   const title=document.createElement("b");title.textContent=item.name;
   const desc=document.createElement("small");desc.textContent=item.description;
   const price=document.createElement("span");price.textContent=item.price===0?"Бесплатно":item.price+" монет";
   const action=document.createElement("button");action.className=item.owned?"secondary":"";
   const feature=item.type==="feature";
   action.textContent=feature?(item.owned?"КУПЛЕНО":"КУПИТЬ ЗА 5000"):item.equipped?"НАДЕТО":item.owned?"НАДЕТЬ":"КУПИТЬ";
   action.disabled=feature?!!item.owned:!!item.equipped;
   action.onclick=async()=>{
    try{
     if(!item.owned){
      const bought=await api("/api/shop/buy",{itemId:item.id});$("shopCoins").textContent=bought.coins;
      if(feature){currentUser.devOverlay=true;devUnlocked=true;}
     }
     if(!feature)await api("/api/shop/equip",{itemId:item.id});
     await openShop();$("shopStatus").textContent=feature?"Тактический OVERLAY разблокирован навсегда. Нажми Right Shift в игре.":"Предмет успешно экипирован.";
    }catch(e){$("shopStatus").textContent=e.message;}
   };
   card.append(title,desc,price,action);$("shopItems").append(card);
  }
  $("lobbyPanel").style.display="none";$("authPanel").style.display="none";$("shopPanel").style.display="grid";
 }catch(e){$("lobbyStatus").textContent=e.message;}
}
$("shopOpenButton").onclick=openShop;
$("shopCloseButton").onclick=()=>{$("shopPanel").style.display="none";$("lobbyPanel").style.display="grid";};

async function authenticate(mode){
 const nick=$("authNick").value.trim(), password=$("authPassword").value;
 $("authStatus").textContent="Подожди...";
 try{
  const data=await api("/api/"+mode,{nick,password}); authToken=data.token;currentUser=data.user;
  localStorage.setItem("sniperBattleToken",authToken);const profile=await api("/api/me");currentUser=profile.user;showLobby();$("authPassword").value="";
 }catch(e){$("authStatus").textContent=e.message;}
}
$("loginButton").onclick=()=>authenticate("login");
$("registerButton").onclick=()=>authenticate("register");
$("authPassword").addEventListener("keydown",e=>{if(e.key==="Enter")authenticate("login");});
$("logoutButton").onclick=()=>{authToken="";currentUser=null;localStorage.removeItem("sniperBattleToken");if(ws)ws.close();joined=false;if(activityTimer)clearInterval(activityTimer);showAuth();};
async function loadRooms(){
 try{
  const data=await api("/api/rooms");
  $("roomList").innerHTML="";
  if(!data.rooms.length){$("roomList").textContent="Пока нет открытых лобби. Создай своё!";return;}
  for(const r of data.rooms){
   const row=document.createElement("div");row.className="roomEntry";
   const info=document.createElement("span");info.textContent=r.name+" · "+r.mapName+" · "+r.count+"/15"+(r.private?" · 🔒":"");
   const btn=document.createElement("button");btn.className="secondary";btn.textContent="ВЫБРАТЬ";
   btn.onclick=()=>{$("roomCode").value=r.code;$("joinRoomPassword").focus();};
   row.append(info,btn);$("roomList").append(row);
  }
 }catch(e){$("roomList").textContent=e.message;}
}
$("refreshRoomsButton").onclick=loadRooms;
$("createRoomButton").onclick=async()=>{
 try{const data=await api("/api/rooms/create",{name:$("roomName").value,mapId:$("mapSelect").value,password:$("createRoomPassword").value});
  selectedRoom=data.room.code;selectedMap=data.room.mapId;selectedRoomPassword=$("createRoomPassword").value;beginGame();}catch(e){$("lobbyStatus").textContent=e.message;}
};
$("joinRoomButton").onclick=async()=>{
 try{const data=await api("/api/rooms/join",{code:$("roomCode").value,password:$("joinRoomPassword").value});
  selectedRoom=data.room.code;selectedMap=data.room.mapId;selectedRoomPassword=$("joinRoomPassword").value;beginGame();}catch(e){$("lobbyStatus").textContent=e.message;}
};
async function beginGame(){
 $("lobbyPanel").style.display="none";joinPanel.style.display="none";
 document.body.requestPointerLock?.();
 connect();
}
(async()=>{
 if(!authToken){showAuth();return;}
 try{const data=await api("/api/me");currentUser=data.user;showLobby();}
 catch{authToken="";localStorage.removeItem("sniperBattleToken");showAuth();}
})();

const players = new Map();
let myId=null, room=null, ws=null, joined=false, hp=100, ammo=5, scoped=false, reloading=false, dead=false, myScore=0;
let yaw=0,pitch=0, lastSend=0, shotCooldown=0;
const keys={};
let playerHeight=0, verticalVelocity=0;
let devUnlocked=false;
const devState={esp:false,skeleton:false,health:false,names:true,weapon:true,radar:false,fov:false};
let audioContext=null;
let soundEnabled=localStorage.getItem("sniperSoundEnabled")!=="false";
let soundVolume=Number(localStorage.getItem("sniperSoundVolume")||65)/100;
let invertMouse=localStorage.getItem("sniperInvertMouse")==="true";
function playSound(freq=110,duration=.12,type="sawtooth"){
 if(!soundEnabled||soundVolume<=0)return;
 try{
  audioContext ||= new (window.AudioContext||window.webkitAudioContext)();
  if(audioContext.state==="suspended")audioContext.resume();
  const osc=audioContext.createOscillator(),gain=audioContext.createGain();
  osc.type=type;osc.frequency.setValueAtTime(freq,audioContext.currentTime);
  osc.frequency.exponentialRampToValueAtTime(Math.max(25,freq*.35),audioContext.currentTime+duration);
  gain.gain.setValueAtTime(.0001,audioContext.currentTime);
  gain.gain.exponentialRampToValueAtTime(.18*soundVolume,audioContext.currentTime+.008);
  gain.gain.exponentialRampToValueAtTime(.0001,audioContext.currentTime+duration);
  osc.connect(gain);gain.connect(audioContext.destination);osc.start();osc.stop(audioContext.currentTime+duration);
 }catch{}
}
function openSettings(){if(!currentUser)return;$("settingsPanel").style.display="grid";if(document.pointerLockElement)document.exitPointerLock();}
function openDevPanel(){
 if(!devUnlocked){message.textContent="Купи ТАКТИЧЕСКИЙ OVERLAY в магазине за 5000 монет";setTimeout(()=>message.textContent="",2200);return;}
 $("devPanel").style.display="grid";$("devLogin").style.display="none";$("devControls").style.display="block";
 if(document.pointerLockElement)document.exitPointerLock();
}
$("devCloseButton").onclick=()=>{$("devPanel").style.display="none";if(joined&&!dead)renderer.domElement.requestPointerLock();};
function setDev(key,value){
 if(!devUnlocked)return;devState[key]=value;
 if(key==="weapon")sniper.visible=value;
 if(key==="fov")$("devFovCircle").style.display=value?"block":"none";
 if(key==="radar")$("devRadarCanvas").style.display=value?"block":"none";
 for(const g of players.values()){
  if(g.userData.nameSprite&&key==="names")g.userData.nameSprite.visible=value;
  if(g.userData.espBox&&key==="esp")g.userData.espBox.visible=value;
  if(g.userData.skeleton&&key==="skeleton")g.userData.skeleton.visible=value;
  if(g.userData.healthBar&&key==="health")g.userData.healthBar.visible=value;
 }
}
for(const key of ["esp","skeleton","health","names","weapon","radar","fov"]){
 const input=$("dev"+key.charAt(0).toUpperCase()+key.slice(1));
 input.onchange=()=>setDev(key,input.checked);
}

function leaveLobby(){
 if(document.pointerLockElement)document.exitPointerLock();
 setScoped(false);joined=false;dead=false;selectedRoom=null;selectedRoomPassword="";
 if(ws){const old=ws;ws=null;old.close();}
 for(const [id,g] of players){scene.remove(g);players.delete(id);}
 $("playerList").style.display="none";$("devPanel").style.display="none";$("settingsPanel").style.display="none";
 $("shopPanel").style.display="none";$("chatBox").style.display="none";$("deathScreen").style.display="none";
 $("lobbyPanel").style.display="grid";$("lobbyStatus").textContent="Ты вышел из лобби.";
 message.textContent="";loadRooms();
}
$("leaveLobbyButton").onclick=leaveLobby;

function closeSettings(){$("settingsPanel").style.display="none";if(joined&&!dead)renderer.domElement.requestPointerLock();}
$("settingsCloseButton").onclick=closeSettings;
$("volumeSlider").value=Math.round(soundVolume*100);$("soundToggle").checked=soundEnabled;$("invertToggle").checked=invertMouse;
$("volumeSlider").oninput=e=>{soundVolume=Number(e.target.value)/100;localStorage.setItem("sniperSoundVolume",String(e.target.value));};
$("soundToggle").onchange=e=>{soundEnabled=e.target.checked;localStorage.setItem("sniperSoundEnabled",String(soundEnabled));};
$("invertToggle").onchange=e=>{invertMouse=e.target.checked;localStorage.setItem("sniperInvertMouse",String(invertMouse));};
function applyMapTheme(id){
 const themes={desert:{sky:0x9ab4c1,fog:0x9ab4c1,ground:0x8b8869},forest:{sky:0x78968a,fog:0x78968a,ground:0x53684b},city:{sky:0x87919c,fog:0x87919c,ground:0x62666a},snow:{sky:0xc6d8e6,fog:0xc6d8e6,ground:0xd8e2e8},factory:{sky:0x747b80,fog:0x747b80,ground:0x555b5d},mountain:{sky:0x91a5b8,fog:0x91a5b8,ground:0x77766f}};
 const t=themes[id]||themes.desert;scene.background.setHex(t.sky);scene.fog.color.setHex(t.fog);ground.material.color.setHex(t.ground);
 const extra=new THREE.Group();scene.add(extra);
 seed=20261122; solidBoxes.length=0; solidCircles.length=0;
 const put=(geo,color,x,y,z)=>{const o=new THREE.Mesh(geo,mat(color));o.position.set(x,y,z);o.castShadow=true;o.receiveShadow=true;extra.add(o);return o;};
 if(id==="desert"){
  for(let i=0;i<18;i++){const x=(rand()-.5)*58,z=(rand()-.5)*58;if(Math.abs(x)<8&&Math.abs(z)<8)continue;const sx=1.5+rand()*3,sy=1.4+rand()*2,sz=1.5+rand()*3;put(new THREE.BoxGeometry(sx,sy,sz),[0x77786b,0x8a806d,0x6d746b][i%3],x,sy/2,z);solidBoxes.push({minX:x-sx/2,maxX:x+sx/2,minZ:z-sz/2,maxZ:z+sz/2});}
  for(let i=-2;i<=2;i++){put(new THREE.BoxGeometry(3,2,2),0x74796f,i*5,1,-13);put(new THREE.BoxGeometry(3,2,2),0x74796f,i*5,1,13);solidBoxes.push({minX:i*5-1.5,maxX:i*5+1.5,minZ:-14,maxZ:-12},{minX:i*5-1.5,maxX:i*5+1.5,minZ:12,maxZ:14});}
  for(let i=0;i<22;i++){const x=(rand()-.5)*60,z=(rand()-.5)*60;if(Math.abs(x)<8&&Math.abs(z)<8)continue;put(new THREE.CylinderGeometry(.16,.22,1.2,8),0x574331,x,.6,z);put(new THREE.ConeGeometry(1,2.5,8),0x53634b,x,2.1,z);solidCircles.push({x,z,r:.38});}
 }else if(id==="forest"){
  for(let i=0;i<34;i++){const x=(rand()-.5)*58,z=(rand()-.5)*58;if(Math.abs(x)<7&&Math.abs(z)<7)continue;put(new THREE.CylinderGeometry(.18,.28,2.2,7),0x493b2d,x,1.1,z);put(new THREE.ConeGeometry(1.45,3.6,7),0x294b35,x,3.7,z);solidCircles.push({x,z,r:.34});}
 }else if(id==="city"){
  for(let i=0;i<12;i++){const x=(i%4-1.5)*13,z=(Math.floor(i/4)-1)*17;if(Math.abs(x)<7&&Math.abs(z)<7)continue;const h=4+(i%3)*2;put(new THREE.BoxGeometry(5,h,5),[0x555d67,0x74716c,0x4d5960][i%3],x,h/2,z);solidBoxes.push({minX:x-2.5,maxX:x+2.5,minZ:z-2.5,maxZ:z+2.5});for(let y=1;y<h;y+=1.5)put(new THREE.BoxGeometry(3,.07,.04),0xb6a16d,x,y,z-2.53);}
 }else if(id==="snow"){
  for(let i=0;i<14;i++){const x=(i%7-3)*7,z=(Math.floor(i/7)*2-1)*12;put(new THREE.BoxGeometry(3,1.8,2.2),0xd9e7ee,x,.9,z);put(new THREE.ConeGeometry(1.5,2.8,5),0x91adbd,x,2.7,z);solidBoxes.push({minX:x-1.5,maxX:x+1.5,minZ:z-1.1,maxZ:z+1.1});}
 }else if(id==="factory"){
  for(let i=0;i<5;i++){const x=(i-2)*10;put(new THREE.CylinderGeometry(1.15,1.15,6,12),0x596166,x,3,-15);put(new THREE.CylinderGeometry(.18,.28,9,10),0x343d42,x+2,4.5,12);put(new THREE.BoxGeometry(5,2,4),0x59615f,x,1,12);solidCircles.push({x,z:-15,r:1.15});solidBoxes.push({minX:x-.28,maxX:x+2.28,minZ:9,maxZ:14});}
 }else if(id==="mountain"){
  for(let i=0;i<15;i++){const x=(i%5-2)*12,z=(Math.floor(i/5)-1)*17;put(new THREE.ConeGeometry(4+(i%3),5+(i%4),6),0x777b7b,x,2.5,z);put(new THREE.ConeGeometry(2.4,3,6),0xdce4e8,x,5.2+(i%4)*.35,z);solidCircles.push({x,z,r:2.8+(i%3)*.3});}
 }else{
  for(let i=0;i<10;i++){const x=(i%5-2)*11,z=(Math.floor(i/5)-.5)*20;put(new THREE.BoxGeometry(4,1.5,3),0xb49a70,x,.75,z);solidBoxes.push({minX:x-2,maxX:x+2,minZ:z-1.5,maxZ:z+1.5});}
 }
}
const message=document.getElementById("message");
const health=document.getElementById("health");
const ammoLabel=document.getElementById("ammo");
const playersLabel=document.getElementById("playersLabel");
const scope=document.getElementById("scope");
const joinPanel=document.getElementById("joinPanel");

function makeOpponent(id,nick="Игрок",cosmetic="standard"){
 const g=new THREE.Group();
 const uniform=mat(0x465342,.92), dark=mat(0x202a25,.85), vestMat=mat(0x303b35,.8);
 const skin=mat(0xb98768,.9), fabric=mat(cosmetic==="arctic"?0xd7e1e4:cosmetic==="woodland"?0x354b36:0x59624b,.95), metalMat=mat(cosmetic==="gold"?0xb78a32:0x252d30,.45);
 const addMesh=(parent,geo,material,x,y,z,rx=0,ry=0,rz=0)=>{
  const m=new THREE.Mesh(geo,material);m.position.set(x,y,z);m.rotation.set(rx,ry,rz);
  m.castShadow=true;m.receiveShadow=true;parent.add(m);return m;
 };
 // boots and articulated legs
 const leftLeg=new THREE.Group();leftLeg.position.set(-.19,.83,0);g.add(leftLeg);
 const rightLeg=new THREE.Group();rightLeg.position.set(.19,.83,0);g.add(rightLeg);
 for(const [leg,side] of [[leftLeg,-1],[rightLeg,1]]){
  addMesh(leg,new THREE.CapsuleGeometry(.105,.48,4,8),uniform,0,-.25,0);
  addMesh(leg,new THREE.BoxGeometry(.22,.12,.34),dark,0,-.56,-.055);
  addMesh(leg,new THREE.BoxGeometry(.23,.18,.23),fabric,0,-.12,-.015);
  addMesh(leg,new THREE.BoxGeometry(.20,.12,.12),dark,0,-.36,-.015);
 }
 // torso with layered plate carrier
 const torso=addMesh(g,new THREE.CapsuleGeometry(.31,.62,5,10),uniform,0,1.28,0);
 addMesh(g,new THREE.BoxGeometry(.55,.62,.27),vestMat,0,1.34,-.015);
 addMesh(g,new THREE.BoxGeometry(.42,.10,.29),dark,0,1.66,-.01);
 // armor plates, pouches, straps and backpack
 addMesh(g,new THREE.BoxGeometry(.34,.35,.045),fabric,0,1.38,-.17);
 for(let i=0;i<3;i++) addMesh(g,new THREE.BoxGeometry(.105,.13,.09),dark,-.15+i*.15,1.13,-.20);
 addMesh(g,new THREE.BoxGeometry(.32,.48,.18),dark,0,1.38,.22);
 addMesh(g,new THREE.BoxGeometry(.12,.42,.055),fabric,-.18,1.35,.02,0,0,-.18);
 addMesh(g,new THREE.BoxGeometry(.12,.42,.055),fabric,.18,1.35,.02,0,0,.18);
 // neck, head, helmet, goggles and headset
 addMesh(g,new THREE.CylinderGeometry(.09,.11,.16,10),skin,0,1.78,0);
 addMesh(g,new THREE.SphereGeometry(.205,16,12),skin,0,2.00,0);
 addMesh(g,new THREE.SphereGeometry(.225,16,10,0,Math.PI*2,0,Math.PI*.58),fabric,0,2.08,0);
 addMesh(g,new THREE.BoxGeometry(.22,.065,.045),dark,0,2.035,-.19);
 addMesh(g,new THREE.BoxGeometry(.085,.055,.025),metalMat,-.055,2.04,-.218);
 addMesh(g,new THREE.BoxGeometry(.085,.055,.025),metalMat,.055,2.04,-.218);
 addMesh(g,new THREE.CylinderGeometry(.045,.045,.08,8),dark,-.215,1.99,0,0,0,Math.PI/2);
 // arms with shoulder pads and forearms
 const leftArm=new THREE.Group();leftArm.position.set(-.39,1.55,0);g.add(leftArm);
 const rightArm=new THREE.Group();rightArm.position.set(.39,1.55,0);g.add(rightArm);
 for(const [arm,side] of [[leftArm,-1],[rightArm,1]]){
  addMesh(arm,new THREE.SphereGeometry(.16,10,8),uniform,0,-.04,0);
  addMesh(arm,new THREE.CapsuleGeometry(.105,.38,4,8),uniform,0,-.29,-.015,0,0,side*.08);
  addMesh(arm,new THREE.BoxGeometry(.22,.16,.20),fabric,0,-.09,-.005);
  addMesh(arm,new THREE.CapsuleGeometry(.085,.28,4,8),dark,0,-.57,-.035);
  addMesh(arm,new THREE.SphereGeometry(.09,10,8),skin,0,-.76,-.05);
 }
 // visible slung rifle across chest
 const rifle=new THREE.Group();rifle.position.set(.24,1.22,-.24);rifle.rotation.z=-.22;g.add(rifle);
 addMesh(rifle,new THREE.BoxGeometry(.09,.10,.62),metalMat,0,0,0);
 addMesh(rifle,new THREE.CylinderGeometry(.018,.018,.48,8),metalMat,0,.01,-.40,Math.PI/2);
 addMesh(rifle,new THREE.BoxGeometry(.075,.12,.20),dark,0,-.01,.38);
 // small shoulder insignia
 addMesh(g,new THREE.BoxGeometry(.13,.10,.025),mat(0x8d9a78),-.34,1.53,-.04);
 g.position.set(0,0,0);
 const labelCanvas=document.createElement("canvas");labelCanvas.width=512;labelCanvas.height=96;
 const labelCtx=labelCanvas.getContext("2d");labelCtx.fillStyle="rgba(4,10,14,.72)";labelCtx.fillRect(4,8,504,80);
 labelCtx.font="bold 38px Arial";labelCtx.textAlign="center";labelCtx.textBaseline="middle";labelCtx.fillStyle="#ffffff";labelCtx.fillText(String(nick).slice(0,15),256,48);
 const labelTexture=new THREE.CanvasTexture(labelCanvas);const label=new THREE.Sprite(new THREE.SpriteMaterial({map:labelTexture,transparent:true,depthTest:false}));
 label.position.set(0,2.92,0);label.scale.set(2.5,.48,1);label.visible=devState.names;g.add(label);
 const healthBar=new THREE.Group();healthBar.position.set(0,2.58,0);
 const hpBack=new THREE.Mesh(new THREE.PlaneGeometry(.9,.09),mat(0x3b1717));healthBar.add(hpBack);
 const hpFill=new THREE.Mesh(new THREE.PlaneGeometry(.86,.055),mat(0x40d66c));hpFill.position.z=.006;healthBar.add(hpFill);healthBar.userData.fill=hpFill;healthBar.visible=devState.health;g.add(healthBar);
 const bonePoints=[
  [0,2.0,0,0,1.72,0], [0,1.72,0,-.22,1.52,0], [0,1.72,0,.22,1.52,0],
  [-.22,1.52,0,-.43,1.27,0], [.22,1.52,0,.43,1.27,0],
  [0,1.72,0,0,1.25,0], [0,1.25,0,0,.88,0],
  [0,.88,0,-.19,.58,0], [0,.88,0,.19,.58,0],
  [-.19,.58,0,-.19,.25,-.05], [.19,.58,0,.19,.25,-.05]
 ].flat();
 const skGeo=new THREE.BufferGeometry();skGeo.setAttribute("position",new THREE.Float32BufferAttribute(bonePoints,3));
 const skeleton=new THREE.LineSegments(skGeo,new THREE.LineBasicMaterial({color:0x42ff82,depthTest:false}));skeleton.visible=devState.skeleton;g.add(skeleton);
 scene.add(g);
 const espBox=new THREE.BoxHelper(g,0xff3939);espBox.visible=devState.esp;scene.add(espBox);
 g.userData={leftLeg,rightLeg,leftArm,rightArm,nick:String(nick),score:0,nameSprite:label,healthBar,healthFill:hpFill,skeleton,espBox,health:100,baseY:0,phase:Math.random()*Math.PI*2,
  targetX:0,targetZ:0,targetY:0,targetYaw:0,lastX:0,lastZ:0,moving:false,dead:false};
 players.set(id,g);return g;
}

function appendChat(nick,text){
 const box=$("chatMessages"),line=document.createElement("div"),name=document.createElement("b"),body=document.createElement("span");
 name.textContent=nick+": ";body.textContent=text;line.append(name,body);box.append(line);
 while(box.children.length>40)box.firstElementChild.remove();
 box.scrollTop=box.scrollHeight;
}
function openChat(){
 if(!joined)return;
 $("chatBox").style.display="block";
 if(document.pointerLockElement)document.exitPointerLock();
 $("chatInput").focus();
}
function closeChat(){
 $("chatBox").style.display="none";
 $("chatInput").value="";
 if(joined&&!dead)renderer.domElement.requestPointerLock();
}
$("chatInput").addEventListener("keydown",e=>{
 if(e.code==="Enter"){
  const text=$("chatInput").value.trim();
  if(text&&ws?.readyState===WebSocket.OPEN)ws.send(JSON.stringify({type:"chat",text}));
  $("chatInput").value="";e.preventDefault();
 }else if(e.code==="Escape"){e.preventDefault();closeChat();}
});

function connect(){
 room=selectedRoom;
 if(!authToken||!room)return;
 $("roomLabel").textContent="ЛОББИ "+room;
 ws=new WebSocket((location.protocol==="https:"?"wss://":"ws://")+location.host);
 ws.onopen=()=>ws.send(JSON.stringify({type:"join",room,token:authToken,password:selectedRoomPassword}));
 ws.onmessage=e=>{
  const m=JSON.parse(e.data);
  if(m.type==="joined"){
   myId=m.id;joined=true;camera.position.set(m.x ?? 0,1.7,m.z ?? 8);joinPanel.style.display="none"; $("roomLabel").textContent=m.roomName+" · "+m.room; applyMapTheme(m.mapId);
   document.getElementById("roomLabel").textContent="КОМНАТА "+m.room;
   m.players.forEach(p=>{const g=makeOpponent(p.id,p.nick,p.cosmetic);g.position.set(p.x,0,p.z);
    g.userData.targetX=p.x;g.userData.targetZ=p.z;g.userData.targetY=p.y||0;g.userData.targetYaw=p.yaw||0;g.userData.health=p.hp??100;g.userData.score=p.score??0;
    if(p.dead)g.visible=false;});
   updateCount();message.textContent="Лобби открыто · "+currentUser.nick;
   document.body.requestPointerLock?.();
  } else if(m.type==="error"){message.textContent=m.message;joined=false;if(document.pointerLockElement)document.exitPointerLock();$("lobbyStatus").textContent=m.message;$("lobbyPanel").style.display="grid";if(ws)ws.close();}
  else if(m.type==="playerJoined"){
   const g=makeOpponent(m.player.id,m.player.nick,m.player.cosmetic);g.position.set(m.player.x,0,m.player.z);
   g.userData.targetX=m.player.x;g.userData.targetZ=m.player.z;g.userData.targetY=m.player.y||0;g.userData.targetYaw=m.player.yaw||0;g.userData.health=m.player.hp??100;
   message.textContent="Противник подключился!";setTimeout(()=>message.textContent="",1800);updateCount();
  } else if(m.type==="playerMoved"){
   let g=players.get(m.player.id);if(!g)g=makeOpponent(m.player.id);
   g.userData.targetX=m.player.x;g.userData.targetZ=m.player.z;g.userData.targetY=m.player.y||0;g.userData.targetYaw=m.player.yaw;g.userData.health=m.player.hp??g.userData.health;
   g.userData.dead=!!m.player.dead;
   g.visible=!g.userData.dead;
  } else if(m.type==="playerLeft"){
   const g=players.get(m.id);if(g)scene.remove(g);players.delete(m.id);updateCount();message.textContent="Противник отключился";
  } else if(m.type==="roomCount"){updateCount(m.count);}
  else if(m.type==="hit"){
   hp=m.hp;health.textContent="❤ "+hp;
   if(hp<=0){dead=true;playSound(55,.35,"triangle");document.getElementById("deathScreen").style.display="grid";setScoped(false);}
  }
  else if(m.type==="respawn"){
   dead=false;hp=100;health.textContent="❤ 100";
   camera.position.set(m.x,1.7,m.z);yaw=m.yaw||0;camera.rotation.set(pitch,yaw,0,"YXZ");
   document.getElementById("deathScreen").style.display="none";
   message.textContent="ВОЗРОЖДЕНИЕ";setTimeout(()=>message.textContent="",900);
  }
  else if(m.type==="playerDied"){
   const g=players.get(m.id);if(g){g.visible=false;g.userData.dead=true;}
  }
  else if(m.type==="playerRespawned"){
   let g=players.get(m.player.id);if(!g)g=makeOpponent(m.player.id);
   g.visible=true;g.userData.dead=false;g.position.set(m.player.x,0,m.player.z);
   g.userData.targetX=m.player.x;g.userData.targetZ=m.player.z;g.userData.targetYaw=m.player.yaw||0;
  }
  else if(m.type==="shotResult"){if(m.hit)playSound(520,.1,"sine");message.textContent=m.hit?"ПОПАДАНИЕ!":"ПРОМАХ";setTimeout(()=>message.textContent="",700);}
  else if(m.type==="score"){for(const item of m.scores){const g=players.get(item.id);if(g&&g.userData)g.userData.score=item.score;}const mine=m.scores.find(s=>s.id===myId);if(mine){myScore=mine.score;message.textContent="ТВОИ УБИЙСТВА: "+mine.score;}refreshPlayerList();}
 };
 ws.onclose=()=>{const wasJoined=joined;joined=false;$("playerList").style.display="none";if(wasJoined&&currentUser){$("lobbyStatus").textContent="Соединение потеряно. Попробуй войти снова.";$("lobbyPanel").style.display="grid";}message.textContent="Соединение потеряно";};
}
function refreshPlayerList(){
 const rows=$("playerRows");if(!rows)return;rows.innerHTML="";
 const entries=[{nick:currentUser?.nick||"Ты",score:myScore,mine:true},...Array.from(players.values()).map(g=>({nick:g.userData?.nick||"Игрок",score:g.userData?.score||0,mine:false}))];
 entries.sort((a,b)=>b.score-a.score);
 for(const p of entries){const row=document.createElement("div");row.className="playerRow"+(p.mine?" mine":"");const name=document.createElement("span");name.textContent=(p.mine?"★ ":"")+p.nick;const score=document.createElement("b");score.textContent=String(p.score);row.append(name,score);rows.append(row);}
}
function updateCount(n){playersLabel.textContent="ИГРОКИ "+(n??(players.size+1))+"/15";$("playerList").style.display=joined?"block":"none";refreshPlayerList();}


document.addEventListener("mousemove",e=>{
 if(!joined||document.pointerLockElement!==renderer.domElement)return;
 yaw-=e.movementX*.0022;pitch-=(invertMouse?-1:1)*e.movementY*.0022;
 pitch=Math.max(-1.25,Math.min(1.25,pitch));
 camera.rotation.set(pitch,yaw,0,"YXZ");
});
document.addEventListener("keydown",e=>{
 if(e.target===$("chatInput"))return;
 if(e.code==="KeyT"&&joined){e.preventDefault();openChat();return;}
 if(e.code==="RightShift"&&currentUser){e.preventDefault();openDevPanel();return;}
 if(e.code==="Escape"&&currentUser){e.preventDefault();if($("chatBox").style.display==="block"){closeChat();return;}if($("devPanel").style.display==="grid"){$("devPanel").style.display="none";}else if($("settingsPanel").style.display==="grid")closeSettings();else if($("shopPanel").style.display==="grid"){$("shopPanel").style.display="none";if(joined){$("lobbyPanel").style.display="none";}else{$("lobbyPanel").style.display="grid";}}else openSettings();return;}
 keys[e.code]=true;
 if(e.code==="KeyR")reload();
});
document.addEventListener("keyup",e=>keys[e.code]=false);
document.addEventListener("contextmenu",e=>e.preventDefault());
function setScoped(value){
 scoped=!!value;
 scope.style.display=scoped?"block":"none";
 document.getElementById("crosshair").style.display=scoped?"none":"block";
 camera.fov=scoped?22:75;
 camera.updateProjectionMatrix();
}
document.addEventListener("mousedown",e=>{
 if(!joined)return;
 if(document.pointerLockElement!==renderer.domElement){renderer.domElement.requestPointerLock();return;}
 if(e.button===2)setScoped(true);
 if(e.button===0)shoot();
});
document.addEventListener("mouseup",e=>{if(e.button===2)setScoped(false);});
window.addEventListener("blur",()=>setScoped(false));
document.addEventListener("pointerlockchange",()=>{
 if(document.pointerLockElement!==renderer.domElement && joined){setScoped(false);message.textContent="Нажми по игре, чтобы продолжить";}
 else if(joined)message.textContent="";
});
function reload(){
 if(reloading||ammo===5)return;
 reloading=true;message.textContent="ПЕРЕЗАРЯДКА...";
 setTimeout(()=>{ammo=5;reloading=false;ammoLabel.textContent="▣ 5 / 5";message.textContent="";},1400);
}
const raycaster=new THREE.Raycaster();
function shoot(){
 if(dead||!joined||ammo<=0||reloading||performance.now()-shotCooldown<850)return;
 playSound(95,.18,"sawtooth");
 shotCooldown=performance.now();ammo--;ammoLabel.textContent="▣ "+ammo+" / 5";
 raycaster.setFromCamera(new THREE.Vector2(0,0),camera);
 const targets=[...players.entries()].map(([id,g])=>({id,g}));
 let targetId=null;
 let best=Infinity;
 for(const t of targets){
  const meshes=[];t.g.traverse(o=>{if(o.isMesh)meshes.push(o)});
  const hits=raycaster.intersectObjects(meshes,false);
  if(hits.length && hits[0].distance<best){best=hits[0].distance;targetId=t.id;}
 }
 ws.send(JSON.stringify({type:"shoot",target:targetId}));
 if(!targetId){message.textContent="ПРОМАХ";setTimeout(()=>message.textContent="",500);}
}
function animate(){
 requestAnimationFrame(animate);
 const dt=Math.min(clock.getDelta(),.04);
 if(joined && !dead && document.pointerLockElement===renderer.domElement){
  const forward=new THREE.Vector3(-Math.sin(yaw),0,-Math.cos(yaw));
  const right=new THREE.Vector3(Math.cos(yaw),0,-Math.sin(yaw));
  const dir=new THREE.Vector3();
  if(keys.KeyW)dir.add(forward);if(keys.KeyS)dir.sub(forward);
  if(keys.KeyD)dir.add(right);if(keys.KeyA)dir.sub(right);
  if(keys.Space && playerHeight<=0.001){verticalVelocity=7.2;keys.Space=false;}
  if(dir.lengthSq()>0){
   dir.normalize().multiplyScalar((keys.ShiftLeft?7:4.5)*dt);
   const nx=camera.position.x+dir.x, nz=camera.position.z+dir.z;
   // Axis-separated resolution lets the player slide along walls instead of sticking.
   if(!blockedAt(nx,camera.position.z)) camera.position.x=nx;
   if(!blockedAt(camera.position.x,nz)) camera.position.z=nz;
  }
  verticalVelocity-=18*dt;playerHeight=Math.max(0,playerHeight+verticalVelocity*dt);if(playerHeight===0)verticalVelocity=0;
  camera.position.y=1.7+playerHeight;
  if(performance.now()-lastSend>65){
   lastSend=performance.now();ws.send(JSON.stringify({type:"move",x:camera.position.x,z:camera.position.z,y:playerHeight,yaw}));
  }
 }
 // Subtle procedural soldier movement makes opponents feel less static.
 for(const g of players.values()){
  if(!g.userData) continue;
  const u=g.userData;
  const oldX=g.position.x, oldZ=g.position.z;
  // Smooth remote-player interpolation removes tiny network-step movement.
  const blend=1-Math.exp(-dt*13);
  g.position.x=THREE.MathUtils.lerp(g.position.x,u.targetX,blend);
  g.position.z=THREE.MathUtils.lerp(g.position.z,u.targetZ,blend);
  g.position.y=THREE.MathUtils.lerp(g.position.y,u.targetY,blend);
  let yawDiff=((u.targetYaw-g.rotation.y+Math.PI*3)%(Math.PI*2))-Math.PI;
  g.rotation.y+=yawDiff*blend;
  const vx=(g.position.x-oldX)/Math.max(dt,.001), vz=(g.position.z-oldZ)/Math.max(dt,.001);
  const speed=Math.hypot(vx,vz);
  u.moving=speed>.18;
  const t=performance.now()*.012+u.phase;
  const stride=Math.min(1,speed/3.8);
  const swing=u.moving?Math.sin(t)*(.55+stride*.22):Math.sin(t*.45)*.012;
  u.leftLeg.rotation.x=swing;
  u.rightLeg.rotation.x=-swing;
  u.leftArm.rotation.x=-swing*.48;
  u.rightArm.rotation.x=swing*.48;
  // Gentle body bob while running/walking.
  g.position.y=u.targetY+(u.moving?Math.abs(Math.sin(t*2))*.035*stride:0);
  if(u.espBox)u.espBox.update();
  if(u.healthFill)u.healthFill.scale.x=Math.max(.01,Math.min(1,u.health/100));
 }
 if(devUnlocked&&devState.radar){
  const c=$("devRadarCanvas"),ctx=c.getContext("2d");ctx.clearRect(0,0,c.width,c.height);ctx.fillStyle="rgba(5,12,18,.82)";ctx.fillRect(0,0,c.width,c.height);ctx.strokeStyle="#9aabb4";ctx.beginPath();ctx.arc(90,90,82,0,Math.PI*2);ctx.stroke();ctx.fillStyle="#e6b84c";ctx.beginPath();ctx.arc(90,90,4,0,Math.PI*2);ctx.fill();
  for(const g of players.values()){const dx=(g.position.x-camera.position.x)*2.2,dz=(g.position.z-camera.position.z)*2.2;if(Math.hypot(dx,dz)>80)continue;ctx.fillStyle="#ff5555";ctx.beginPath();ctx.arc(90+dx,90+dz,3,0,Math.PI*2);ctx.fill();}
 }
 renderer.render(scene,camera);
}
const clock=new THREE.Clock();
animate();
addEventListener("resize",()=>{camera.aspect=innerWidth/innerHeight;camera.updateProjectionMatrix();renderer.setSize(innerWidth,innerHeight);});
