import { loadServerConfig } from './config.ts';
import { createGameHttpServer } from './httpServer.ts';
import { createLogger } from './logger.ts';
import { gameMetrics } from './metrics.ts';
import { RoomManager } from './room.ts';
import { createGracefulShutdown } from './shutdown.ts';
import { attachWebSocketServer } from './wsServer.ts';

const config = loadServerConfig();
const logger = createLogger(config);

let shuttingDown = false;
const lifecycle = {
  isShuttingDown: () => shuttingDown,
};

const roomManager = new RoomManager(config, logger, gameMetrics);
const httpServer = createGameHttpServer(roomManager, {
  config,
  lifecycle,
  logger,
  metrics: gameMetrics,
});
const wss = attachWebSocketServer(httpServer, roomManager, config, {
  lifecycle,
  logger,
  metrics: gameMetrics,
});

const shutdownController = createGracefulShutdown({
  httpServer,
  wss,
  roomManager,
  logger,
  forceTimeoutMs: 8000,
});

httpServer.listen(config.PORT, config.HOST, () => {
  logger.info(
    {
      event: 'server.listening',
      host: config.HOST,
      port: config.PORT,
      nodeEnv: config.NODE_ENV,
      allowedOrigins: config.ALLOWED_ORIGINS,
    },
    `Listening on http://${config.HOST}:${config.PORT}`,
  );
});

function handleSignal(signal: string): void {
  shuttingDown = true;
  void shutdownController.trigger(signal);
}

process.on('SIGINT', () => handleSignal('SIGINT'));
process.on('SIGTERM', () => handleSignal('SIGTERM'));

process.on('uncaughtException', (err: Error) => {
  logger.fatal({ event: 'process.uncaught_exception', err }, 'Uncaught exception — exiting');
  logger.flush();
  process.exit(1);
});

process.on('unhandledRejection', (reason: unknown) => {
  logger.fatal({ event: 'process.unhandled_rejection', reason }, 'Unhandled rejection — exiting');
  logger.flush();
  process.exit(1);
});
