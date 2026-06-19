import * as THREE from "three";
import { Client, getStateCallbacks, Room } from "colyseus.js";

// ---- Server endpoint (override via ?server=... for tunnels) ----
const params = new URLSearchParams(location.search);
const SERVER_URL =
  params.get("server") ||
  `${location.protocol === "https:" ? "wss" : "ws"}://${location.hostname}:2567`;

// ---------------- Three.js setup ----------------
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x87ceeb);

const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.1, 200);
camera.position.set(0, 34, 26); // angled top-down = 2.5D bird's-eye
camera.lookAt(0, 0, 0);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
document.getElementById("app")!.appendChild(renderer.domElement);

scene.add(new THREE.AmbientLight(0xffffff, 0.7));
const sun = new THREE.DirectionalLight(0xffffff, 0.8);
sun.position.set(10, 20, 10);
scene.add(sun);

// ground
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(48, 48),
  new THREE.MeshStandardMaterial({ color: 0x7ec850 })
);
ground.rotation.x = -Math.PI / 2;
scene.add(ground);

// target (the thing we defend) at origin
const target = new THREE.Mesh(
  new THREE.CylinderGeometry(1.6, 1.6, 1.2, 24),
  new THREE.MeshStandardMaterial({ color: 0x3a86ff })
);
target.position.y = 0.6;
scene.add(target);

window.addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// ---------------- View modes ----------------
const TOWER_COST = 30; // mirrors server tuning (for HUD affordability)
type ViewMode = "champion" | "build";
let mode: ViewMode = "champion";

function applyCamera() {
  if (mode === "build") {
    camera.position.set(0, 60, 0.01); // straight-down plan view
  } else {
    camera.position.set(0, 34, 26);   // angled 2.5D follow
  }
  camera.lookAt(0, 0, 0);
}
applyCamera();

function setMode(next: ViewMode) {
  mode = next;
  applyCamera();
  buildGhost.visible = false;
  document.body.classList.toggle("build-mode", mode === "build");
  ($("modeBtn") as HTMLButtonElement).textContent =
    mode === "build" ? "Champion view (B)" : `Build view (B) — towers ${TOWER_COST}g`;
  ($("hint") as HTMLElement).textContent =
    mode === "build"
      ? "Build view · click ground = place tower (30g) · click a tower = upgrade · B to return"
      : "WASD / arrows to move · click to attack · B to build";
}

// ---------------- Entity view registries ----------------
const playerMeshes = new Map<string, THREE.Group>();
const enemyMeshes = new Map<string, THREE.Group>();
const towerMeshes = new Map<string, THREE.Mesh>();

// per-knight animation state. rx/rz = smoothly interpolated render position;
// vx/vz = low-passed velocity (drives walk cycle + facing); spx/spz = last server
// position (for dash-trail endpoints).
type KnightAnim = {
  rx: number; rz: number; vx: number; vz: number; spx: number; spz: number;
  phase: number; yaw: number; bob: number; spin: number; swing: number;
  prevWhirl: number; prevDash: number; prevAtk: number;
};
const knightAnim = new Map<string, KnightAnim>();

const mat = (c: number) => new THREE.MeshStandardMaterial({ color: c });

// A pivot group whose child limb hangs below it, so rotating the pivot swings the limb.
function makeLimb(color: number, w: number, len: number) {
  const pivot = new THREE.Group();
  const seg = new THREE.Mesh(new THREE.BoxGeometry(w, len, w), mat(color));
  seg.position.y = -len / 2;
  pivot.add(seg);
  return pivot;
}

// Procedural "v1" Knight: blocky armored figure with helmet, plume, sword & shield.
// Origin is at the feet (y=0) so evo scaling keeps it grounded.
function makeKnight(isMe: boolean) {
  const g = new THREE.Group();
  const armor = isMe ? 0x3f74d0 : 0xcf5b3a;       // team color (blue = you)
  const armorDark = isMe ? 0x2b5197 : 0x9b3f26;
  const steel = 0xc2cdd9;
  const skin = 0xf0c39c;
  const plumeCol = isMe ? 0xffe066 : 0x6fffd0;

  const torso = new THREE.Mesh(new THREE.BoxGeometry(0.95, 1.0, 0.62), mat(armor));
  torso.position.y = 1.15; g.add(torso);
  const belt = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.18, 0.66), mat(armorDark));
  belt.position.y = 0.72; g.add(belt);

  const head = new THREE.Mesh(new THREE.SphereGeometry(0.3, 16, 12), mat(skin));
  head.position.y = 1.95; g.add(head);
  const helmet = new THREE.Mesh(
    new THREE.SphereGeometry(0.37, 16, 12, 0, Math.PI * 2, 0, Math.PI / 2), mat(steel));
  helmet.position.y = 1.98; g.add(helmet);
  const visor = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.1, 0.05), mat(armorDark));
  visor.position.set(0, 1.93, 0.3); g.add(visor);
  const plume = new THREE.Mesh(new THREE.ConeGeometry(0.09, 0.5, 8), mat(plumeCol));
  plume.position.set(0, 2.4, -0.08); plume.rotation.x = -0.3; g.add(plume);

  // legs
  const lLeg = makeLimb(armorDark, 0.27, 0.62); lLeg.position.set(-0.24, 0.62, 0);
  const rLeg = makeLimb(armorDark, 0.27, 0.62); rLeg.position.set(0.24, 0.62, 0);
  g.add(lLeg, rLeg);

  // arms
  const lArm = makeLimb(armor, 0.22, 0.62); lArm.position.set(-0.62, 1.55, 0);
  const rArm = makeLimb(armor, 0.22, 0.62); rArm.position.set(0.62, 1.55, 0);
  g.add(lArm, rArm);

  // sword in the right hand (hangs from the arm end)
  const sword = new THREE.Group();
  const blade = new THREE.Mesh(new THREE.BoxGeometry(0.1, 1.2, 0.04), mat(0xe8eef5));
  blade.position.y = -0.6;
  const guard = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.1, 0.12), mat(0x8a6b2e));
  sword.add(blade, guard); sword.position.y = -0.62; rArm.add(sword);

  // shield on the left arm
  const shield = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.32, 0.08, 16), mat(steel));
  shield.rotation.x = Math.PI / 2; shield.position.set(0, -0.5, 0.16);
  const emblem = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 0.1, 16), mat(armor));
  emblem.rotation.x = Math.PI / 2; emblem.position.set(0, -0.5, 0.18); lArm.add(shield, emblem);

  g.userData.parts = { lLeg, rLeg, lArm, rArm, sword };
  scene.add(g);
  return g;
}
// Visual per creep tier (mirrors server ENEMY_KINDS).
const ENEMY_VIS: Record<string, { color: number; scale: number }> = {
  grunt:  { color: 0xd00000, scale: 1.0 },
  runner: { color: 0xffa630, scale: 0.7 },
  tank:   { color: 0x6a040f, scale: 1.6 },
};
function makeHealthBar() {
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 8;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#2a9d3c";
  ctx.fillRect(0, 0, 64, 8);
  const tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = THREE.NearestFilter;
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: tex, depthTest: false })
  );
  sprite.scale.set(1.2, 0.15, 1);
  sprite.userData.canvas = canvas;
  sprite.userData.ctx = ctx;
  sprite.userData.tex = tex;
  return sprite;
}

function updateHealthBar(sprite: THREE.Sprite, ratio: number) {
  const ctx = sprite.userData.ctx as CanvasRenderingContext2D;
  const canvas = sprite.userData.canvas as HTMLCanvasElement;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#333";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = ratio > 0.5 ? "#2a9d3c" : ratio > 0.25 ? "#ffb703" : "#d00000";
  ctx.fillRect(0, 0, canvas.width * ratio, canvas.height);
  (sprite.userData.tex as THREE.CanvasTexture).needsUpdate = true;
}

function makeEnemy(kind: string) {
  const v = ENEMY_VIS[kind] ?? ENEMY_VIS.grunt;
  const g = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(v.scale, v.scale, v.scale),
    new THREE.MeshStandardMaterial({ color: v.color })
  );
  body.position.y = v.scale / 2;
  g.add(body);
  const bar = makeHealthBar();
  bar.position.y = v.scale + 0.3;
  g.add(bar);
  g.userData.bar = bar;
  scene.add(g);
  return g;
}
function makeTower() {
  const m = new THREE.Mesh(
    new THREE.ConeGeometry(0.9, 2.4, 6),
    new THREE.MeshStandardMaterial({ color: 0x9b5de5 })
  );
  m.position.y = 1.2;
  scene.add(m);
  return m;
}

// ---------------- Abilities (mirrors server ABILITIES by slot) ----------------
const ABILITY_UI = [
  { key: "Q", serverKey: "whirlwind", name: "Whirlwind", cd: 4, radius: 4.5 },
  { key: "E", serverKey: "dash", name: "Dash", cd: 3 },
];

// Evolution stages mirror (cost to advance from stage, + whirlwind radius for ring fx).
const EVO_UI = [
  { upgradeCost: 50, whirlRadius: 4.5 },
  { upgradeCost: 110, whirlRadius: 5.5 },
  { upgradeCost: 0, whirlRadius: 6.5 },
];
const EVO_MAX = EVO_UI.length;
function evoOf(): number {
  return room?.state.players.get(mySessionId)?.evo ?? 1;
}

// transient ground rings for ability feedback
type Ring = { mesh: THREE.Mesh; age: number; life: number; to: number };
const rings: Ring[] = [];
function spawnRing(x: number, z: number, to: number, color: number) {
  const mesh = new THREE.Mesh(
    new THREE.TorusGeometry(1, 0.18, 8, 32),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9 })
  );
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.set(x, 0.2, z);
  scene.add(mesh);
  rings.push({ mesh, age: 0, life: 0.45, to });
}
function updateRings(dt: number) {
  for (let i = rings.length - 1; i >= 0; i--) {
    const r = rings[i];
    r.age += dt;
    const t = r.age / r.life;
    const s = 0.3 + t * r.to;
    r.mesh.scale.set(s, s, 1);
    (r.mesh.material as THREE.MeshBasicMaterial).opacity = Math.max(0, 0.9 * (1 - t));
    if (r.age >= r.life) { scene.remove(r.mesh); rings.splice(i, 1); }
  }
}

// fading after-images for the Dash
type Ghost = { mesh: THREE.Mesh; age: number; life: number };
const ghosts: Ghost[] = [];
function spawnDashTrail(x0: number, z0: number, x1: number, z1: number) {
  const n = 5;
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const mesh = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.5, 1.0, 4, 8),
      new THREE.MeshBasicMaterial({ color: 0x9b5de5, transparent: true, opacity: 0.45 })
    );
    mesh.position.set(x0 + (x1 - x0) * t, 1.0, z0 + (z1 - z0) * t);
    scene.add(mesh);
    ghosts.push({ mesh, age: 0, life: 0.32 - i * 0.03 });
  }
}
function updateGhosts(dt: number) {
  for (let i = ghosts.length - 1; i >= 0; i--) {
    const gh = ghosts[i];
    gh.age += dt;
    (gh.mesh.material as THREE.MeshBasicMaterial).opacity = Math.max(0, 0.45 * (1 - gh.age / gh.life));
    if (gh.age >= gh.life) { scene.remove(gh.mesh); ghosts.splice(i, 1); }
  }
}

// Basic-attack hitbox telegraph: a fading frontal sector on the ground.
const ATTACK_RANGE = 3.6;
const ATTACK_HALF = Math.PI / 3; // matches server ±60° arc
type Arc = { obj: THREE.Object3D; mat: THREE.MeshBasicMaterial; age: number; life: number };
const arcs: Arc[] = [];
function spawnSwingArc(x: number, z: number, yaw: number, radius: number, half: number) {
  const mesh = new THREE.Mesh(
    new THREE.CircleGeometry(radius, 24, -half, half * 2),
    new THREE.MeshBasicMaterial({ color: 0xfff1a8, transparent: true, opacity: 0.45, side: THREE.DoubleSide })
  );
  mesh.rotation.x = -Math.PI / 2; // lay flat; sector now bisects along world +x
  const pivot = new THREE.Group();
  pivot.add(mesh);
  pivot.position.set(x, 0.16, z);
  pivot.rotation.y = Math.atan2(-Math.cos(yaw), Math.sin(yaw)); // aim +x toward facing dir
  scene.add(pivot);
  arcs.push({ obj: pivot, mat: mesh.material as THREE.MeshBasicMaterial, age: 0, life: 0.3 });
}
function updateArcs(dt: number) {
  for (let i = arcs.length - 1; i >= 0; i--) {
    const a = arcs[i];
    a.age += dt;
    a.mat.opacity = Math.max(0, 0.45 * (1 - a.age / a.life));
    if (a.age >= a.life) { scene.remove(a.obj); arcs.splice(i, 1); }
  }
}

// Play the sword-swing + hitbox telegraph for a knight (by session id).
function triggerSwing(sid: string) {
  const st = knightAnim.get(sid);
  if (!st) return;
  st.swing = 0.3;
  const p = room?.state.players.get(sid);
  const sc = 1 + (((p?.evo as number) ?? 1) - 1) * 0.25;
  spawnSwingArc(st.rx, st.rz, st.yaw, ATTACK_RANGE * sc, ATTACK_HALF);
}

function castAbility(slot: number) {
  if (!room) return;
  const me = room.state.players.get(mySessionId);
  const a = ABILITY_UI[slot];
  if (!me || (me.cds?.get(a.serverKey) ?? 0) > 0) return; // client-side gate (server re-checks)
  room.send("ability", { slot });
  // visual feedback is driven uniformly from cooldown changes in updateKnights()
}

// Translucent ghost shown under the cursor while in Build mode.
const buildGhost = new THREE.Mesh(
  new THREE.ConeGeometry(0.9, 2.4, 6),
  new THREE.MeshStandardMaterial({ color: 0x9b5de5, transparent: true, opacity: 0.4 })
);
buildGhost.position.y = 1.2;
buildGhost.visible = false;
scene.add(buildGhost);

// ---------------- HUD ----------------
const $ = (id: string) => document.getElementById(id)!;
const startBtn = $("startBtn") as HTMLButtonElement;

// ---------------- Networking ----------------
let room: Room;
let mySessionId = "";

async function connect() {
  const client = new Client(SERVER_URL);
  room = await client.joinOrCreate("game");
  mySessionId = room.sessionId;

  const cb = getStateCallbacks(room);

  // onAdd/onRemove manage mesh lifecycle; positions are synced every frame
  // from room.state in the render loop (robust across colyseus callback APIs).
  cb(room.state).players.onAdd((_player: any, sessionId: string) => {
    playerMeshes.set(sessionId, makeKnight(sessionId === mySessionId));
  });
  cb(room.state).players.onRemove((_p: any, sessionId: string) => {
    const mesh = playerMeshes.get(sessionId);
    if (mesh) { scene.remove(mesh); playerMeshes.delete(sessionId); }
    knightAnim.delete(sessionId);
  });

  cb(room.state).enemies.onAdd((enemy: any) => {
    enemyMeshes.set(enemy.id, makeEnemy(enemy.kind));
  });
  cb(room.state).enemies.onRemove((enemy: any) => {
    const mesh = enemyMeshes.get(enemy.id);
    if (mesh) { scene.remove(mesh); enemyMeshes.delete(enemy.id); }
  });

  cb(room.state).towers.onAdd((tower: any) => {
    const m = makeTower();
    m.userData.towerId = tower.id;
    towerMeshes.set(tower.id, m);
  });
  cb(room.state).towers.onRemove((tower: any) => {
    const mesh = towerMeshes.get(tower.id);
    if (mesh) { scene.remove(mesh); towerMeshes.delete(tower.id); }
  });

  cb(room.state).onChange(() => {
    $("wave").textContent = String(room.state.wave);
    $("gold").textContent = String(room.state.gold);
    $("kills").textContent = String(room.state.kills);
    $("hp").textContent = String(room.state.targetHp);
    const me = room.state.players.get(mySessionId);
    $("evoLvl").textContent = String(me?.evo ?? 1);
    $("nextWave").textContent = room.state.betweenWaves
      ? `Next wave in ${room.state.nextWaveIn}s`
      : "Wave in progress";
    startBtn.disabled = !room.state.betweenWaves || room.state.gameOver || room.state.paused;
    ($("pauseMenu") as HTMLElement).style.display = room.state.paused ? "flex" : "none";
    const banner = $("banner") as HTMLElement;
    if (room.state.gameOver && banner.style.display !== "flex") {
      const players = [...room.state.players.entries()] as [string, any][];
      const stats: [string, string][] = [
        ["Wave Reached", String(room.state.wave)],
        ["Enemies Defeated", String(room.state.kills)],
        ["Gold Earned", String(room.state.totalGold)],
        ["Towers Built", String(room.state.towers.length)],
      ];
      players.forEach(([, p]) => {
        stats.push([`${p.name} Level`, String(p.evo)]);
      });
      $("statsGrid").innerHTML = stats
        .map(([label, val]) => `<span class="label">${label}</span><span class="val">${val}</span>`)
        .join("");
      banner.style.display = "flex";
    } else if (!room.state.gameOver) {
      banner.style.display = "none";
    }
    updateLobby();
  });

  ($("playAgainBtn") as HTMLButtonElement).addEventListener("click", () => room?.send("restart"));
  ($("joinUrl") as HTMLElement).textContent = location.host || "this page's URL";
  const connEl = $("connStatus");
  connEl.textContent = "Connected!";
  connEl.className = "connStatus ok";
  (readyBtn as HTMLButtonElement).disabled = false;
  (window as any).__room = room; // debug handle (room id / state inspection)
  (window as any).__camera = camera; // debug handle (inspection screenshots)
  updateLobby();
}

// ---------------- Lobby ----------------
const nameInput = $("nameInput") as HTMLInputElement;
const readyBtn = $("readyBtn") as HTMLButtonElement;
const startGameBtn = $("startGameBtn") as HTMLButtonElement;

nameInput.addEventListener("input", () => room?.send("setName", { name: nameInput.value }));
readyBtn.addEventListener("click", () => {
  const me = room?.state.players.get(mySessionId);
  room?.send("ready", { ready: !me?.ready });
});
startGameBtn.addEventListener("click", () => room?.send("startGame"));

let lobbySig = "";
let nameSeeded = false;
function updateLobby() {
  if (!room?.state) return;
  const inLobby = room.state.phase === "lobby";
  const players = [...room.state.players.entries()] as [string, any][];
  // cheap signature so we only touch the DOM when something actually changed
  const sig = room.state.phase + "|" + mySessionId + "|" +
    players.map(([sid, p]) => `${sid}:${p.name}:${p.ready ? 1 : 0}`).join("|");
  if (sig === lobbySig) return;
  lobbySig = sig;

  ($("lobby") as HTMLElement).style.display = inLobby ? "flex" : "none";
  if (!inLobby) return;

  // seed the name field once from our assigned default
  const meSeed = room.state.players.get(mySessionId);
  if (meSeed && !nameSeeded) { nameInput.value = meSeed.name; nameSeeded = true; }

  ($("playerList") as HTMLElement).innerHTML = players
    .map(([sid, p]) => {
      const you = sid === mySessionId ? " (you)" : "";
      const cls = p.ready ? "on" : "off";
      const label = p.ready ? "READY" : "not ready";
      return `<div class="playerRow"><span>${escapeHtml(p.name)}${you}</span>` +
        `<span class="status ${cls}">${label}</span></div>`;
    })
    .join("");

  const me = room.state.players.get(mySessionId);
  readyBtn.textContent = me?.ready ? "Unready" : "Ready up";
  readyBtn.classList.toggle("on", !!me?.ready);
  const allReady = players.length > 0 && players.every(([, p]) => p.ready);
  startGameBtn.disabled = !allReady;
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

startBtn.addEventListener("click", () => room?.send("startWave"));
($("modeBtn") as HTMLButtonElement).addEventListener("click", () =>
  setMode(mode === "build" ? "champion" : "build"));
($("evolveBtn") as HTMLButtonElement).addEventListener("click", () => room?.send("evolve"));

$("pauseBtn").addEventListener("click", () => room?.send("pause"));
$("resumeBtn").addEventListener("click", () => room?.send("pause"));
$("restartBtn").addEventListener("click", () => room?.send("restart"));

$("shareBtn").addEventListener("click", () => {
  if (!room?.state) return;
  const s = room.state;
  const players = [...s.players.values()] as any[];
  const names = players.map((p) => `${p.name} (Lv${p.evo})`).join(", ");
  const text = [
    `I just survived to Wave ${s.wave} in TD-Game!`,
    `${s.kills} enemies defeated | ${s.totalGold} gold earned | ${s.towers.length} towers built`,
    `Players: ${names}`,
  ].join("\n");
  navigator.clipboard.writeText(text).then(() => {
    const btn = $("shareBtn") as HTMLButtonElement;
    btn.textContent = "Copied!";
    setTimeout(() => { btn.textContent = "Share Result"; }, 2000);
  });
});

function updateEvolveBtn() {
  const btn = $("evolveBtn") as HTMLButtonElement;
  const evo = evoOf();
  if (evo >= EVO_MAX) {
    btn.textContent = `Evolved Lv${evo} (max)`;
    btn.disabled = true;
    return;
  }
  const cost = EVO_UI[evo - 1].upgradeCost;
  btn.textContent = `Evolve Lv${evo}→${evo + 1} (${cost}g)`;
  btn.disabled = (room?.state.gold ?? 0) < cost || room?.state.phase !== "playing";
}

// ---------------- Input ----------------
const keys = new Set<string>();
let lastDx = 0, lastDz = 0;
addEventListener("keydown", (e) => {
  const k = e.key.toLowerCase();
  if ((k === "escape" || k === "p") && room?.state.phase === "playing") { room.send("pause"); return; }
  if (room?.state.paused) return; // ignore gameplay input while paused
  if (k === "b") { setMode(mode === "build" ? "champion" : "build"); return; }
  const fresh = !keys.has(k); // ignore auto-repeat
  keys.add(k);
  if (fresh && mode !== "build") {
    if (k === "q") castAbility(0);
    if (k === "e") castAbility(1);
    if (k === " ") { room?.send("attack"); triggerSwing(mySessionId); }
  }
});
addEventListener("keyup", (e) => keys.delete(e.key.toLowerCase()));

// Raycast the cursor onto the ground plane.
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
function groundPoint(ev: MouseEvent): THREE.Vector3 | null {
  pointer.x = (ev.clientX / innerWidth) * 2 - 1;
  pointer.y = -(ev.clientY / innerHeight) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  const hit = raycaster.intersectObject(ground)[0];
  return hit ? hit.point : null;
}

renderer.domElement.addEventListener("mousemove", (ev) => {
  if (mode !== "build") return;
  const p = groundPoint(ev);
  if (p) { buildGhost.position.set(p.x, 1.2, p.z); buildGhost.visible = true; }
  else buildGhost.visible = false;
});

renderer.domElement.addEventListener("click", (ev) => {
  if (room?.state.paused) return;
  if (mode === "build") {
    // clicking an existing tower upgrades it; otherwise place a new one
    pointer.x = (ev.clientX / innerWidth) * 2 - 1;
    pointer.y = -(ev.clientY / innerHeight) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    const towerHit = raycaster.intersectObjects([...towerMeshes.values()])[0];
    if (towerHit) {
      room?.send("upgradeTower", { id: towerHit.object.userData.towerId });
      return;
    }
    const p = groundPoint(ev);
    if (p) room?.send("buildTower", { x: p.x, z: p.z });
  } else {
    room?.send("attack");
    triggerSwing(mySessionId); // instant local feedback
  }
});

function sendInput() {
  let dx = 0, dz = 0;
  if (keys.has("w") || keys.has("arrowup")) dz -= 1;
  if (keys.has("s") || keys.has("arrowdown")) dz += 1;
  if (keys.has("a") || keys.has("arrowleft")) dx -= 1;
  if (keys.has("d") || keys.has("arrowright")) dx += 1;
  if (dx !== lastDx || dz !== lastDz) {
    room?.send("input", { dx, dz });
    lastDx = dx; lastDz = dz;
  }
}

// ---------------- Loop ----------------
const WALK_AMP = 0.8;
const lerp = THREE.MathUtils.lerp;
function updateKnights(dt: number) {
  if (!room?.state) return;
  const idt = Math.max(dt, 1e-3);
  room.state.players.forEach((p: any, sid: string) => {
    const g = playerMeshes.get(sid);
    if (!g) return;
    let st = knightAnim.get(sid);
    if (!st) {
      st = { rx: p.x, rz: p.z, vx: 0, vz: 0, spx: p.x, spz: p.z,
             phase: 0, yaw: 0, bob: 0, spin: 0, swing: 0, prevWhirl: 0, prevDash: 0, prevAtk: 0 };
      knightAnim.set(sid, st);
    }

    // --- ability / attack detection via cooldown jump (server-authoritative) ---
    const whirlCd = p.cds?.get?.("whirlwind") ?? 0;
    if (whirlCd > st.prevWhirl + 0.05 && whirlCd > 3) {
      st.spin = 0.5;
      spawnRing(p.x, p.z, EVO_UI[(p.evo ?? 1) - 1].whirlRadius, 0xffe066);
    }
    st.prevWhirl = whirlCd;
    const dashCd = p.cds?.get?.("dash") ?? 0;
    if (dashCd > st.prevDash + 0.05 && dashCd > 2) spawnDashTrail(st.spx, st.spz, p.x, p.z);
    st.prevDash = dashCd;
    // remote players: trigger swing from cooldown change (local player triggers
    // instantly on click for snappy feel — see triggerSwing()).
    const atkCd = p.cds?.get?.("attack") ?? 0;
    if (sid !== mySessionId && atkCd > st.prevAtk + 0.01 && atkCd > 0.1) triggerSwing(sid);
    st.prevAtk = atkCd;
    st.spx = p.x; st.spz = p.z;

    // --- smooth the render position toward the server position every frame ---
    // (server only patches ~20Hz; without this it slides in discrete steps)
    const k = 1 - Math.exp(-dt * 16);
    const nrx = lerp(st.rx, p.x, k);
    const nrz = lerp(st.rz, p.z, k);
    const instVx = (nrx - st.rx) / idt, instVz = (nrz - st.rz) / idt;
    st.rx = nrx; st.rz = nrz;
    // low-pass velocity so walk speed / facing are stable
    const va = 1 - Math.exp(-dt * 12);
    st.vx = lerp(st.vx, instVx, va);
    st.vz = lerp(st.vz, instVz, va);
    const speed = Math.hypot(st.vx, st.vz);

    // face the velocity direction (shortest path), only when actually moving
    if (speed > 0.7) {
      let d = Math.atan2(st.vx, st.vz) - st.yaw;
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      st.yaw += d * Math.min(1, dt * 16);
    }

    g.scale.setScalar(1 + ((p.evo ?? 1) - 1) * 0.25);

    // whirlwind spin overrides facing for its duration
    if (st.spin > 0) { st.spin = Math.max(0, st.spin - dt); g.rotation.y += 16 * dt; }
    else g.rotation.y = st.yaw;

    // --- walk cycle / idle bob ---
    const walking = speed > 0.7;
    const stepRate = Math.min(speed, 9) * 1.5;      // faster movement → faster steps
    st.phase += dt * (walking ? stepRate : 0);
    st.bob += dt;
    const amp = WALK_AMP * Math.min(1, speed / 6);
    const targetSwing = walking ? Math.sin(st.phase) * amp : 0;
    const parts = g.userData.parts;
    const ease = Math.min(1, dt * 14);
    parts.lLeg.rotation.x = lerp(parts.lLeg.rotation.x, targetSwing, ease);
    parts.rLeg.rotation.x = lerp(parts.rLeg.rotation.x, -targetSwing, ease);
    if (st.spin > 0) {
      parts.lArm.rotation.z = -1.1; parts.rArm.rotation.z = 1.1; // arms fling out
      parts.lArm.rotation.x = 0; parts.rArm.rotation.x = 0;
    } else if (st.swing > 0) {
      st.swing = Math.max(0, st.swing - dt);
      const prog = 1 - st.swing / 0.3;            // overhead chop, raised → down-front
      parts.rArm.rotation.x = lerp(-2.4, 0.8, prog);
      parts.rArm.rotation.z = lerp(0.2, -0.3, prog);
      parts.lArm.rotation.z = lerp(parts.lArm.rotation.z, 0, ease);
      parts.lArm.rotation.x = lerp(parts.lArm.rotation.x, 0.25, ease);
    } else {
      parts.lArm.rotation.z = lerp(parts.lArm.rotation.z, 0, ease);
      parts.rArm.rotation.z = lerp(parts.rArm.rotation.z, 0, ease);
      parts.lArm.rotation.x = lerp(parts.lArm.rotation.x, -targetSwing * 0.6, ease);
      parts.rArm.rotation.x = lerp(parts.rArm.rotation.x, targetSwing * 0.6, ease);
    }
    const bobY = walking ? Math.abs(Math.sin(st.phase)) * 0.08 : Math.sin(st.bob * 2.2) * 0.04;
    g.position.set(st.rx, bobY, st.rz);
  });
}

function syncEnemiesTowers() {
  if (!room?.state) return;
  room.state.enemies.forEach((e: any) => {
    const g = enemyMeshes.get(e.id);
    if (g) {
      g.position.x = e.x;
      g.position.z = e.z;
      const bar = g.userData.bar as THREE.Sprite;
      if (bar && e.maxHp > 0) updateHealthBar(bar, e.hp / e.maxHp);
    }
  });
  room.state.towers.forEach((t: any) => {
    const m = towerMeshes.get(t.id);
    if (m) {
      const s = 1 + (t.level - 1) * 0.35; // grow with upgrade level
      m.scale.setScalar(s);
      m.position.set(t.x, 1.2 * s, t.z);
    }
  });
}

const clock = new THREE.Clock();
function updateAbilityHud() {
  const me = room?.state.players.get(mySessionId);
  for (let s = 0; s < ABILITY_UI.length; s++) {
    const el = $(`ab${s}`);
    const cd = me?.cds?.get(ABILITY_UI[s].serverKey) ?? 0;
    el.classList.toggle("ready", cd <= 0);
    el.querySelector(".cd")!.textContent = cd > 0 ? Math.ceil(cd).toString() : "";
  }
}

function animate() {
  requestAnimationFrame(animate);
  const dt = clock.getDelta();
  if (room) {
    updateLobby(); sendInput();
    updateKnights(dt); syncEnemiesTowers();
    updateAbilityHud(); updateEvolveBtn();
  }
  updateRings(dt);
  updateGhosts(dt);
  updateArcs(dt);
  renderer.render(scene, camera);
}
animate();

connect().catch((err) => {
  console.error("Failed to connect:", err);
  ($("nextWave") as HTMLElement).textContent = "⚠ cannot reach server (is it running?)";
  const connEl = $("connStatus");
  connEl.textContent = "Cannot reach server — is it running?";
  connEl.className = "connStatus err";
});
