import { Room, Client } from "@colyseus/core";
import { GameState, Player, Enemy, Tower } from "./schema.js";

// --- Tuning (single source of truth) ---
const ATTACK_RANGE = 3.6;      // melee reach (frontal arc); scales with evo, matches telegraph
const ATTACK_HALF_ANGLE = Math.PI / 3; // ±60° cone in front (120° total)
const ATTACK_CD = 0.35;        // seconds between swings
const TARGET_DAMAGE = 5;       // fallback dmg to objective when a creep arrives

// Champion evolution stages (1..3), indexed by evo-1. `upgradeCost` is the gold
// to advance FROM this stage (last stage = maxed, no further upgrade).
const EVO = [
  { atk: 10, whirlDmg: 14, whirlRadius: 4.5, dash: 9,  speed: 8,  upgradeCost: 50 },
  { atk: 16, whirlDmg: 22, whirlRadius: 5.5, dash: 11, speed: 9,  upgradeCost: 110 },
  { atk: 24, whirlDmg: 34, whirlRadius: 6.5, dash: 13, speed: 10, upgradeCost: 0 },
];
const EVO_MAX = EVO.length;
const WAVE_GAP = 8;            // seconds between waves
const EARLY_START_BONUS = 25;  // gold for starting a wave early
const ARENA = 22;              // half-extent; play area is [-ARENA, ARENA]

// Creep tiers — base stats; hp scales per wave on spawn. `size` matches the
// client mesh size so the melee hitbox can account for the creep's body.
const ENEMY_KINDS = {
  grunt:  { baseHp: 10, hpPerWave: 2, speed: 2.5, gold: 5,  dmg: 5,  size: 1.0 },
  runner: { baseHp: 6,  hpPerWave: 1, speed: 5.0, gold: 4,  dmg: 4,  size: 0.7 },
  tank:   { baseHp: 30, hpPerWave: 5, speed: 1.3, gold: 12, dmg: 12, size: 1.6 },
} as const;
type EnemyKind = keyof typeof ENEMY_KINDS;

// Towers — stats indexed by level (1..3).
const TOWER_COST = 30;
const TOWER_MIN_GAP = 2.5;       // min spacing between towers / from target
const TOWER_LEVELS = [
  { range: 7, dmg: 6,  interval: 0.7 },  // level 1
  { range: 8, dmg: 10, interval: 0.6 },  // level 2
  { range: 9, dmg: 16, interval: 0.5 },  // level 3
];
const TOWER_UPGRADE_COST = [25, 40]; // 1->2, 2->3
const TOWER_MAX_LEVEL = TOWER_LEVELS.length;

// Champion abilities (Knight). Cooldown/identity here; power scales with EVO stage.
const ABILITIES = [
  { key: "whirlwind", cooldown: 4 }, // slot 0 — AoE around self
  { key: "dash",      cooldown: 3 }, // slot 1 — burst reposition
];

type Input = { dx: number; dz: number };

export class GameRoom extends Room<GameState> {
  maxClients = 4;

  private inputs = new Map<string, Input>();
  private spawnQueue = 0;       // enemies left to spawn this wave
  private spawnTimer = 0;       // seconds until next spawn
  private countdown = WAVE_GAP; // seconds until next wave (between waves)
  private enemySeq = 0;
  private towerSeq = 0;
  private towerCooldowns = new Map<string, number>(); // tower id -> seconds until next shot
  private lastDir = new Map<string, { x: number; z: number }>(); // last movement dir, for dash

  onCreate() {
    this.setState(new GameState());

    this.onMessage("input", (client, data: Input) => {
      // normalize so diagonal isn't faster
      let { dx, dz } = data ?? { dx: 0, dz: 0 };
      const len = Math.hypot(dx, dz);
      if (len > 1) { dx /= len; dz /= len; }
      this.inputs.set(client.sessionId, { dx, dz });
    });

    this.onMessage("attack", (client) => this.handleAttack(client.sessionId));

    this.onMessage("ability", (client, data: { slot: number }) =>
      this.handleAbility(client.sessionId, data?.slot));

    this.onMessage("evolve", (client) => this.handleEvolve(client.sessionId));

    this.onMessage("startWave", () => {
      if (this.state.phase === "playing" && this.state.betweenWaves && !this.state.gameOver) {
        this.state.gold += EARLY_START_BONUS;
        this.startWave();
      }
    });

    this.onMessage("buildTower", (_client, data: { x: number; z: number }) =>
      this.handleBuildTower(data));

    this.onMessage("upgradeTower", (_client, data: { id: string }) =>
      this.handleUpgradeTower(data));

    // --- Lobby ---
    this.onMessage("setName", (client, data: { name: string }) => {
      const p = this.state.players.get(client.sessionId);
      if (p && typeof data?.name === "string") p.name = data.name.slice(0, 16) || p.name;
    });
    this.onMessage("ready", (client, data: { ready: boolean }) => {
      const p = this.state.players.get(client.sessionId);
      if (p) p.ready = !!data?.ready;
    });
    this.onMessage("startGame", () => {
      this.tryAutoStart();
    });

    // Fixed simulation tick.
    this.setSimulationInterval((deltaMs) => this.update(deltaMs / 1000));
  }

  onJoin(client: Client) {
    const p = new Player();
    // fan players out around the target
    const i = this.state.players.size;
    p.x = Math.cos(i) * 4;
    p.z = Math.sin(i) * 4 + 6;
    p.name = `Player ${i + 1}`;
    for (const ab of ABILITIES) p.cds.set(ab.key, 0);
    p.cds.set("attack", 0);
    this.state.players.set(client.sessionId, p);
    this.inputs.set(client.sessionId, { dx: 0, dz: 0 });
    this.lastDir.set(client.sessionId, { x: 0, z: 1 }); // default facing +z (matches client)
  }

  private tryAutoStart() {
    if (this.state.phase !== "lobby") return;
    const players = [...this.state.players.values()];
    if (players.length === 0 || !players.every((p) => p.ready)) return;
    this.startGame();
  }

  private startGame() {
    this.state.phase = "playing";
    // begin the first wave countdown fresh
    this.state.betweenWaves = true;
    this.countdown = WAVE_GAP;
    this.state.nextWaveIn = Math.ceil(WAVE_GAP);
  }

  onLeave(client: Client) {
    this.state.players.delete(client.sessionId);
    this.inputs.delete(client.sessionId);
    this.lastDir.delete(client.sessionId);
  }

  private handleEvolve(sessionId: string) {
    if (this.state.phase !== "playing" || this.state.gameOver) return;
    const p = this.state.players.get(sessionId);
    if (!p || p.evo >= EVO_MAX) return;
    const cost = EVO[p.evo - 1].upgradeCost;
    if (this.state.gold < cost) return;
    this.state.gold -= cost;
    p.evo += 1;
  }

  private handleAbility(sessionId: string, slot: number) {
    if (this.state.phase !== "playing" || this.state.gameOver) return;
    const p = this.state.players.get(sessionId);
    const ab = ABILITIES[slot];
    if (!p || !ab) return;
    if ((p.cds.get(ab.key) ?? 0) > 0) return; // on cooldown

    const stage = EVO[p.evo - 1];
    if (ab.key === "whirlwind") {
      const r2 = stage.whirlRadius * stage.whirlRadius;
      for (let i = this.state.enemies.length - 1; i >= 0; i--) {
        const e = this.state.enemies[i];
        if ((e.x - p.x) ** 2 + (e.z - p.z) ** 2 <= r2) this.damageEnemy(i, stage.whirlDmg);
      }
    } else if (ab.key === "dash") {
      const d = this.lastDir.get(sessionId) ?? { x: 0, z: 1 };
      p.x = clamp(p.x + d.x * stage.dash, -ARENA, ARENA);
      p.z = clamp(p.z + d.z * stage.dash, -ARENA, ARENA);
    }
    p.cds.set(ab.key, ab.cooldown);
  }

  private startWave() {
    this.state.betweenWaves = false;
    this.state.wave += 1;
    this.spawnQueue = 3 + this.state.wave;  // creeps scale with wave
    this.spawnTimer = 0;
    this.state.nextWaveIn = 0;
  }

  private pickKind(): EnemyKind {
    const wave = this.state.wave;
    // weighted mix; tougher kinds unlock as waves progress
    const weights: [EnemyKind, number][] = [
      ["grunt", 6],
      ["runner", wave >= 3 ? 3 : 0],
      ["tank", wave >= 5 ? 2 : 0],
    ];
    const total = weights.reduce((s, [, w]) => s + w, 0);
    let r = Math.random() * total;
    for (const [kind, w] of weights) { if ((r -= w) < 0) return kind; }
    return "grunt";
  }

  private spawnEnemy() {
    const e = new Enemy();
    e.id = `e${this.enemySeq++}`;
    e.kind = this.pickKind();
    const k = ENEMY_KINDS[e.kind as EnemyKind];
    // spawn on a random edge of the arena
    const edge = Math.floor(Math.random() * 4);
    const t = (Math.random() * 2 - 1) * ARENA;
    if (edge === 0) { e.x = -ARENA; e.z = t; }
    else if (edge === 1) { e.x = ARENA; e.z = t; }
    else if (edge === 2) { e.x = t; e.z = -ARENA; }
    else { e.x = t; e.z = ARENA; }
    e.hp = k.baseHp + this.state.wave * k.hpPerWave;
    e.maxHp = e.hp;
    this.state.enemies.push(e);
  }

  private handleAttack(sessionId: string) {
    if (this.state.phase !== "playing" || this.state.gameOver) return;
    const p = this.state.players.get(sessionId);
    if (!p) return;
    if ((p.cds.get("attack") ?? 0) > 0) return; // swing cooldown

    // facing = last movement direction
    const dir = this.lastDir.get(sessionId) ?? { x: 0, z: 1 };
    const dl = Math.hypot(dir.x, dir.z) || 1;
    const fx = dir.x / dl, fz = dir.z / dl;
    const reach = ATTACK_RANGE * (1 + (p.evo - 1) * 0.25); // matches telegraph (evo-scaled)
    const dmg = EVO[p.evo - 1].atk;

    // cleave: hit every creep whose *body* overlaps the frontal swing arc
    for (let i = this.state.enemies.length - 1; i >= 0; i--) {
      const e = this.state.enemies[i];
      const half = (ENEMY_KINDS[e.kind as EnemyKind]?.size ?? 1) / 2;
      const ex = e.x - p.x, ez = e.z - p.z;
      const d = Math.hypot(ex, ez);
      if (d - half > reach) continue;                 // body within radial reach
      if (d < 1e-3) { this.damageEnemy(i, dmg); continue; } // standing on us
      const ang = Math.acos(Math.max(-1, Math.min(1, (ex / d) * fx + (ez / d) * fz)));
      const angTol = Math.asin(Math.min(1, half / d)); // body's angular half-width
      if (ang <= ATTACK_HALF_ANGLE + angTol) this.damageEnemy(i, dmg);
    }
    p.cds.set("attack", ATTACK_CD);
  }

  // Apply damage to an enemy by index; on death remove it and award its gold.
  private damageEnemy(index: number, dmg: number) {
    const e = this.state.enemies[index];
    if (!e) return;
    e.hp -= dmg;
    if (e.hp <= 0) {
      this.state.enemies.splice(index, 1);
      this.state.gold += ENEMY_KINDS[e.kind as EnemyKind].gold;
    }
  }

  private handleBuildTower(data: { x: number; z: number }) {
    if (this.state.gameOver) return;
    if (this.state.gold < TOWER_COST) return;
    const x = clamp(data?.x ?? 0, -ARENA, ARENA);
    const z = clamp(data?.z ?? 0, -ARENA, ARENA);
    // keep clear of the target (origin) and other towers
    if (Math.hypot(x, z) < TOWER_MIN_GAP) return;
    for (const t of this.state.towers) {
      if (Math.hypot(t.x - x, t.z - z) < TOWER_MIN_GAP) return;
    }
    const t = new Tower();
    t.id = `t${this.towerSeq++}`;
    t.x = x;
    t.z = z;
    t.level = 1;
    this.state.towers.push(t);
    this.towerCooldowns.set(t.id, 0);
    this.state.gold -= TOWER_COST;
  }

  private handleUpgradeTower(data: { id: string }) {
    if (this.state.gameOver) return;
    const t = this.state.towers.find((tw) => tw.id === data?.id);
    if (!t || t.level >= TOWER_MAX_LEVEL) return;
    const cost = TOWER_UPGRADE_COST[t.level - 1];
    if (this.state.gold < cost) return;
    this.state.gold -= cost;
    t.level += 1;
  }

  private updateTowers(dt: number) {
    for (const t of this.state.towers) {
      const stats = TOWER_LEVELS[t.level - 1];
      let cd = (this.towerCooldowns.get(t.id) ?? 0) - dt;
      if (cd > 0) { this.towerCooldowns.set(t.id, cd); continue; }
      // fire at nearest creep in range
      let best = -1, bestD = stats.range * stats.range;
      this.state.enemies.forEach((e, idx) => {
        const d = (e.x - t.x) ** 2 + (e.z - t.z) ** 2;
        if (d <= bestD) { bestD = d; best = idx; }
      });
      if (best < 0) { this.towerCooldowns.set(t.id, 0); continue; }
      this.damageEnemy(best, stats.dmg);
      this.towerCooldowns.set(t.id, stats.interval);
    }
  }

  private update(dt: number) {
    if (this.state.phase !== "playing" || this.state.gameOver) return;

    // move players from their last input + tick ability cooldowns
    this.state.players.forEach((p, id) => {
      const inp = this.inputs.get(id);
      if (inp) {
        const speed = EVO[p.evo - 1].speed;
        p.x = clamp(p.x + inp.dx * speed * dt, -ARENA, ARENA);
        p.z = clamp(p.z + inp.dz * speed * dt, -ARENA, ARENA);
        if (inp.dx !== 0 || inp.dz !== 0) this.lastDir.set(id, { x: inp.dx, z: inp.dz });
      }
      p.cds.forEach((v, k) => {
        if (v > 0) p.cds.set(k, Math.max(0, v - dt));
      });
    });

    // spawn pacing within an active wave
    if (!this.state.betweenWaves && this.spawnQueue > 0) {
      this.spawnTimer -= dt;
      if (this.spawnTimer <= 0) {
        this.spawnEnemy();
        this.spawnQueue -= 1;
        this.spawnTimer = 0.6;
      }
    }

    // move enemies toward the target at origin
    for (let i = this.state.enemies.length - 1; i >= 0; i--) {
      const e = this.state.enemies[i];
      const k = ENEMY_KINDS[e.kind as EnemyKind] ?? ENEMY_KINDS.grunt;
      const dx = -e.x, dz = -e.z;
      const len = Math.hypot(dx, dz) || 1;
      if (len < 0.6) {
        this.state.enemies.splice(i, 1);
        this.state.targetHp -= k.dmg ?? TARGET_DAMAGE;
        if (this.state.targetHp <= 0) {
          this.state.targetHp = 0;
          this.state.gameOver = true;
        }
      } else {
        e.x += (dx / len) * k.speed * dt;
        e.z += (dz / len) * k.speed * dt;
      }
    }

    // towers auto-fire at creeps in range
    this.updateTowers(dt);

    // wave lifecycle: when cleared, count down to the next
    if (!this.state.betweenWaves && this.spawnQueue === 0 && this.state.enemies.length === 0) {
      this.state.betweenWaves = true;
      this.countdown = WAVE_GAP;
    }
    if (this.state.betweenWaves) {
      this.countdown -= dt;
      this.state.nextWaveIn = Math.max(0, Math.ceil(this.countdown));
      if (this.countdown <= 0) this.startWave();
    }
  }
}

function clamp(v: number, lo: number, hi: number) {
  return v < lo ? lo : v > hi ? hi : v;
}
