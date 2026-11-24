import {
  type Codec,
  type CodecKind,
  type EntityId,
  FIXED_DT,
  type InputMessage,
  type RoomId,
  type Seq,
  type SnapshotEntity,
  type Tick,
  asRoomId,
  asSeq,
  asTick,
  binaryCodec,
  getCodec,
  isDeterminismBugEnabled,
  setDeterminismBugEnabled,
} from '@game/shared';
import { Bus } from './bus.ts';
import { EntityInterpolator } from './interpolator.ts';
import { type FrameStatsSummary, FrameTimeTracker, markPerf, measurePerf } from './metrics.ts';
import { NetgraphHud } from './netgraph.ts';
import { ParticlePoolSystem } from './particles.ts';
import { LocalShipPredictor } from './predictor.ts';
import { ArenaRenderer } from './renderer.ts';

interface GameDebugApi {
  readonly getLocalShipId: () => number | null;
  readonly getLocalShipPos: () => { readonly x: number; readonly y: number } | null;
  readonly getRemoteShipPositions: () => ReadonlyArray<{
    readonly id: number;
    readonly name: string;
    readonly x: number;
    readonly y: number;
  }>;
  readonly getFrameStats: () => FrameStatsSummary;
}

declare global {
  interface Window {
    __GAME_DEBUG__?: GameDebugApi;
  }
}

type GameEvents = {
  connected: { readonly roomId: RoomId; readonly shipId: EntityId };
  disconnected: { readonly reason: string };
  serverError: { readonly code: string; readonly message: string };
};

function requireElement<T extends Element>(id: string, ctor: new () => T): T {
  const el = document.getElementById(id);
  if (!el || !(el instanceof ctor)) {
    throw new Error(`Missing or invalid DOM element #${id}`);
  }
  return el;
}

const bus = new Bus<GameEvents>();

const statusBar = requireElement('statusBar', HTMLElement);
const lobbyPanel = requireElement('lobbyPanel', HTMLElement);
const gameStage = requireElement('gameStage', HTMLElement);
const joinForm = requireElement('joinForm', HTMLFormElement);
const playerNameInput = requireElement('playerNameInput', HTMLInputElement);
const roomNameInput = requireElement('roomNameInput', HTMLInputElement);
const gameCanvas = requireElement('gameCanvas', HTMLCanvasElement);
const netgraphCanvas = requireElement('netgraphCanvas', HTMLCanvasElement);

const latencySlider = requireElement('latencySlider', HTMLInputElement);
const jitterSlider = requireElement('jitterSlider', HTMLInputElement);
const dropSlider = requireElement('dropSlider', HTMLInputElement);
const latencyVal = requireElement('latencyVal', HTMLElement);
const jitterVal = requireElement('jitterVal', HTMLElement);
const dropVal = requireElement('dropVal', HTMLElement);

const togglePredictBtn = requireElement('togglePredictBtn', HTMLButtonElement);
const toggleCodecBtn = requireElement('toggleCodecBtn', HTMLButtonElement);
const toggleWorkerBtn = requireElement('toggleWorkerBtn', HTMLButtonElement);
const toggleRandBugBtn = requireElement('toggleRandBugBtn', HTMLButtonElement);
const spawnBotsBtn = requireElement('spawnBotsBtn', HTMLButtonElement);
const disconnectBtn = requireElement('disconnectBtn', HTMLButtonElement);

const rosterCount = requireElement('rosterCount', HTMLElement);
const rosterList = requireElement('rosterList', HTMLElement);
const chatMessages = requireElement('chatMessages', HTMLElement);
const chatForm = requireElement('chatForm', HTMLFormElement);
const chatInput = requireElement('chatInput', HTMLInputElement);

const renderer = new ArenaRenderer(gameCanvas);
const netgraph = new NetgraphHud(netgraphCanvas);
const predictor = new LocalShipPredictor();
const interpolator = new EntityInterpolator();
const particles = new ParticlePoolSystem(512);
const frameTracker = new FrameTimeTracker(600);

const knownShipNames = new Map<EntityId, string>();
const pressedKeys = new Set<string>();

let socket: WebSocket | null = null;
let activeCodec: Codec = binaryCodec;
let localShipId: EntityId | null = null;
let currentRoomName = 'Sector Alpha';
let latestServerTick: Tick = asTick(0);
let inputSeqCounter = 0;

let workerEnabled = false;
let workerBusy = false;
let particleWorker: Worker | null = null;

try {
  particleWorker = new Worker(new URL('./particleWorker.ts', import.meta.url), { type: 'module' });
  particleWorker.addEventListener('message', (ev: MessageEvent<unknown>) => {
    workerBusy = false;
    if (ev.data instanceof ArrayBuffer) {
      particles.applyFromTransferBuffer(ev.data);
    }
  });
} catch {
  particleWorker = null;
}

window.__GAME_DEBUG__ = {
  getLocalShipId: () => localShipId,
  getLocalShipPos: () => {
    const ship = predictor.getRenderShip(localShipId);
    return ship ? { x: ship.pos.x, y: ship.pos.y } : null;
  },
  getRemoteShipPositions: () => {
    const entities = interpolator.sample(performance.now(), localShipId);
    return entities
      .filter((e) => e.kind === 'ship')
      .map((s) => ({
        id: s.id,
        name: knownShipNames.get(s.id) ?? s.name,
        x: s.pos.x,
        y: s.pos.y,
      }));
  },
  getFrameStats: () => frameTracker.getSummary(),
};

let stepTimer: ReturnType<typeof setInterval> | null = null;
let pingTimer: ReturnType<typeof setInterval> | null = null;
let rafId: number | null = null;
let lastFrameMs = performance.now();

function byteSizeOfPayload(payload: ArrayBuffer | string): number {
  if (payload instanceof ArrayBuffer) {
    return payload.byteLength;
  }
  return new TextEncoder().encode(payload).byteLength;
}

function sendClientMessage(msg: Parameters<Codec['encodeClient']>[0]): void {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  const encoded = activeCodec.encodeClient(msg);
  netgraph.recordBytesUp(byteSizeOfPayload(encoded));
  socket.send(encoded);
}

function appendChatLine(author: string, text: string): void {
  const row = document.createElement('div');
  row.textContent = `${author}: ${text}`;
  chatMessages.appendChild(row);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function updateRosterUI(entities: readonly SnapshotEntity[]): void {
  const ships = entities.filter((e) => e.kind === 'ship');
  rosterCount.textContent = String(ships.length);
  rosterList.innerHTML = '';
  for (const ship of ships) {
    const label = knownShipNames.get(ship.id) ?? ship.name;
    const li = document.createElement('li');
    li.textContent = `#${ship.id} ${label} — ${ship.hp} HP`;
    rosterList.appendChild(li);
  }
}

function sendNetConfig(): void {
  const latencyMs = Number(latencySlider.value);
  const jitterMs = Number(jitterSlider.value);
  const dropRate = Number(dropSlider.value) / 100;
  latencyVal.textContent = String(latencyMs);
  jitterVal.textContent = String(jitterMs);
  dropVal.textContent = String(dropSlider.value);

  sendClientMessage({
    type: 'netConfig',
    latencyMs,
    jitterMs,
    dropRate,
    codec: activeCodec.name,
  });
}

function readControlInput(seq: Seq, tick: Tick): InputMessage {
  const thrust = pressedKeys.has('KeyW') || pressedKeys.has('ArrowUp');
  const left = pressedKeys.has('KeyA') || pressedKeys.has('ArrowLeft');
  const right = pressedKeys.has('KeyD') || pressedKeys.has('ArrowRight');
  const fire = pressedKeys.has('Space');
  const fireHoming = pressedKeys.has('ShiftLeft') || pressedKeys.has('ShiftRight') || pressedKeys.has('KeyE');

  const turn = (right ? 1 : 0) - (left ? 1 : 0);
  return {
    type: 'input',
    seq,
    tick,
    thrust,
    turn,
    fire,
    fireHoming,
  };
}

function stopLoops(): void {
  if (stepTimer) {
    clearInterval(stepTimer);
    stepTimer = null;
  }
  if (pingTimer) {
    clearInterval(pingTimer);
    pingTimer = null;
  }
  if (rafId !== null) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
}

function startLoops(): void {
  stopLoops();
  lastFrameMs = performance.now();

  stepTimer = setInterval(() => {
    if (!socket || socket.readyState !== WebSocket.OPEN || localShipId === null) return;
    inputSeqCounter += 1;
    const seq = asSeq(inputSeqCounter);
    const input = readControlInput(seq, latestServerTick);
    markPerf('simulate:start');
    predictor.recordInput(input);
    markPerf('simulate:end');
    measurePerf('simulate', 'simulate:start', 'simulate:end');
    sendClientMessage(input);
  }, FIXED_DT * 1000);

  pingTimer = setInterval(() => {
    sendClientMessage({
      type: 'ping',
      clientTimeMs: performance.now(),
    });
  }, 1000);

  const renderFrame = (nowMs: number): void => {
    const frameStart = performance.now();
    const dt = Math.min(0.1, (nowMs - lastFrameMs) / 1000);
    lastFrameMs = nowMs;

    predictor.decaySmoothing(dt);
    const remoteEntities = interpolator.sample(nowMs, localShipId);
    const localRenderShip = predictor.getRenderShip(localShipId);

    if (localRenderShip && localRenderShip.alive && localRenderShip.thrusting) {
      particles.emitExhaust(localRenderShip.pos.x, localRenderShip.pos.y, localRenderShip.angle);
    }

    if (workerEnabled && particleWorker && !workerBusy && particles.activeCount > 0) {
      workerBusy = true;
      const transferBuf = particles.packToTransferBuffer(dt);
      particleWorker.postMessage(transferBuf, [transferBuf]);
    } else {
      particles.update(dt);
    }

    const frameEntities: SnapshotEntity[] = localRenderShip
      ? [localRenderShip, ...remoteEntities]
      : remoteEntities;

    markPerf('render:start');
    renderer.render(frameEntities, localShipId, knownShipNames, particles.active);
    markPerf('render:end');
    measurePerf('render', 'render:start', 'render:end');

    const frameDurationMs = performance.now() - frameStart;
    frameTracker.record(frameDurationMs);

    netgraph.tick(
      nowMs,
      predictor.queueLength,
      predictor.lastReconcileErrorPx,
      activeCodec.name,
      frameTracker.getSummary(),
    );

    rafId = requestAnimationFrame(renderFrame);
  };

  rafId = requestAnimationFrame(renderFrame);
}

bus.on('connected', ({ roomId, shipId }) => {
  statusBar.textContent = `Connected · Room "${roomId}" · Ship #${shipId}`;
  lobbyPanel.classList.add('hidden');
  gameStage.classList.remove('hidden');
  chatMessages.innerHTML = '';
  frameTracker.reset();
  sendNetConfig();
  startLoops();
});

bus.on('disconnected', ({ reason }) => {
  stopLoops();
  localShipId = null;
  predictor.reset();
  interpolator.reset();
  particles.reset();
  knownShipNames.clear();
  statusBar.textContent = `Disconnected (${reason})`;
  gameStage.classList.add('hidden');
  lobbyPanel.classList.remove('hidden');
});

bus.on('serverError', ({ code, message }) => {
  statusBar.textContent = `Server Error [${code}]: ${message}`;
});

function connectToServer(playerName: string, roomName: string): void {
  if (socket) {
    socket.close();
    socket = null;
  }

  currentRoomName = roomName;
  const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${wsProtocol}//${window.location.host}/ws`;
  const ws = new WebSocket(wsUrl);
  ws.binaryType = 'arraybuffer';
  socket = ws;

  statusBar.textContent = 'Connecting...';

  ws.addEventListener('open', () => {
    inputSeqCounter = 0;
    predictor.reset();
    interpolator.reset();
    particles.reset();
    sendClientMessage({
      type: 'join',
      room: asRoomId(roomName),
      name: playerName,
    });
  });

  ws.addEventListener('message', (event: MessageEvent<unknown>) => {
    const rawData: unknown = event.data;
    if (rawData instanceof ArrayBuffer) {
      netgraph.recordBytesDown(rawData.byteLength);
    } else if (typeof rawData === 'string') {
      netgraph.recordBytesDown(new TextEncoder().encode(rawData).byteLength);
    }

    markPerf('decode:start');
    const parsed = activeCodec.decodeServer(rawData);
    markPerf('decode:end');
    measurePerf('decode', 'decode:start', 'decode:end');

    if (!parsed.ok) {
      console.warn(`[Client] Dropped invalid server message: ${parsed.error}`);
      return;
    }

    const msg = parsed.value;
    switch (msg.type) {
      case 'welcome': {
        localShipId = msg.shipId;
        latestServerTick = msg.snapshot.tick;
        for (const e of msg.snapshot.entities) {
          if (e.kind === 'ship') {
            knownShipNames.set(e.id, e.name);
          }
        }
        predictor.reconcile(msg.snapshot);
        interpolator.push(msg.snapshot, performance.now());
        updateRosterUI(msg.snapshot.entities);
        bus.emit('connected', { roomId: msg.roomId, shipId: msg.shipId });
        break;
      }
      case 'snapshot': {
        latestServerTick = msg.tick;
        for (const e of msg.entities) {
          if (e.kind === 'ship' && !knownShipNames.has(e.id)) {
            knownShipNames.set(e.id, e.name);
          }
        }
        markPerf('reconcile:start');
        predictor.reconcile(msg);
        markPerf('reconcile:end');
        measurePerf('reconcile', 'reconcile:start', 'reconcile:end');

        interpolator.push(msg, performance.now());
        updateRosterUI(msg.entities);
        break;
      }
      case 'chat': {
        appendChatLine(msg.fromName, msg.text);
        break;
      }
      case 'pong': {
        const rtt = Math.max(0, performance.now() - msg.clientTimeMs);
        netgraph.recordRtt(rtt);
        break;
      }
      case 'error': {
        bus.emit('serverError', { code: msg.code, message: msg.message });
        break;
      }
      default: {
        const _exhaustive: never = msg;
        console.warn('[Client] Unhandled server message:', _exhaustive);
      }
    }
  });

  ws.addEventListener('close', (ev: CloseEvent) => {
    socket = null;
    bus.emit('disconnected', { reason: ev.reason || `code ${ev.code}` });
  });

  ws.addEventListener('error', () => {
    statusBar.textContent = 'WebSocket connection error';
  });
}

joinForm.addEventListener('submit', (ev: SubmitEvent) => {
  ev.preventDefault();
  const name = playerNameInput.value.trim() || 'Pilot';
  const room = roomNameInput.value.trim() || 'Sector Alpha';
  connectToServer(name, room);
});

chatForm.addEventListener('submit', (ev: SubmitEvent) => {
  ev.preventDefault();
  const text = chatInput.value.trim();
  if (!text) return;
  sendClientMessage({ type: 'chat', text });
  chatInput.value = '';
});

spawnBotsBtn.addEventListener('click', () => {
  void fetch(`/api/rooms/${encodeURIComponent(currentRoomName)}/bots`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ count: 8 }),
  });
});

disconnectBtn.addEventListener('click', () => {
  socket?.close(1000, 'Player left');
});

latencySlider.addEventListener('input', sendNetConfig);
jitterSlider.addEventListener('input', sendNetConfig);
dropSlider.addEventListener('input', sendNetConfig);

togglePredictBtn.addEventListener('click', () => {
  predictor.predictionEnabled = !predictor.predictionEnabled;
  togglePredictBtn.textContent = `Predict: ${predictor.predictionEnabled ? 'ON' : 'OFF'}`;
  togglePredictBtn.classList.toggle('active', predictor.predictionEnabled);
});

toggleCodecBtn.addEventListener('click', () => {
  const nextKind: CodecKind = activeCodec.name === 'binary' ? 'json' : 'binary';
  activeCodec = getCodec(nextKind);
  toggleCodecBtn.textContent = `Codec: ${nextKind === 'binary' ? 'BIN' : 'JSON'}`;
  toggleCodecBtn.classList.toggle('active', nextKind === 'binary');
  sendNetConfig();
});

toggleWorkerBtn.addEventListener('click', () => {
  workerEnabled = !workerEnabled && particleWorker !== null;
  toggleWorkerBtn.textContent = `Worker: ${workerEnabled ? 'ON' : 'OFF'}`;
  toggleWorkerBtn.classList.toggle('active', workerEnabled);
});

toggleRandBugBtn.addEventListener('click', () => {
  const next = !isDeterminismBugEnabled();
  setDeterminismBugEnabled(next);
  toggleRandBugBtn.textContent = `RandBug: ${next ? 'ON' : 'OFF'}`;
  toggleRandBugBtn.classList.toggle('active', next);
});

window.addEventListener('keydown', (ev: KeyboardEvent) => {
  if (document.activeElement instanceof HTMLInputElement) return;
  pressedKeys.add(ev.code);
});

window.addEventListener('keyup', (ev: KeyboardEvent) => {
  pressedKeys.delete(ev.code);
});

window.addEventListener('blur', () => {
  pressedKeys.clear();
});
