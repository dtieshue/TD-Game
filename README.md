# TD-Game

Multiplayer co-op tower defense (web-native). See [DESIGN.md](DESIGN.md) for the living design — it is the single source of truth and is kept current with every change.

## Repo layout — versioned folders
```
TD-Game/
├── DESIGN.md      # living design doc (spans all versions)
├── v1/            # ACTIVE version — current code (self-contained monorepo)
│   ├── client/    # Three.js + Vite + TS
│   └── server/    # Colyseus authoritative server
├── v2/            # next version, when started
└── Archive/       # RETIRED versions — frozen snapshots
```

- **Active version** = the highest-numbered `vN/` folder. Work happens there.
- **Retiring a version:** move it into `Archive/` (e.g. `Archive/v1/`) and start the next `vN/`.
- **Archive is frozen context:** archived folders are NOT read or considered during normal work. They are only reviewed when explicitly requested.

## Run the active version
```
cd v1
npm install     # once
npm run dev      # server :2567 + client :5173
```
Open http://localhost:5173.
