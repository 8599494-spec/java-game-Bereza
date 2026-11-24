import { TICK_RATE, TokenBucketRateLimiter, asEntityId, asRoomId, binaryCodec, getCodec, } from '@game/shared';
import { BotController } from "./bot.js";
import { TypedEventEmitter } from "./events.js";
import { logger as defaultLogger } from "./logger.js";
import { AuthoritativeMatch } from "./match.js";
import { gameMetrics } from "./metrics.js";
import { NetworkSimulator } from "./netSim.js";
function payloadByteLength(payload) {
    if (payload instanceof ArrayBuffer)
        return payload.byteLength;
    return Buffer.byteLength(payload, 'utf8');
}
export class GameRoom extends TypedEventEmitter {
    id;
    maxPlayers;
    sessions = new Map();
    match;
    log;
    metrics;
    nextShipNumber = 1;
    constructor(id, config, autoStart = true, log = defaultLogger, metrics = gameMetrics) {
        super();
        this.id = id;
        this.maxPlayers = config.MAX_PLAYERS_PER_ROOM;
        this.log = log.child({ roomId: id });
        this.metrics = metrics;
        const seed = Array.from(id).reduce((acc, ch) => (acc * 31 + ch.charCodeAt(0)) >>> 0, 1337);
        this.match = new AuthoritativeMatch(seed, (shipId, snapshot) => {
            const session = this.sessions.get(shipId);
            if (!session)
                return;
            session.netSim.schedule(() => {
                this.sendToSession(session, snapshot);
            });
        });
        if (autoStart) {
            this.match.start();
        }
    }
    get playerCount() {
        return this.sessions.size;
    }
    get botCount() {
        return this.match.botCount;
    }
    getTickStats() {
        return this.match.getTickStats();
    }
    addPlayer(socket, name, config) {
        if (this.sessions.size + this.match.botCount >= this.maxPlayers) {
            return null;
        }
        const shipId = asEntityId(this.nextShipNumber++);
        const netSim = new NetworkSimulator({
            latencyMs: config.DEFAULT_LATENCY_MS,
            jitterMs: config.DEFAULT_JITTER_MS,
            dropRate: config.DEFAULT_DROP_RATE,
        });
        const session = {
            id: shipId,
            name,
            socket,
            netSim,
            inputLimiter: new TokenBucketRateLimiter(90, 60, performance.now()),
            codec: binaryCodec,
        };
        this.sessions.set(shipId, session);
        this.match.addPlayer(shipId, name);
        const initialSnapshot = this.match.createSnapshotFor(shipId);
        this.sendToSession(session, {
            type: 'welcome',
            shipId,
            roomId: this.id,
            tickRate: TICK_RATE,
            snapshot: initialSnapshot,
        });
        this.emit('playerJoined', { roomId: this.id, shipId, name });
        return session;
    }
    spawnBots(count) {
        const safeCount = Math.max(0, Math.min(32, Math.floor(count)));
        let spawned = 0;
        for (let i = 0; i < safeCount; i += 1) {
            if (this.sessions.size + this.match.botCount >= this.maxPlayers)
                break;
            const botId = asEntityId(this.nextShipNumber++);
            const bot = new BotController(botId, `Bot-${botId}`);
            this.match.addBot(bot);
            spawned += 1;
        }
        return spawned;
    }
    clearBots() {
        return this.match.removeAllBots().length;
    }
    removePlayer(shipId) {
        const session = this.sessions.get(shipId);
        if (!session)
            return;
        session.netSim.dispose();
        this.sessions.delete(shipId);
        this.match.removePlayer(shipId);
        this.emit('playerLeft', { roomId: this.id, shipId });
        if (this.sessions.size === 0 && this.match.botCount === 0) {
            this.match.stop();
            this.emit('empty', { roomId: this.id });
        }
    }
    handleInput(shipId, input) {
        const session = this.sessions.get(shipId);
        if (!session)
            return false;
        if (!session.inputLimiter.tryConsume(performance.now(), 1)) {
            return false;
        }
        session.netSim.schedule(() => {
            this.match.queueInput(shipId, input);
        });
        return true;
    }
    broadcastChat(fromShipId, text) {
        const sender = this.sessions.get(fromShipId);
        if (!sender)
            return;
        const msg = {
            type: 'chat',
            fromShipId,
            fromName: sender.name,
            text,
        };
        for (const session of this.sessions.values()) {
            this.sendToSession(session, msg);
        }
        this.emit('chatMessage', {
            roomId: this.id,
            fromShipId,
            fromName: sender.name,
            text,
        });
    }
    updateNetConfig(shipId, msg) {
        const session = this.sessions.get(shipId);
        if (!session)
            return;
        session.netSim.update({
            latencyMs: msg.latencyMs,
            jitterMs: msg.jitterMs,
            dropRate: msg.dropRate,
        });
        if (msg.codec) {
            session.codec = getCodec(msg.codec);
        }
    }
    sendDirect(shipId, msg) {
        const session = this.sessions.get(shipId);
        if (!session)
            return;
        this.sendToSession(session, msg);
    }
    stopAll() {
        for (const session of this.sessions.values()) {
            session.netSim.dispose();
        }
        this.sessions.clear();
        this.match.stop();
    }
    sendToSession(session, msg) {
        if (session.socket.readyState !== session.socket.OPEN)
            return;
        try {
            const payload = session.codec.encodeServer(msg);
            this.metrics.recordPacketOut(payloadByteLength(payload));
            session.socket.send(payload);
        }
        catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            this.log.warn({ event: 'packet.send_failed', playerId: session.id, reason });
        }
    }
}
export class RoomManager {
    rooms = new Map();
    config;
    log;
    metrics;
    constructor(config, log = defaultLogger, metrics = gameMetrics) {
        this.config = config;
        this.log = log;
        this.metrics = metrics;
    }
    getOrCreateRoom(rawRoomName, autoStart = true) {
        const roomId = asRoomId(rawRoomName.trim() || 'Sector Alpha');
        let room = this.rooms.get(roomId);
        if (!room) {
            if (this.rooms.size >= this.config.MAX_ROOMS) {
                throw new Error('ROOM_LIMIT_REACHED');
            }
            room = new GameRoom(roomId, this.config, autoStart, this.log, this.metrics);
            this.log.info({ event: 'room.created', roomId }, 'Room created');
            room.on('playerJoined', ({ roomId: rId, shipId, name }) => {
                this.log.info({ event: 'player.joined', roomId: rId, playerId: shipId, playerName: name });
            });
            room.on('playerLeft', ({ roomId: rId, shipId }) => {
                this.log.info({ event: 'player.left', roomId: rId, playerId: shipId });
            });
            room.on('empty', ({ roomId: rId }) => {
                this.log.info({ event: 'room.disposed', roomId: rId });
                this.rooms.delete(rId);
            });
            this.rooms.set(roomId, room);
        }
        return room;
    }
    getRoom(rawRoomName) {
        const roomId = asRoomId(rawRoomName.trim());
        return this.rooms.get(roomId);
    }
    stopAllRooms() {
        for (const room of this.rooms.values()) {
            room.stopAll();
        }
        this.rooms.clear();
    }
    getStats() {
        let players = 0;
        let bots = 0;
        let maxP50 = 0;
        let maxP95 = 0;
        let maxP99 = 0;
        for (const room of this.rooms.values()) {
            players += room.playerCount;
            bots += room.botCount;
            const t = room.getTickStats();
            if (t.p50Ms > maxP50)
                maxP50 = t.p50Ms;
            if (t.p95Ms > maxP95)
                maxP95 = t.p95Ms;
            if (t.p99Ms > maxP99)
                maxP99 = t.p99Ms;
        }
        return {
            rooms: this.rooms.size,
            players,
            bots,
            tickP50Ms: maxP50,
            tickP95Ms: maxP95,
            tickP99Ms: maxP99,
        };
    }
}
