import { Schema, MapSchema, ArraySchema, type } from "@colyseus/schema";

// One connected player's Knight. Position only — no graphics, server-authoritative.
export class Player extends Schema {
  @type("number") x = 0;
  @type("number") z = 0;
  @type("string") name = "Knight";
  @type("boolean") ready = false;
  @type("number") evo = 1; // champion evolution stage (1..3)
  @type({ map: "number" }) cds = new MapSchema<number>(); // ability key -> cooldown remaining (s)
}

// A creep walking toward the target.
export class Enemy extends Schema {
  @type("string") id = "";
  @type("string") kind = "grunt"; // grunt | runner | tank
  @type("number") x = 0;
  @type("number") z = 0;
  @type("number") hp = 10;
  @type("number") maxHp = 10;
}

// A player-built defensive tower (auto-fires at nearby creeps).
export class Tower extends Schema {
  @type("string") id = "";
  @type("number") x = 0;
  @type("number") z = 0;
  @type("number") level = 1; // 1..3
}

export class GameState extends Schema {
  @type({ map: Player }) players = new MapSchema<Player>();
  @type([Enemy]) enemies = new ArraySchema<Enemy>();
  @type([Tower]) towers = new ArraySchema<Tower>();

  @type("string") phase = "lobby";  // lobby | playing
  @type("number") targetHp = 100;   // shared objective HP
  @type("number") gold = 0;         // shared co-op economy
  @type("number") wave = 0;         // current wave number
  @type("number") nextWaveIn = 0;   // seconds until next wave (0 while a wave is active)
  @type("boolean") betweenWaves = true;
  @type("boolean") gameOver = false;
}
