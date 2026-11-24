import type { Server as HttpServer } from 'node:http';
import { jsonCodec } from '@game/shared';
import type { Logger } from 'pino';
import { WebSocket, type WebSocketServer } from 'ws';
import type { RoomManager } from './room.ts';

export interface GracefulShutdownController {
  readonly isShuttingDown: () => boolean;
  readonly trigger: (signal: string) => Promise<void>;
}

export function createGracefulShutdown(params: {
  httpServer: HttpServer;
  wss: WebSocketServer;
  roomManager: RoomManager;
  logger: Logger;
  forceTimeoutMs?: number;
  onExit?: (code: number) => void;
}): GracefulShutdownController {
  let shuttingDown = false;
  let shutdownPromise: Promise<void> | null = null;
  const forceTimeoutMs = params.forceTimeoutMs ?? 8000;
  const exitFn = params.onExit ?? ((code: number) => process.exit(code));

  const trigger = (signal: string): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    shuttingDown = true;

    shutdownPromise = (async () => {
      params.logger.info({ event: 'server.shutdown_start', signal }, 'Graceful shutdown initiated');

      const forceTimer = setTimeout(() => {
        params.logger.error({ event: 'server.shutdown_timeout' }, 'Forced exit after grace timeout');
        params.logger.flush();
        exitFn(1);
      }, forceTimeoutMs);
      forceTimer.unref();

      const shutdownPayload = jsonCodec.encodeServer({
        type: 'shutdown',
        reason: 'Server restarting',
        reconnectMs: 1500,
      });

      const closePromises: Promise<void>[] = [];
      for (const client of params.wss.clients) {
        if (client.readyState === WebSocket.OPEN) {
          try {
            client.send(shutdownPayload);
          } catch {
            // Ignore write failures during shutdown
          }
          closePromises.push(
            new Promise<void>((resolve) => {
              const t = setTimeout(() => {
                client.terminate();
                resolve();
              }, 1000);
              t.unref();
              client.once('close', () => {
                clearTimeout(t);
                resolve();
              });
              client.close(1001, 'Server shutting down');
            }),
          );
        } else if (client.readyState === WebSocket.CONNECTING) {
          client.terminate();
        }
      }

      await Promise.all(closePromises);
      params.roomManager.stopAllRooms();

      await new Promise<void>((resolve) => {
        params.wss.close(() => resolve());
      });

      await new Promise<void>((resolve) => {
        params.httpServer.close(() => resolve());
      });

      clearTimeout(forceTimer);
      params.logger.info({ event: 'server.shutdown_complete', signal }, 'Server exited cleanly');
      params.logger.flush();
      exitFn(0);
    })();

    return shutdownPromise;
  };

  return {
    isShuttingDown: () => shuttingDown,
    trigger,
  };
}
