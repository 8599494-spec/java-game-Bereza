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
import { NetgraphHud } from './netgraph.ts';
import { LocalShipPredictor } from './predictor.ts';
import { ArenaRenderer } from './renderer.ts';

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
const toggleRandBugBtn = requireElement('toggleRandBugBtn', HTMLButtonElement);
const disconnectBtn = requireElement('disconnectBtn', HTMLButtonElement);

const renderer = new ArenaRenderer(gameCanvas);
const netgraph = new NetgraphHud(netgraphCanvas);
const predictor = new LocalShipPredictor();
const interpolator = new EntityInterpolator();

const knownShipNames = new Map<EntityId, string>();
const pressedKeys = new Set<string>();

let socket: WebSocket | null = null;
let activeCodec: Codec = binaryCodec;
let localShipId: EntityId | null = null;
let latestServerTick: Tick = asTick(0);
let inputSeqCounter = 0;

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
    predictor.recordInput(input);
    sendClientMessage(input);
  }, FIXED_DT * 1000);

  pingTimer = setInterval(() => {
    sendClientMessage({
      type: 'ping',
      clientTimeMs: performance.now(),
    });
  }, 1000);

  const renderFrame = (nowMs: number): void => {
    const dt = Math.min(0.1, (nowMs - lastFrameMs) / 1000);
    lastFrameMs = nowMs;

    predictor.decaySmoothing(dt);
    const remoteEntities = interpolator.sample(nowMs, localShipId);
    const localRenderShip = predictor.getRenderShip(localShipId);

    const frameEntities: SnapshotEntity[] = localRenderShip
      ? [localRenderShip, ...remoteEntities]
      : remoteEntities;

    renderer.render(frameEntities, localShipId, knownShipNames);
    netgraph.tick(nowMs, predictor.queueLength, predictor.lastReconcileErrorPx, activeCodec.name);

    rafId = requestAnimationFrame(renderFrame);
  };

  rafId = requestAnimationFrame(renderFrame);
}

bus.on('connected', ({ roomId, shipId }) => {
  statusBar.textContent = `Connected · Room "${roomId}" · Ship #${shipId}`;
  lobbyPanel.classList.add('hidden');
  gameStage.classList.remove('hidden');
  sendNetConfig();
  startLoops();
});

bus.on('disconnected', ({ reason }) => {
  stopLoops();
  localShipId = null;
  predictor.reset();
  interpolator.reset();
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

    const parsed = activeCodec.decodeServer(rawData);
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
        predictor.reconcile(msg);
        interpolator.push(msg, performance.now());
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
