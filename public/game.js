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
// Ruined desert training ground
for(let i=0;i<18;i++){
 const x=(Math.random()-.5)*58,z=(Math.random()-.5)*58;
 if(Math.abs(x)<7 && Math.abs(z)<7) continue;
 box(x,0.7,z,1.5+Math.random()*3,1.4+Math.random()*2,1.5+Math.random()*3, [0x77786b,0x8a806d,0x6d746b][i%3]);
}
for(let i=-2;i<=2;i++){
 box(i*5,1,-13,3,2,2,0x74796f);
 box(i*5,1,13,3,2,2,0x74796f);
}
for(let i=0;i<22;i++){
 const x=(Math.random()-.5)*60,z=(Math.random()-.5)*60;
 const trunk=new THREE.Mesh(new THREE.CylinderGeometry(.12,.2,1.2,6),mat(0x574331));trunk.position.set(x,.6,z);scene.add(trunk);
 const crown=new THREE.Mesh(new THREE.ConeGeometry(.9,2.4,7),mat(0x53634b));crown.position.set(x,2.1,z);scene.add(crown);
}

const sniper = new THREE.Group();
const gunMat=mat(0x202a2d,.45), metal=mat(0x596268,.35);
const barrel=new THREE.Mesh(new THREE.CylinderGeometry(.045,.055,1.35,10),metal);barrel.rotation.x=Math.PI/2;barrel.position.set(0,0,-.72);sniper.add(barrel);
const body=new THREE.Mesh(new THREE.BoxGeometry(.16,.18,.75),gunMat);body.position.set(0,-.05,-.1);sniper.add(body);
const scopeTube=new THREE.Mesh(new THREE.CylinderGeometry(.075,.075,.38,12),metal);scopeTube.rotation.z=Math.PI/2;scopeTube.position.set(0,.16,-.16);sniper.add(scopeTube);
const stock=new THREE.Mesh(new THREE.BoxGeometry(.13,.15,.4),mat(0x654b32));stock.position.set(0,-.04,.42);sniper.add(stock);
camera.add(sniper);sniper.position.set(.34,-.28,-.58);scene.add(camera);

const players = new Map();
let myId=null, room=null, ws=null, joined=false, hp=100, ammo=5, scoped=false, reloading=false;
let yaw=0,pitch=0, lastSend=0, shotCooldown=0;
const keys={};
const message=document.getElementById("message");
const health=document.getElementById("health");
const ammoLabel=document.getElementById("ammo");
const playersLabel=document.getElementById("playersLabel");
const scope=document.getElementById("scope");
const joinPanel=document.getElementById("joinPanel");

function makeOpponent(id){
 const g=new THREE.Group();
 const torso=new THREE.Mesh(new THREE.BoxGeometry(.7,1.05,.42),mat(0x394a3b));torso.position.y=1.1;g.add(torso);
 const head=new THREE.Mesh(new THREE.SphereGeometry(.24,12,10),mat(0xb28a67));head.position.y=1.82;g.add(head);
 const legs=new THREE.Mesh(new THREE.BoxGeometry(.48,.8,.32),mat(0x303b32));legs.position.y=.35;g.add(legs);
 const marker=new THREE.Mesh(new THREE.BoxGeometry(.85,.08,.08),mat(0xc94e39));marker.position.y=2.1;g.add(marker);
 g.position.set(0,0,0);scene.add(g);players.set(id,g);return g;
}
function connect(){
 room=document.getElementById("roomInput").value.trim().toUpperCase()||"DUEL";
 ws=new WebSocket((location.protocol==="https:"?"wss://":"ws://")+location.host);
 ws.onopen=()=>ws.send(JSON.stringify({type:"join",room}));
 ws.onmessage=e=>{
  const m=JSON.parse(e.data);
  if(m.type==="joined"){
   myId=m.id;joined=true;joinPanel.style.display="none";
   document.getElementById("roomLabel").textContent="КОМНАТА "+m.room;
   m.players.forEach(p=>{const g=makeOpponent(p.id);g.position.set(p.x,0,p.z);});
   updateCount();message.textContent="Ожидание второго игрока...";
   document.body.requestPointerLock?.();
  } else if(m.type==="error"){message.textContent=m.message;}
  else if(m.type==="playerJoined"){
   const g=makeOpponent(m.player.id);g.position.set(m.player.x,0,m.player.z);
   message.textContent="Противник подключился!";setTimeout(()=>message.textContent="",1800);updateCount();
  } else if(m.type==="playerMoved"){
   let g=players.get(m.player.id);if(!g)g=makeOpponent(m.player.id);
   g.position.set(m.player.x,0,m.player.z);
   g.rotation.y=m.player.yaw;
  } else if(m.type==="playerLeft"){
   const g=players.get(m.id);if(g)scene.remove(g);players.delete(m.id);updateCount();message.textContent="Противник отключился";
  } else if(m.type==="roomCount"){updateCount(m.count);}
  else if(m.type==="hit"){hp=m.hp;health.textContent="❤ "+hp;if(hp<=0)message.textContent="ТЕБЯ УСТРАНИЛИ";}
  else if(m.type==="respawn"){hp=100;health.textContent="❤ 100";message.textContent="ВОЗРОЖДЕНИЕ";setTimeout(()=>message.textContent="",1200);}
  else if(m.type==="shotResult"){message.textContent=m.hit?"ПОПАДАНИЕ!":"ПРОМАХ";setTimeout(()=>message.textContent="",700);}
  else if(m.type==="score"){const mine=m.scores.find(s=>s.id===myId);if(mine)message.textContent="ТВОИ УБИЙСТВА: "+mine.score;}
 };
 ws.onclose=()=>{joined=false;message.textContent="Соединение потеряно";};
}
function updateCount(n){playersLabel.textContent="ИГРОКИ "+(n??(players.size+1))+"/2";}
document.getElementById("joinButton").onclick=connect;

document.addEventListener("mousemove",e=>{
 if(!joined||document.pointerLockElement!==renderer.domElement)return;
 yaw-=e.movementX*.0022;pitch-=e.movementY*.0022;
 pitch=Math.max(-1.25,Math.min(1.25,pitch));
 camera.rotation.set(pitch,yaw,0,"YXZ");
});
document.addEventListener("keydown",e=>{
 keys[e.code]=true;
 if(e.code==="KeyR")reload();
});
document.addEventListener("keyup",e=>keys[e.code]=false);
document.addEventListener("contextmenu",e=>e.preventDefault());
document.addEventListener("mousedown",e=>{
 if(!joined)return;
 if(document.pointerLockElement!==renderer.domElement){renderer.domElement.requestPointerLock();return;}
 if(e.button===2){scoped=!scoped;scope.style.display=scoped?"block":"none";camera.fov=scoped?24:75;camera.updateProjectionMatrix();}
 if(e.button===0)shoot();
});
document.addEventListener("pointerlockchange",()=>{
 if(document.pointerLockElement!==renderer.domElement && joined) message.textContent="Нажми по игре, чтобы продолжить";
 else if(joined)message.textContent="";
});
function reload(){
 if(reloading||ammo===5)return;
 reloading=true;message.textContent="ПЕРЕЗАРЯДКА...";
 setTimeout(()=>{ammo=5;reloading=false;ammoLabel.textContent="▣ 5 / 5";message.textContent="";},1400);
}
const raycaster=new THREE.Raycaster();
function shoot(){
 if(ammo<=0||reloading||performance.now()-shotCooldown<850)return;
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
 if(joined && document.pointerLockElement===renderer.domElement){
  const forward=new THREE.Vector3(-Math.sin(yaw),0,-Math.cos(yaw));
  const right=new THREE.Vector3(Math.cos(yaw),0,-Math.sin(yaw));
  const dir=new THREE.Vector3();
  if(keys.KeyW)dir.add(forward);if(keys.KeyS)dir.sub(forward);
  if(keys.KeyD)dir.add(right);if(keys.KeyA)dir.sub(right);
  if(dir.lengthSq()>0){dir.normalize().multiplyScalar((keys.ShiftLeft?8:5)*dt);camera.position.add(dir);}
  camera.position.x=THREE.MathUtils.clamp(camera.position.x,-20,20);
  camera.position.z=THREE.MathUtils.clamp(camera.position.z,-20,20);
  camera.position.y=1.7;
  if(performance.now()-lastSend>65){
   lastSend=performance.now();ws.send(JSON.stringify({type:"move",x:camera.position.x,z:camera.position.z,yaw}));
  }
 }
 renderer.render(scene,camera);
}
const clock=new THREE.Clock();
animate();
addEventListener("resize",()=>{camera.aspect=innerWidth/innerHeight;camera.updateProjectionMatrix();renderer.setSize(innerWidth,innerHeight);});
