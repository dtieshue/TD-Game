# TD-Game — Design Document

> Status: **Draft for review** · Last updated 2026-06-14
> Review notes: leave comments inline or tell Claude what to change.

---

## 1. Vision
Multiplayer co-op tower defense. Players defend multiple targets scattered across a 2.5D bird's-eye map against escalating waves of enemies. Each player controls a **Champion** (3rd-person combat) and a **Build** layer (top-down planning). **Browser-first, day-one playable** — friends click a link and play together. Steam ships later.

---

## 2. Pillars (what makes it good)
- **Two minds at once** — micro your champion *and* plan your defenses.
- **Co-op coordination** — shared map, shared targets, shared economy decisions.
- **Easy in, deep out** — click a link to play; champion mastery + builds add depth.
- **Swappable everything** — champions, towers, enemies, maps defined in config so content scales without engine work.

---

## 3. Tech Stack (decided)
| Layer | Choice | Why |
|---|---|---|
| Language | **TypeScript** | One language client + server; large talent pool |
| Rendering | **Three.js** | Lightweight 2.5D, instant browser play *(Babylon.js = fallback if more tooling wanted)* |
| Multiplayer | **Colyseus** (Node.js) | Authoritative server; rooms = matches; built for this |
| Content data | **JSON config** | Data-driven champions/towers/enemies/waves; asset-swap for free |
| Dev loop | `npm run dev` → localhost, ~1s hot reload | Fast iteration, no build step to test |
| Steam (later) | **Electron/Tauri** wrapper | Same web build, deferred |

**Server-authoritative** from the start (anti-cheat + sync correctness).

---

## 4. Core Loop
Plan (Build view) → Defend (Champion view) → earn Gold on hits/kills → spend between waves → survive next wave → repeat → win on final wave / lose if targets fall.

- **Plan phase** — building enabled, between waves.
- **Battle phase** — building locked, champions active.
- Toggle button swaps Build ↔ Champion view.

---

## 5. Views
- **Build view** — top-down full map. Place/upgrade towers, inspect paths, manage economy.
- **Champion view** — 3rd-person follow cam. Direct champion control in combat.

---

## 6. Match Structure
- **Players:** 1–4 co-op (PvE). Join via **lobby**. PvP/ranked = later.
- **Mode:** **Endless** — one wave at a time, escalating, until targets fall. No win condition yet; score = waves survived.
- **Early-start bonus:** players can trigger the next wave before the timer; doing so grants **extra Gold** (reward for risk/tempo).
- **Lose:** combined target HP → 0.
- **Currencies:**
  - **Gold** — in-match, from hits/kills + early-start bonus; spent on towers + champion evolutions.
  - **Meta XP** — persistent; unlocks champions + cosmetics.

---

## 7. Champions
- **Archetypes:** Tank, Bruiser, Assassin, Marksman, Mage, Healer.
- Each champion: **1 basic attack**, **3–4 abilities**, **2–3 evolution stages** (chosen mid-match via Gold/level).
- **Unlock:** per-champion criteria (XP, achievements, currency).
- **Select:** carousel UI.
- **Defined in JSON** (stats, abilities, asset refs) → new champions added without code changes.

### Starting roster
- **Knight** (Bruiser) — the only champion for now. **Keep mechanics minimal:** move + 1 melee basic attack. Abilities/evolutions deferred. **No graphics** — render as a placeholder primitive (capsule/cube).

---

## 8. Towers / Defense
- Built structures, separate from champion. Types: single-target, AoE, slow, support/buff.
- Upgrade tiers; limited build slots + Gold cost.
- Designed to **complement** champions, not duplicate them.

---

## 9. Enemies (Creeps)
- Tiers: basic, fast, armored, flying, shielded, boss.
- Spawn in waves; pathfind to nearest target; grant Gold + XP.
- Stats scale per wave via config.

---

## 10. Maps
- 2.5D bird's-eye. Multiple fixed defended targets; lane/path network to each.
- Marked buildable zones vs. path zones.
- Start with 1–2 maps.

---

## 11. Progression / Meta
- Account level, champion unlocks, cosmetic skins, per-champion mastery.

## 11a. Art Direction
- **Style:** fun, bright, cute fantasy. Reference: *Boomerang Fu* vibe but more detailed/graphic.
- Readable top-down silhouettes; saturated palette; chunky, friendly shapes.
- **Deferred** — placeholder primitives now; this guides assets when added.

## 11b. Monetization *(tabled — not official)*
- Likely direction only: cosmetics + champion unlocks (possibly more). No mechanics committed.

---

## 12. Data / Asset-Swap Model
- All content = JSON definitions + asset references (model/sprite/sound).
- Placeholder primitives (cubes/capsules) now; real assets dropped in by swapping refs, no code change.

---

## 12a. Implementation Status & How to Run
**Milestone 1 — built & verified ✓** (npm-workspaces monorepo)
- `server/` — Colyseus authoritative server (`@colyseus/core` + `ws-transport`, schema in `server/src/schema.ts`, logic in `GameRoom.ts`). Endless waves, early-start +25g, server-authoritative movement, melee attack, target HP / lose.
- `client/` — Three.js + Vite + TS (`client/src/main.ts`). Angled top-down scene; Knight = capsule, creeps = boxes, target = cylinder; HUD shows wave/gold/HP + early-start button.
- Knight has **no abilities/graphics yet** (placeholder primitive) — matches §7.

**Milestone 2 — built & verified ✓** (towers + build view)
- **Build ↔ Champion view toggle** — `modeBtn` button + `B` key. Champion = angled 2.5D cam; Build = straight top-down plan cam with a purple screen tint.
- **Towers** — in Build view, click the ground to place a tower (cost **30g**, min spacing 2.5, must clear the target). Server-simulated auto-fire: range 7, 6 dmg, 0.7s interval; kills award gold. Rendered as purple cones. Tuning lives in `GameRoom.ts`.
- Building is allowed any time for now (phase-gating to plan-phase is later, per §6).

**Milestone 3 — built & verified ✓** (creep tiers + tower upgrades)
- **Creep tiers** (`ENEMY_KINDS` in `GameRoom.ts`): **grunt** (balanced), **runner** (fast, low HP), **tank** (slow, high HP, hits target harder). Weighted spawn mix unlocks runners at wave 3, tanks at wave 5; HP scales per wave. Rendered with distinct color + size; HUD legend bottom-right.
- **Tower upgrades** — in Build view, click an existing tower to upgrade (levels 1→3, cost 25 then 40). Higher levels = more range/damage/fire-rate and a visibly larger cone (`TOWER_LEVELS`).
- Per-kind kill gold; tougher creeps pay more.

**Milestone 4 — built & verified ✓** (multiplayer lobby)
- Game starts in a **lobby** (`phase: lobby | playing` on state). Players get a default name, can **rename**, and **ready up**; the **Start game** button only works when *every* connected player is ready. Up to 4 players (drop-in co-op join mid-game also works).
- Waves/sim are gated on `phase === "playing"` — nothing spawns until the game starts.
- Client: full-screen lobby overlay (`#lobby`) listing players + live ready status, refreshed each frame from `room.state.players` via a change-signature guard (top-level `state.onChange` doesn't fire on nested map joins). `window.__room` exposed as a dev inspection handle.

**Milestone 5 (part 1) — built & verified ✓** (Knight abilities)
- Two server-authoritative actives (data-driven `ABILITIES` in `GameRoom.ts`): **Q = Whirlwind** (AoE damage around the Knight) and **E = Dash** (instant ~9-unit reposition in the last move direction). Basic attack (click) unchanged.
- **Cooldowns** per ability, shown in a bottom-center ability bar with a countdown overlay. Cooldown state lives in a `MapSchema<number>` on Player keyed by ability — **note:** an `ArraySchema<number>` element-assignment did *not* sync reliably under this runtime; `MapSchema.set` does.
**Milestone 5 (part 2) — built & verified ✓** (Knight evolutions)
- Per-player champion **evolution**, 3 stages (`EVO` table in `GameRoom.ts`, `Player.evo`). **Evolve** button spends shared gold (50 → 110) to advance a stage; each stage raises attack, Whirlwind damage/radius, Dash distance, and move speed. The Knight mesh grows 25%/stage and the Whirlwind ring scales with it.
- Verified headless: evolve costs 50 (70→20g), stage 1→2, Dash distance grew 9→11, blocked when gold insufficient.
- Remaining for §5: champion-select carousel, unlocks, 2nd map.

**Milestone 5 (part 3) — built & verified ✓** (Knight v1 art + animation)
- The Knight is now a **procedural figure** (Three.js primitives, no external assets) — plate torso + belt, visored helmet with gold plume, sword in the right hand, emblemed shield on the left. Team-colored (blue = you, red = others). Built in `makeKnight()` in `client/src/main.ts`; origin at the feet so evo scaling stays grounded.
- **Animation** (in `updateKnights()`, no server change): the render position is **interpolated** toward the server position each frame (server only patches ~20Hz, so raw positions slide in discrete steps). Walk speed + facing are derived from that smoothed, low-passed velocity — driving a leg/arm swing walk cycle, idle breathing bob, and turn-to-face. *(Earlier version derived velocity from raw per-frame deltas, which were ~0 between patches → no walk cycle + sliding/twirling; interpolation fixed it.)*
- **Ability FX** driven by cooldown changes (so they play for *all* players): Whirlwind = spin + arms flung out + expanding ring (scales with evo); Dash = fading after-image trail. `window.__room` / `window.__camera` left as dev inspection handles.

**Basic attack — directional hitbox + swing ✓**
- The basic attack is now a **frontal arc cleave** (server-authoritative): hits every creep within `ATTACK_RANGE` (3.6) *and* inside a ±60° cone in the Knight's facing direction (last movement dir), with a 0.35s swing cooldown. Replaces the old "nearest creep in a circle around you". Facing default unified to +z on client & server.
- **Swing animation**: overhead sword chop (right arm). Fires instantly on the local player's click; remote players' swings trigger from the attack-cooldown change. A fading ground **sector telegraph** shows the exact hitbox.
- Verified headless: a creep in front is hit (3/3 attempts); creeps in range but outside the arc are never hit (0/8); cooldown enforced.
- **Hitbox/damage alignment:** the damage area is now matched to the shown telegraph — range **scales with evo** (×1.25/stage, same as the telegraph) and hits a creep when its **body overlaps** the arc (range check uses `distance − creepHalfSize`, arc widened by the creep's angular half-width). Creep `size` added to `ENEMY_KINDS`. Verified: damage == body-overlap-of-telegraph (12/12), behind-creeps still never hit (0).

**Repo uses versioned folders** (see [README](README.md)): active code lives in `v1/`; retired versions move to `Archive/` (frozen, excluded from context).

**Run it:**
```
cd v1
npm install          # once
npm run dev          # server :2567 + client :5173 together
```
Open http://localhost:5173. Multiplayer test: share a tunnel (e.g. `ngrok http 5173` + run the client with `?server=wss://<tunnel-for-2567>`), or same-LAN via the host IP.

**Verified:** scene renders (browser screenshot), client↔server connect + join, movement (server-clamped to arena), early-start bonus, wave spawn scaling, attack→kill→gold, target damage path; **M2:** view toggle, top-down build cam + tint, tower build (cost/spacing/target-clearance rules), tower auto-fire kills creeps for gold; **M3:** tier spawn unlocks (runner@3, tank@5), per-kind stats/gold, tower upgrade 1→3 (cost + bigger cone); **M4:** lobby join/name/ready, start-gated on all-ready, waves only after start, live multi-player list — headless (2-client) + screenshot; **M5:** Whirlwind AoE (kills+gold), Dash (exact 9-unit reposition), cooldown set + synced to caster *and* remote reader, re-cast blocked on cd — headless (the preview automation tab can't drive these casts, but every real colyseus client does).

**Dev port note:** in dev the server is pinned to **2567** (client hardcodes that). Production `npm start` still honors `$PORT`. If you ever see "⚠ cannot reach server", the Colyseus server on 2567 isn't up — check for stale processes holding the port.

**Client sync note:** entity positions are read from `room.state` every render frame (in `syncMeshes()`), not via per-entity `onChange` callbacks — the latter silently no-op'd under colyseus 0.16's `getStateCallbacks`, which made everything render frozen at the origin. `onAdd`/`onRemove` only manage mesh creation/disposal.

## 13. Roadmap
1. ~~**Walking skeleton** — 1 map, controllable Knight (capsule), movement synced over Colyseus, creeps walking to a target, click-to-attack, endless waves + early-start.~~ **✓ Done** (see §12a).
2. ~~Build ↔ Champion view toggle + spend gold on auto-firing towers.~~ **✓ Done** (see §12a). *(wave spawner/economy/lose already landed in M1.)*
3. ~~Enemy variety (tiers) + tower upgrades.~~ **✓ Done** (see §12a).
4. ~~Lobby (up to 4 players join).~~ **✓ Done** (see §12a).
5. Champion expansion: ~~Knight abilities + cooldowns~~ **✓**, ~~evolutions~~ **✓**; remaining: carousel select + unlocks; 2nd map.
6. Polish, more content, Steam (Electron) build.
7. *(Optional)* PvP / ranked.

---

## 14. Decisions Log
- **Roster:** start with **Knight** (Bruiser), minimal mechanics, no graphics. ✓
- **Mode:** **Endless**, one wave at a time, early-start grants bonus Gold. ✓
- **Players:** up to **4**, lobby join; solo supported. ✓
- **Art:** bright cute fantasy, *Boomerang Fu*-but-richer. ✓ (assets deferred)
- **Monetization:** tabled (cosmetics/unlocks direction only). ✓

## 15. Hosting (recommendation — pending your pick)
Colyseus is an authoritative Node server, so it needs to run *somewhere* always-on.
- **Dev/now:** run locally (`npm run dev`) — friends test via a tunnel (e.g. `ngrok`). $0, instant.
- **Recommended early host: [Colyseus Cloud](https://colyseus.io/) or [Fly.io](https://fly.io).**
  - **Colyseus Cloud** — purpose-built for this exact server; least config, handles rooms/scaling. Easiest path.
  - **Fly.io** — general but cheap, global edge = low latency for real-time; more control. Good if you'd rather not lock into Colyseus's host.
- **Avoid for now:** serverless (Vercel/Lambda) — can't hold persistent game rooms.
- **Static client** (the Three.js build) → any CDN/static host (Netlify/Vercel/GitHub Pages); only the *game server* needs the above.

**Open:** pick Colyseus Cloud (simplest) vs Fly.io (flexible) when we deploy — no action needed until milestone 1 works locally.

---

*Tell Claude what to change and the doc + roadmap update accordingly.*
