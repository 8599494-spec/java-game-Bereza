import { loadServerConfig } from './config.ts';
import { createGameHttpServer } from './httpServer.ts';
import { RoomManager } from './room.ts';
import { attachWebSocketServer } from './wsServer.ts';

const config = loadServerConfig();
const roomManager = new RoomManager(config);
const httpServer = createGameHttpServer(roomManager);
const wss = attachWebSocketServer(httpServer, roomManager, config);

httpServer.listen(config.PORT, config.HOST, () => {
  console.log(`[Server] Listening on http://localhost:${config.PORT}`);
});

function shutdown(signal: string): void {
  console.log(`[Server] Received ${signal}, shutting down...`);
  wss.close();
  httpServer.close(() => {
    process.exit(0);
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
