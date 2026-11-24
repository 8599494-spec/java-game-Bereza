import { loadConfig } from './config.js';
import { createAppServer } from './httpServer.js';
import { NetworkSimulator } from './netSim.js';
import { RoomManager } from './room.js';
import { attachWebSocketServer } from './wsServer.js';

const config = loadConfig();
const netSim = new NetworkSimulator(config.defaultNetSim);
const roomManager = new RoomManager(config, netSim);

let wsController = null;
const server = createAppServer(config, roomManager, netSim, () => wsController?.getClientCount() ?? 0);
wsController = attachWebSocketServer(server, roomManager, config, netSim);

server.listen(config.port, () => {
  console.log(`[Server] Listening on http://localhost:${config.port}`);
  console.log(`[Server] Logs dir: ${config.logDir}`);
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[Server] Received ${signal}. Closing sockets, flushing logs...`);

  const forceExit = setTimeout(() => {
    console.error('[Server] Forced exit after timeout');
    process.exit(1);
  }, 5000);
  forceExit.unref();

  try {
    await wsController.closeAll();
    await roomManager.closeAll();
    await new Promise((resolve) => server.close(() => resolve()));
    console.log('[Server] Shutdown complete.');
    process.exit(0);
  } catch (err) {
    console.error('[Server] Error during shutdown:', err);
    process.exit(1);
  }
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
