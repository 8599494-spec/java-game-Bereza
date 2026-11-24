import { loadAll, loadJson } from './assets.js';
import { createAudioSystem } from './audio.js';
import { createAsteroid, createBullet, createDragBehavior, createWrapBehavior } from './behaviors.js';
import { Ship } from './entity.js';
import { GameEventBus } from './events.js';
import { createInput } from './input.js';
import { Lobby } from './lobby.js';
import { mountLobbyView } from './lobbyView.js';
import { createLoop } from './loop.js';
import { GameSocket } from './net.js';
import { createRenderer } from './renderer.js';
import { Vector2 } from './vector2.js';
import { World } from './world.js';

const ARENA = { width: 900, height: 600 };
const canvas = document.querySelector('#game');
const lobbyRoot = document.querySelector('#lobby-root');
const retryOverlay = document.querySelector('#retry-overlay');
const retryBtn = document.querySelector('#retry-btn');
const fallbackBtn = document.querySelector('#fallback-btn');

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
  else if (failMode === 'abort') setTimeout(() => controller.abort(new DOMException('User cancelled load', 'AbortError')), 120);
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
    renderer.drawLoading({ title: 'ASSET LOADING INTERRUPTED', progress: latestProgress, errorMessage: error.message });
    retryOverlay.classList.add('visible');
  }
}

retryBtn.addEventListener('click', () => boot({ ignoreQueryFault: true, allowPartial: false }));
fallbackBtn.addEventListener('click', () => boot({ ignoreQueryFault: false, allowPartial: true }));

function openLobby(initialRooms, audio) {
  const lobby = new Lobby({ endpoint: '/api/rooms', initialRooms });
  lobby.addEventListener('join', (event) => {
    audio.unlock();
    startGameplay(event.detail, audio);
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

function startGameplay({ playerName, room }, audio) {
  chatHud.classList.add('visible');
  const socket = new GameSocket('/ws');

  socket.addEventListener('status', (event) => {
    const { status, detail } = event.detail;
    wsStatusEl.textContent = detail ? `WS: ${status} (${detail})` : `WS: ${status}`;
    wsStatusEl.style.color = status === 'connected' ? '#22c55e' : '#f59e0b';
  });

  socket.addEventListener('message', (event) => {
    const msg = event.detail;
    if (msg.type === 'joined') {
      roomPilotsEl.textContent = `Pilots: ${msg.roster.length}`;
      chatMessagesEl.innerHTML = '';
      for (const h of msg.history ?? []) {
        appendChatLine(`<strong>${escapeHtml(h.from)}:</strong> ${escapeHtml(h.text)}`, 'chat-msg-user');
      }
      appendChatLine(`Connected to ${escapeHtml(msg.room.name)}`, 'chat-msg-sys');
    } else if (msg.type === 'system') {
      if (msg.roster) roomPilotsEl.textContent = `Pilots: ${msg.roster.length}`;
      appendChatLine(escapeHtml(msg.text), 'chat-msg-sys');
    } else if (msg.type === 'chat') {
      appendChatLine(`<strong>${escapeHtml(msg.from)}:</strong> ${escapeHtml(msg.text)}`, 'chat-msg-user');
    }
  });

  socket.joinRoom(room.id, playerName);

  const input = createInput();
  const world = new World({ events: eventBus });
  const ship = new Ship({
    pos: new Vector2(ARENA.width / 2, ARENA.height / 2),
    maxHp: 100,
    behaviors: [createDragBehavior(0.985), createWrapBehavior(ARENA)],
  });
  world.spawn(ship);

  let score = 0;
  let respawnTimer = 0;
  let stats = { stepsPerSec: 60, framesPerSec: 144, frameTimeMs: '0.00' };

  eventBus.addEventListener('exploded', (event) => { score += event.detail?.score ?? 0; });

  window.addEventListener('keydown', (event) => {
    if (event.code === 'Enter') {
      event.preventDefault();
      if (document.activeElement === chatInputEl) {
        const text = chatInputEl.value.trim();
        if (text) {
          socket.send({ type: 'chat', text });
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

  function spawnRandomAsteroid() {
    const edge = Math.floor(Math.random() * 4);
    let x = 0;
    let y = 0;
    if (edge === 0) { x = Math.random() * ARENA.width; y = 0; }
    else if (edge === 1) { x = ARENA.width; y = Math.random() * ARENA.height; }
    else if (edge === 2) { x = Math.random() * ARENA.width; y = ARENA.height; }
    else { x = 0; y = Math.random() * ARENA.height; }

    const isHoming = Math.random() < (room.homingRatio ?? 0.3);
    const angle = Math.random() * Math.PI * 2;
    const speed = isHoming ? 130 : 75 + Math.random() * 85;
    world.spawn(createAsteroid({ pos: new Vector2(x, y), vel: Vector2.fromAngle(angle, speed), radius: isHoming ? 22 : 26, homing: isHoming, arena: ARENA }));
  }

  const targetAsteroids = room.asteroidCount ?? 6;
  for (let i = 0; i < targetAsteroids; i += 1) spawnRandomAsteroid();

  const loop = createLoop({
    step(dt) {
      const isTyping = document.activeElement === chatInputEl;
      const state = isTyping
        ? { thrust: false, left: false, right: false, fire: false, fireHoming: false }
        : input.getState();

      if (!ship.dead) {
        ship.control(state, dt);
        if (state.fire) ship.fire(world, { homing: false, createBulletFn: (opts) => createBullet({ ...opts, arena: ARENA }) });
        if (state.fireHoming) ship.fire(world, { homing: true, createBulletFn: (opts) => createBullet({ ...opts, arena: ARENA }) });
      } else {
        respawnTimer -= dt;
        if (respawnTimer <= 0) {
          ship.reset(new Vector2(ARENA.width / 2, ARENA.height / 2));
          world.spawn(ship);
        }
      }
      const wasAlive = !ship.dead;
      world.step(dt);
      if (wasAlive && ship.dead) respawnTimer = 2.0;
      while (world.countKind('asteroid') < targetAsteroids) spawnRandomAsteroid();
    },
    render() {
      renderer.draw(world, ship, {
        stats,
        score,
        respawnTimer,
        playerName,
        roomName: room.name,
        muted: audio.isMuted(),
        isThrusting: document.activeElement !== chatInputEl && input.getState().thrust,
      });
    },
    onStats(nextStats) { stats = nextStats; },
  });

  loop.start();
}

boot();
