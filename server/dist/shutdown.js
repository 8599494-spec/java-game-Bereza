import { jsonCodec } from '@game/shared';
import { WebSocket } from 'ws';
export function createGracefulShutdown(params) {
    let shuttingDown = false;
    let shutdownPromise = null;
    const forceTimeoutMs = params.forceTimeoutMs ?? 8000;
    const exitFn = params.onExit ?? ((code) => process.exit(code));
    const trigger = (signal) => {
        if (shutdownPromise)
            return shutdownPromise;
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
            const closePromises = [];
            for (const client of params.wss.clients) {
                if (client.readyState === WebSocket.OPEN) {
                    try {
                        client.send(shutdownPayload);
                    }
                    catch {
                        // Ignore write failures during shutdown
                    }
                    closePromises.push(new Promise((resolve) => {
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
                    }));
                }
                else if (client.readyState === WebSocket.CONNECTING) {
                    client.terminate();
                }
            }
            await Promise.all(closePromises);
            params.roomManager.stopAllRooms();
            await new Promise((resolve) => {
                params.wss.close(() => resolve());
            });
            await new Promise((resolve) => {
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
