import { ARENA, FIXED_DT, setDeterminismBugEnabled, wrapCoord } from '@game/shared';
import { loadAll, loadJson } from './assets.js';
import { createAudioSystem } from './audio.js';
import { GameEventBus } from './events.js';
import { createInput } from './input.js';
import { EntityInterpolator } from './interpolator.js';
import { Lobby } from './lobby.js';
import { mountLobbyView } from './lobbyView.js';
import { GameSocket } from './net.js';
import { NetgraphMonitor } from './netgraph.js';
import { LocalShipPredictor } from './predictor.js';
import { createRenderer } from './renderer.js';

const canvas = document.querySelector('#game');
const lobbyRoot = document.querySelector('#lobby-root');
const retryOverlay = document.querySelector('#retry-overlay');
const retryBtn = document.querySelector('#retry-btn');
const fallbackBtn = document.querySelector('#fallback-btn');

const netControls = document.querySelector('#net-controls');
const latSlider = document.querySelector('#lat-slider');
const jitSlider = document.querySelector('#jit-slider');
const dropSlider = document.querySelector('#drop-slider');
const interpSlider = document.querySelector('#interp-slider');
const latVal = document.querySelector('#lat-val');
const jitVal = document.querySelector('#jit-val');
const dropVal = document.querySelector('#drop-val');
const interpVal = document.querySelector('#interp-val');
const togglePredBtn = document.querySelector('#toggle-pred-btn');
const toggleCodecBtn = document.querySelector('#toggle-codec-btn');
const toggleBugBtn = document.querySelector('#toggle-bug-btn');

const chatHud = document.querySelector('#chat-hud');
const wsStatusEl = document.querySelector('#ws-status');
const roomPilotsEl = document.querySelector('#room-pilots');
const chatMessagesEl = document.querySelector('#chat-messages');
const chatInputEl = document.querySelector('#chat-input');

const renderer = createRenderer(canvas, ARENA);
const eventBus = new GameEventBus();
const audioContext = new AudioContext();

function applySimulatedFault(manifest, controller) {
  const failMode = new URLSearchParams(window.location.search).get('fail');
  if (failMode === '404') manifest.images.spritesheet = '/assets/missing-sprite-404.png';
  else if (failMode === 'json') manifest.json.rooms = '/api/rooms?fail=json';
  else if (failMode === 'timeout') manifest.json.rooms = '/api/rooms?fail=timeout';
  else if (failMode === 'abort')
    setTimeout(() => controller.abort(new DOMException('User cancelled load', 'AbortError')), 120);
  return failMode;
}

async function boot({ ignoreQueryFault = false, allowPartial = false } = {}) {
  retryOverlay.classList.remove('visible');
  let latestProgress = { completed: 0, total: 5, ratio: 0, items: [] };
  renderer.drawLoading({ title: 'LOADING GAME ASSETS...', progress: latestProgress });
  const controller = new AbortController();

  try {
    const manifest = await loadJson('/manifest.json', { signal: controller.signal });
    const activeFault = ignoreQueryFault ? null : applySimulatedFault(manifest, controller);
    const loadSignal =
      activeFault === 'timeout' && typeof AbortSignal.any === 'function'
        ? AbortSignal.any([controller.signal, AbortSignal.timeout(1200)])
        : controller.signal;

    const assets = await loadAll(manifest, {
      audioContext,
      signal: loadSignal,
      allowPartial,
      onProgress(progress) {
        latestProgress = progress;
        renderer.drawLoading({ title: 'LOADING GAME ASSETS...', progress });
      },
    });

    if (assets.images.spritesheet) renderer.setSpriteSheet(assets.images.spritesheet);
    const audio = createAudioSystem(audioContext, assets.audio, eventBus);
    openLobby(assets.json.rooms ?? [], audio);
  } catch (error) {
    renderer.drawLoading({
      title: 'ASSET LOADING INTERRUPTED',
      progress: latestProgress,
      errorMessage: error.message,
    });
    retryOverlay.classList.add('visible');
  }
}

retryBtn.addEventListener('click', () => boot({ ignoreQueryFault: true, allowPartial: false }));
fallbackBtn.addEventListener('click', () => boot({ ignoreQueryFault: false, allowPartial: true }));

function openLobby(initialRooms, audio) {
  const lobby = new Lobby({ endpoint: '/api/rooms', initialRooms });
  lobby.addEventListener('join', (event) => {
    audio.unlock();
    startMultiplayerGameplay(event.detail, audio);
  });
  mountLobbyView(lobbyRoot, lobby, { onUserGesture: () => audio.unlock() });
  lobby.start({ intervalMs: 3000 });
}

function appendChatLine(html, className = '') {
  const line = document.createElement('div');
  if (className) line.className = className;
  line.innerHTML = html;
  chatMessagesEl.appendChild(line);
  while (chatMessagesEl.children.length > 40) {
    chatMessagesEl.removeChild(chatMessagesEl.firstChild);
  }
  chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
}

function escapeHtml(str) {
  return String(str).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function startMultiplayerGameplay({ playerName, room }, audio) {
  chatHud.classList.add('visible');
  netControls.classList.add('visible');

  const params = new URLSearchParams(window.location.search);
  const initialJsonCodec = params.get('codec') === 'json';

  const socket = new GameSocket('/ws', { useJsonCodec: initialJsonCodec });
  const predictor = new LocalShipPredictor();
  const interpolator = new EntityInterpolator();
  const netgraph = new NetgraphMonitor();
  const input = createInput();

  let myShipId = 0;
  let serverTick = 0;
  let predictedBullets = [];
  let localFireCooldown = 0;
  let fps = 60;
  let frameCounter = 0;
  let fpsWindowStart = performance.now();

  if (initialJsonCodec) {
    toggleCodecBtn.textContent = 'Codec: JSON';
    toggleCodecBtn.classList.remove('active');
  }

  const syncNetSimToServer = () => {
    const latencyMs = Number(latSlider.value);
    const jitterMs = Number(jitSlider.value);
    const dropPct = Number(dropSlider.value);
    latVal.textContent = String(latencyMs);
    jitVal.textContent = String(jitterMs);
    dropVal.textContent = String(dropPct);
    socket.sendControl({ type: 'net-sim', latencyMs, jitterMs, dropPct });
  };

  latSlider.addEventListener('input', syncNetSimToServer);
  jitSlider.addEventListener('input', syncNetSimToServer);
  dropSlider.addEventListener('input', syncNetSimToServer);
  interpSlider.addEventListener('input', () => {
    const ms = Number(interpSlider.value);
    interpVal.textContent = String(ms);
    interpolator.setInterpolationDelayMs(ms);
  });

  togglePredBtn.addEventListener('click', () => {
    const next = !predictor.predictionEnabled;
    predictor.setPredictionEnabled(next);
    togglePredBtn.textContent = `Predict: ${next ? 'ON' : 'OFF'}`;
    togglePredBtn.classList.toggle('active', next);
  });

  toggleCodecBtn.addEventListener('click', () => {
    const nextJson = !socket.useJsonCodec;
    socket.setCodec(nextJson);
    toggleCodecBtn.textContent = `Codec: ${nextJson ? 'JSON' : 'BIN'}`;
    toggleCodecBtn.classList.toggle('active', !nextJson);
  });

  let bugEnabled = false;
  toggleBugBtn.addEventListener('click', () => {
    bugEnabled = !bugEnabled;
    setDeterminismBugEnabled(bugEnabled);
    toggleBugBtn.textContent = `RandBug: ${bugEnabled ? 'ON' : 'OFF'}`;
    toggleBugBtn.classList.toggle('danger', bugEnabled);
  });

  socket.addEventListener('status', (event) => {
    const { status, detail } = event.detail;
    wsStatusEl.textContent = detail ? `WS: ${status} (${detail})` : `WS: ${status}`;
    wsStatusEl.style.color = status === 'connected' ? '#22c55e' : '#f59e0b';
  });

  socket.addEventListener('snapshot', (event) => {
    const snap = event.detail;
    serverTick = snap.tick;
    if (snap.yourShipId) {
      myShipId = snap.yourShipId;
      predictor.setShipId(myShipId);
    }
    predictor.reconcile(snap);
    interpolator.pushSnapshot(snap);
  });

  socket.addEventListener('message', (event) => {
    const msg = event.detail;
    if (msg.type === 'joined') {
      myShipId = msg.shipId;
      predictor.setShipId(myShipId);
      roomPilotsEl.textContent = `Pilots: ${msg.roster.length}`;
      chatMessagesEl.innerHTML = '';
      for (const h of msg.history ?? []) {
        appendChatLine(`<strong>${escapeHtml(h.from)}:</strong> ${escapeHtml(h.text)}`, 'chat-msg-user');
      }
      appendChatLine(`Joined ${escapeHtml(msg.room.name)} (Ship #${myShipId})`, 'chat-msg-sys');
    } else if (msg.type === 'system') {
      if (msg.roster) roomPilotsEl.textContent = `Pilots: ${msg.roster.length}`;
      appendChatLine(escapeHtml(msg.text), 'chat-msg-sys');
    } else if (msg.type === 'chat') {
      appendChatLine(`<strong>${escapeHtml(msg.from)}:</strong> ${escapeHtml(msg.text)}`, 'chat-msg-user');
    } else if (msg.type === 'events') {
      for (const ev of msg.events ?? []) {
        eventBus.dispatchEvent(new CustomEvent(ev.type, { detail: ev }));
      }
    }
  });

  socket.joinRoom(room.id, playerName);

  window.addEventListener('keydown', (event) => {
    if (event.code === 'Enter') {
      event.preventDefault();
      if (document.activeElement === chatInputEl) {
        const text = chatInputEl.value.trim();
        if (text) {
          socket.sendControl({ type: 'chat', text });
          chatInputEl.value = '';
        }
        chatInputEl.blur();
      } else {
        chatInputEl.focus();
      }
      return;
    }
    if (event.code === 'Escape' && document.activeElement === chatInputEl) {
      chatInputEl.blur();
      return;
    }
    if (document.activeElement !== chatInputEl && event.code === 'KeyM') {
      audio.toggleMute();
    }
  });

  let accumulator = 0;
  let lastFrameTime = performance.now();

  function frame(now) {
    const renderDt = Math.min(0.1, (now - lastFrameTime) / 1000);
    lastFrameTime = now;
    accumulator += renderDt;

    frameCounter += 1;
    if (now - fpsWindowStart >= 500) {
      fps = Math.round((frameCounter * 1000) / (now - fpsWindowStart));
      frameCounter = 0;
      fpsWindowStart = now;
    }

    const isTyping = document.activeElement === chatInputEl;
    const rawControl = isTyping
      ? { thrust: false, left: false, right: false, fire: false, fireHoming: false }
      : input.getState();

    // Фіксований крок симуляції 30 Hz на клієнті (збігається з тікрейтом сервера)
    while (accumulator >= FIXED_DT) {
      accumulator -= FIXED_DT;
      localFireCooldown = Math.max(0, localFireCooldown - FIXED_DT);

      const inputPacket = predictor.stepLocalInput(rawControl, serverTick);
      socket.sendInput(inputPacket);

      // Свої кулі показуємо одразу (локальне передбачення пострілу)
      if (
        predictor.predictionEnabled &&
        (inputPacket.fire || inputPacket.fireHoming) &&
        localFireCooldown <= 0
      ) {
        const s = predictor.getRenderShip();
        if (s.alive) {
          localFireCooldown = inputPacket.fireHoming ? 0.42 : 0.2;
          predictedBullets.push({
            x: wrapCoord(s.x + Math.cos(s.angle) * 24, ARENA.width),
            y: wrapCoord(s.y + Math.sin(s.angle) * 24, ARENA.height),
            vx: s.vx * 0.35 + Math.cos(s.angle) * 560,
            vy: s.vy * 0.35 + Math.sin(s.angle) * 560,
            special: inputPacket.fireHoming,
            ttl: 0.16,
          });
        }
      }

      for (const pb of predictedBullets) {
        pb.x = wrapCoord(pb.x + pb.vx * FIXED_DT, ARENA.width);
        pb.y = wrapCoord(pb.y + pb.vy * FIXED_DT, ARENA.height);
        pb.ttl -= FIXED_DT;
      }
      predictedBullets = predictedBullets.filter((pb) => pb.ttl > 0);
    }

    predictor.decaySmoothing(renderDt);

    const net = socket.metrics;
    const netMetrics = {
      rttMs: net.rttMs,
      snapshotAgeMs: predictor.snapshotAgeMs,
      bytesInPerSec: net.bytesInPerSec,
      bytesOutPerSec: net.bytesOutPerSec,
      pendingInputs: predictor.pendingCount,
      correctionPx: predictor.lastCorrectionPx,
      interpDelayMs: interpolator.interpolationDelayMs,
      codec: net.codec,
    };
    netgraph.pushSample(netMetrics);

    const localShip = {
      ...predictor.getRenderShip(),
      name: playerName,
    };
    const remoteEntities = interpolator.sampleEntities(myShipId);

    renderer.drawMultiplayer({
      localShip,
      remoteEntities,
      predictedBullets,
      hud: { playerName, roomName: room.name, fps },
      netgraph,
      netMetrics,
    });

    requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);
}

boot();
