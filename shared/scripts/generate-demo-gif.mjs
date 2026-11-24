import fs from 'node:fs';
import path from 'node:path';
import { ARENA, FIXED_DT, addShipToWorld, createWorldState, stepWorldState } from '../src/index.js';

// Генератор анімованого GIF89a (800x300) із двома вікнами гравців поруч (Pilot-1 vs Pilot-2)
const WIDTH = 800;
const HEIGHT = 300;
const VIEW_W = 396;
const VIEW_H = 296;

const PALETTE = [
  [5, 8, 17], // 0: bg
  [15, 23, 42], // 1: hud panel
  [51, 65, 85], // 2: border
  [56, 189, 248], // 3: cyan ship 1
  [245, 158, 11], // 4: amber ship 2
  [148, 163, 184], // 5: asteroid
  [244, 63, 94], // 6: homing / warning
  [34, 197, 94], // 7: green netgraph
  [248, 250, 252], // 8: white bullets / text
  [249, 115, 22], // 9: thrust flame
  [2, 132, 199], // 10: accent
  [30, 41, 59], // 11: subtle grid
  [0, 0, 0],
  [0, 0, 0],
  [0, 0, 0],
  [0, 0, 0],
];

function createIndexedFrame() {
  const px = new Uint8Array(WIDTH * HEIGHT);
  const setPx = (x, y, c) => {
    const ix = Math.round(x);
    const iy = Math.round(y);
    if (ix >= 0 && iy >= 0 && ix < WIDTH && iy < HEIGHT) {
      px[iy * WIDTH + ix] = c;
    }
  };
  const fillRect = (x, y, w, h, c) => {
    for (let yy = y; yy < y + h; yy += 1) {
      for (let xx = x; xx < x + w; xx += 1) setPx(xx, yy, c);
    }
  };
  const drawLine = (x0, y0, x1, y1, c) => {
    const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
    for (let i = 0; i <= steps; i += 1) {
      const t = i / steps;
      setPx(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, c);
    }
  };
  const drawCircle = (cx, cy, r, c) => {
    const segs = 20;
    for (let i = 0; i < segs; i += 1) {
      const a0 = (Math.PI * 2 * i) / segs;
      const a1 = (Math.PI * 2 * (i + 1)) / segs;
      drawLine(cx + Math.cos(a0) * r, cy + Math.sin(a0) * r, cx + Math.cos(a1) * r, cy + Math.sin(a1) * r, c);
    }
  };
  return { px, setPx, fillRect, drawLine, drawCircle };
}

function encodeGifLzw(indices, minCodeSize = 4) {
  const clearCode = 1 << minCodeSize;
  const endCode = clearCode + 1;
  let codeSize = minCodeSize + 1;
  let nextCode = endCode + 1;
  let dict = new Map();

  const outBytes = [];
  let bitBuf = 0;
  let bitCount = 0;

  const emitCode = (code) => {
    bitBuf |= code << bitCount;
    bitCount += codeSize;
    while (bitCount >= 8) {
      outBytes.push(bitBuf & 0xff);
      bitBuf >>= 8;
      bitCount -= 8;
    }
  };

  const resetDict = () => {
    dict = new Map();
    codeSize = minCodeSize + 1;
    nextCode = endCode + 1;
  };

  emitCode(clearCode);
  let prefix = indices[0];

  for (let i = 1; i < indices.length; i += 1) {
    const k = indices[i];
    const key = (prefix << 8) | k;
    const found = dict.get(key);
    if (found !== undefined) {
      prefix = found;
    } else {
      emitCode(prefix);
      if (nextCode < 4096) {
        dict.set(key, nextCode++);
        if (nextCode > 1 << codeSize && codeSize < 12) {
          codeSize += 1;
        }
      } else {
        emitCode(clearCode);
        resetDict();
      }
      prefix = k;
    }
  }

  emitCode(prefix);
  emitCode(endCode);
  if (bitCount > 0) {
    outBytes.push(bitBuf & 0xff);
  }

  const subBlocks = [];
  for (let i = 0; i < outBytes.length; i += 255) {
    const slice = outBytes.slice(i, i + 255);
    subBlocks.push(Buffer.from([slice.length, ...slice]));
  }
  subBlocks.push(Buffer.from([0x00]));
  return Buffer.concat([Buffer.from([minCodeSize]), ...subBlocks]);
}

function buildGif(frames, delayCs = 8) {
  const header = Buffer.from('GIF89a', 'ascii');
  const lsd = Buffer.alloc(7);
  lsd.writeUInt16LE(WIDTH, 0);
  lsd.writeUInt16LE(HEIGHT, 2);
  lsd[4] = 0x83; // Global Color Table, 16 colors
  lsd[5] = 0;
  lsd[6] = 0;

  const gct = Buffer.alloc(16 * 3);
  PALETTE.forEach(([r, g, b], idx) => {
    gct[idx * 3] = r;
    gct[idx * 3 + 1] = g;
    gct[idx * 3 + 2] = b;
  });

  // Netscape 2.0 loop extension
  const appExt = Buffer.from([
    0x21,
    0xff,
    0x0b,
    ...Buffer.from('NETSCAPE2.0', 'ascii'),
    0x03,
    0x01,
    0x00,
    0x00,
    0x00,
  ]);

  const chunks = [header, lsd, gct, appExt];

  for (const framePx of frames) {
    const gce = Buffer.from([0x21, 0xf9, 0x04, 0x00, delayCs & 0xff, (delayCs >> 8) & 0xff, 0x00, 0x00]);
    const imgDesc = Buffer.alloc(10);
    imgDesc[0] = 0x2c;
    imgDesc.writeUInt16LE(0, 1);
    imgDesc.writeUInt16LE(0, 3);
    imgDesc.writeUInt16LE(WIDTH, 5);
    imgDesc.writeUInt16LE(HEIGHT, 7);
    imgDesc[9] = 0x00;
    chunks.push(gce, imgDesc, encodeGifLzw(framePx, 4));
  }

  chunks.push(Buffer.from([0x3b]));
  return Buffer.concat(chunks);
}

// Симулюємо бій двох гравців на реальному спільному рушії @game/shared
const world = createWorldState({ seed: 9001, asteroidCount: 6, homingRatio: 0.35 });
addShipToWorld(world, { id: 1, name: 'Pilot-1', slotIndex: 0 });
addShipToWorld(world, { id: 2, name: 'Pilot-2', slotIndex: 1 });

const history = [];
const inputs = new Map();

for (let t = 0; t < 160; t += 1) {
  inputs.set(1, {
    seq: t + 1,
    thrust: true,
    turn: Math.sin(t * 0.08) * 0.85,
    fire: t % 14 === 0,
    fireHoming: false,
  });
  inputs.set(2, {
    seq: t + 1,
    thrust: t % 5 !== 0,
    turn: Math.cos(t * 0.07) * -0.9,
    fire: t % 16 === 0,
    fireHoming: t % 48 === 0,
  });
  stepWorldState(world, inputs, FIXED_DT);
  history.push(structuredClone(world));
}

function renderViewport(frame, ox, oy, state, localId, frameIdx) {
  const sx = VIEW_W / ARENA.width;
  const sy = VIEW_H / ARENA.height;

  frame.fillRect(ox, oy, VIEW_W, VIEW_H, 0);
  // Сітка арени
  for (let gx = 60; gx < VIEW_W; gx += 60) frame.drawLine(ox + gx, oy + 24, ox + gx, oy + VIEW_H, 11);
  for (let gy = 54; gy < VIEW_H; gy += 60) frame.drawLine(ox, oy + gy, ox + VIEW_W, oy + gy, 11);

  // Верхній HUD + Netgraph
  frame.fillRect(ox, oy, VIEW_W, 24, 1);
  frame.fillRect(ox + 6, oy + 28, 118, 48, 1);
  frame.drawLine(ox + 6, oy + 28, ox + 124, oy + 28, 2);
  frame.drawLine(ox + 6, oy + 76, ox + 124, oy + 76, 2);

  // Імітація спарклайну RTT у Netgraph
  for (let i = 0; i < 24; i += 1) {
    const barH = 8 + Math.round(Math.sin((frameIdx + i) * 0.35) * 4 + 4);
    frame.fillRect(ox + 12 + i * 4, oy + 70 - barH, 2, barH, 7);
  }
  // Кольоровий індикатор власника вікна (ліве вікно = cyan, праве = amber)
  frame.fillRect(ox + 8, oy + 7, 46, 10, localId === 1 ? 3 : 4);
  frame.fillRect(ox + 62, oy + 9, 70, 6, 8);

  for (const a of state.asteroids) {
    frame.drawCircle(ox + a.x * sx, oy + a.y * sy, Math.max(5, a.radius * sx), a.homing ? 6 : 5);
  }

  for (const b of state.bullets) {
    frame.fillRect(Math.round(ox + b.x * sx) - 1, Math.round(oy + b.y * sy) - 1, 3, 3, b.special ? 4 : 8);
  }

  for (const s of state.ships) {
    if (!s.alive) continue;
    const cx = ox + s.x * sx;
    const cy = oy + s.y * sy;
    const color = s.id === 1 ? 3 : 4;
    const noseX = cx + Math.cos(s.angle) * 11;
    const noseY = cy + Math.sin(s.angle) * 11;
    const leftX = cx + Math.cos(s.angle + 2.45) * 9;
    const leftY = cy + Math.sin(s.angle + 2.45) * 9;
    const rightX = cx + Math.cos(s.angle - 2.45) * 9;
    const rightY = cy + Math.sin(s.angle - 2.45) * 9;

    if (s.thrusting) {
      const tailX = cx - Math.cos(s.angle) * 13;
      const tailY = cy - Math.sin(s.angle) * 13;
      frame.drawLine(cx, cy, tailX, tailY, 9);
    }
    frame.drawLine(noseX, noseY, leftX, leftY, color);
    frame.drawLine(leftX, leftY, rightX, rightY, color);
    frame.drawLine(rightX, rightY, noseX, noseY, color);
  }
}

const gifFrames = [];
for (let i = 6; i < history.length; i += 3) {
  const frame = createIndexedFrame();
  frame.fillRect(0, 0, WIDTH, HEIGHT, 2);
  // Ліве вікно бачить свій корабель без затримки (prediction), а чужий зі зсувом на 3 тіки (100 мс interpolation)
  const interpStateLeft = {
    ...history[i],
    ships: [history[i].ships[0], history[Math.max(0, i - 3)].ships[1]],
  };
  const interpStateRight = {
    ...history[i],
    ships: [history[Math.max(0, i - 3)].ships[0], history[i].ships[1]],
  };

  renderViewport(frame, 2, 2, interpStateLeft, 1, i);
  renderViewport(frame, 402, 2, interpStateRight, 2, i);
  gifFrames.push(frame.px);
}

fs.mkdirSync('docs', { recursive: true });
const outPath = path.join('docs', 'demo-lab05.gif');
fs.writeFileSync(outPath, buildGif(gifFrames, 8));
console.log(`Generated ${outPath} (${gifFrames.length} frames, ${WIDTH}x${HEIGHT})`);
