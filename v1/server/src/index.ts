import { Server } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { GameRoom } from "./GameRoom.js";

const PORT = Number(process.env.PORT) || 2567;

const gameServer = new Server({
  transport: new WebSocketTransport(),
});

gameServer.define("game", GameRoom);

gameServer.listen(PORT);
console.log(`[td-server] listening on ws://localhost:${PORT}`);
