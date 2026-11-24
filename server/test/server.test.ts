import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ARENA,
  asEntityId,
  asRadians,
  asRoomId,
  asSeq,
  asTick,
  createWorldState,
  FIXED_DT,
  setVec2,
  TICK_RATE,
} from '../../shared/src/index.ts';
import { BotController } from '../src/bot.ts';
import { loadServerConfig } from '../src/config.ts';
import { TypedEventEmitter } from '../src/events.ts';
import { createGameHttpServer } from '../src/httpServer.ts';
import { AuthoritativeMatch } from '../src/match.ts';
import { NetworkSimulator } from '../src/netSim.ts';
import { GameRoom, RoomManager } from '../src/room.ts';

afterEach(() => {
  vi.useRealTimers();
});

describe('Server configuration & TypedEventEmitter', () => {
  it('loads default server config when environment variables are omitted', () => {
    const cfg = loadServerConfig({});
    expect(cfg.PORT).toBe(3000);
    expect(cfg.HOST).toBe('0.0.0.0');
    expect(cfg.MAX_PLAYERS_PER_ROOM).toBe(160);
  });

  it('throws descriptive error when environment configuration is invalid', () => {
    expect(() => loadServerConfig({ PORT: '99999' })).toThrow(/Invalid server environment/);
  });

  it('delivers typed events and unsubscribes cleanly', () => {
    const bus = new TypedEventEmitter<{ ping: { count: number } }>();
    const received: number[] = [];
    const off = bus.on('ping', (p) => received.push(p.count));

    bus.emit('ping', { count: 1 });
    off();
    bus.emit('ping', { count: 2 });

    expect(received).toEqual([1]);
  });
});

describe('AuthoritativeMatch loop with fake timers', () => {
  it('advances simulation ticks at 30 Hz when timers advance', () => {
    vi.useFakeTimers();
    const receivedTicks: number[] = [];
    const match = new AuthoritativeMatch(123, (_shipId, snap) => {
      receivedTicks.push(snap.tick);
    });

    match.addPlayer(asEntityId(1), 'Alpha');
    match.start();
    expect(match.isRunning).toBe(true);

    vi.advanceTimersByTime(1000);
    match.stop();
    expect(match.isRunning).toBe(false);
    expect(receivedTicks.length).toBeGreaterThanOrEqual(28);
    expect(receivedTicks.length).toBeLessThanOrEqual(31);
  });

  it('processes queued player inputs and records tick timing percentiles', () => {
    const match = new AuthoritativeMatch(456, () => {});
    const p1 = asEntityId(1);
    match.addPlayer(p1, 'Pilot');
    const ship = match.world.ships[0];
    expect(ship).toBeDefined();
    if (!ship) return;

    const startX = ship.pos.x;
    match.queueInput(p1, {
      type: 'input',
      seq: asSeq(7),
      tick: asTick(0),
      thrust: true,
      turn: 0,
      fire: false,
      fireHoming: false,
    });
    match.stepOnce();

    expect(ship.lastProcessedSeq).toBe(asSeq(7));
    expect(ship.pos.x).toBeGreaterThan(startX);

    const stats = match.getTickStats();
    expect(stats.sampleCount).toBe(1);
    expect(stats.p99Ms).toBeGreaterThanOrEqual(0);
  });
});

describe('BotController AI', () => {
  it('produces valid InputMessage aiming and firing at nearby enemy ship', () => {
    const world = createWorldState({ seed: 7, asteroidCount: 0 });
    const botId = asEntityId(1);
    const enemyId = asEntityId(2);
    const match = new AuthoritativeMatch(7, () => {});
    match.world.asteroids.length = 0;
    match.addPlayer(botId, 'Bot-1');
    match.addPlayer(enemyId, 'Human');

    const botShip = match.world.ships[0];
    const enemyShip = match.world.ships[1];
    expect(botShip).toBeDefined();
    expect(enemyShip).toBeDefined();
    if (!botShip || !enemyShip) return;

    setVec2(botShip.pos, 200, 300);
    botShip.angle = asRadians(0);
    setVec2(enemyShip.pos, 420, 300);

    const bot = new BotController(botId, 'Bot-1');
    const input = bot.computeInput(match.world, asTick(1));

    expect(input.type).toBe('input');
    expect(input.fire).toBe(true);
    expect(Math.abs(input.turn)).toBeLessThan(0.1);
    expect(world.tick).toBe(asTick(0));
  });

  it('evades nearby asteroids instead of firing blindly', () => {
    const match = new AuthoritativeMatch(8, () => {});
    const botId = asEntityId(1);
    match.addPlayer(botId, 'Bot-1');
    const botShip = match.world.ships[0];
    const ast = match.world.asteroids[0];
    expect(botShip).toBeDefined();
    expect(ast).toBeDefined();
    if (!botShip || !ast) return;

    setVec2(botShip.pos, 400, 300);
    botShip.angle = asRadians(0);
    setVec2(ast.pos, 435, 300);

    const bot = new BotController(botId, 'Bot-1');
    const input = bot.computeInput(match.world, asTick(2));
    expect(input.thrust).toBe(true);
    expect(input.fire).toBe(false);
    expect(ARENA.width).toBe(900);
    expect(FIXED_DT).toBeCloseTo(1 / TICK_RATE, 5);
  });
});

describe('NetworkSimulator & GameRoom', () => {
  it('delays packet delivery according to configured latency', () => {
    vi.useFakeTimers();
    const sim = new NetworkSimulator({ latencyMs: 80, jitterMs: 0, dropRate: 0 });
    let delivered = false;
    sim.schedule(() => {
      delivered = true;
    });
    expect(delivered).toBe(false);
    vi.advanceTimersByTime(79);
    expect(delivered).toBe(false);
    vi.advanceTimersByTime(2);
    expect(delivered).toBe(true);
    sim.dispose();
  });

  it('spawns and clears bots in GameRoom and reports room stats', async () => {
    const cfg = loadServerConfig({ MAX_PLAYERS_PER_ROOM: '16' });
    const manager = new RoomManager(cfg);
    const room = manager.getOrCreateRoom('TestArena', false);

    expect(room.id).toBe(asRoomId('TestArena'));
    const added = room.spawnBots(8);
    expect(added).toBe(8);
    expect(room.botCount).toBe(8);

    room.match.stepOnce();
    const stats = manager.getStats();
    expect(stats.rooms).toBe(1);
    expect(stats.bots).toBe(8);

    const removed = room.clearBots();
    expect(removed).toBe(8);
    expect(room.botCount).toBe(0);
  });

  it('serves /api/stats and POST /api/rooms/:id/bots over HTTP', async () => {
    const cfg = loadServerConfig({});
    const manager = new RoomManager(cfg);
    const server = createGameHttpServer(manager);

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${addr.port}`;

    try {
      const spawnRes = await fetch(`${baseUrl}/api/rooms/Alpha/bots`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ count: 4 }),
      });
      expect(spawnRes.status).toBe(200);
      const spawnJson = (await spawnRes.json()) as { ok: boolean; added: number; totalBots: number };
      expect(spawnJson.ok).toBe(true);
      expect(spawnJson.added).toBe(4);

      const statsRes = await fetch(`${baseUrl}/api/stats`);
      expect(statsRes.status).toBe(200);
      const statsJson = (await statsRes.json()) as { ok: boolean; bots: number; rssMB: number };
      expect(statsJson.ok).toBe(true);
      expect(statsJson.bots).toBe(4);
      expect(statsJson.rssMB).toBeGreaterThan(0);

      const delRes = await fetch(`${baseUrl}/api/rooms/Alpha/bots`, { method: 'DELETE' });
      expect(delRes.status).toBe(200);
    } finally {
      const room = manager.getRoom('Alpha');
      room?.match.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});