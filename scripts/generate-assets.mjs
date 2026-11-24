import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n += 1) {
  let c = n;
  for (let k = 0; k < 8; k += 1) {
    c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  crcTable[n] = c;
}

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    crc = crcTable[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function makeChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function encodePng(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([sig, makeChunk('IHDR', ihdr), makeChunk('IDAT', zlib.deflateSync(raw)), makeChunk('IEND', Buffer.alloc(0))]);
}

function createCanvasBuffer(width, height) {
  const data = Buffer.alloc(width * height * 4);
  const setPixel = (x, y, [r, g, b, a = 255]) => {
    const ix = Math.round(x);
    const iy = Math.round(y);
    if (ix < 0 || iy < 0 || ix >= width || iy >= height) return;
    const idx = (iy * width + ix) * 4;
    data[idx] = r;
    data[idx + 1] = g;
    data[idx + 2] = b;
    data[idx + 3] = a;
  };
  const drawLine = (x0, y0, x1, y1, color) => {
    const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
    for (let i = 0; i <= steps; i += 1) {
      const t = i / steps;
      setPixel(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, color);
    }
  };
  const fillCircle = (cx, cy, r, color) => {
    for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y += 1) {
      for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x += 1) {
        if ((x - cx) ** 2 + (y - cy) ** 2 <= r ** 2) setPixel(x, y, color);
      }
    }
  };
  return { width, height, data, setPixel, drawLine, fillCircle };
}

function drawPolygon(c, cx, cy, r, sides, color) {
  const pts = [];
  for (let i = 0; i < sides; i += 1) {
    const a = (Math.PI * 2 * i) / sides;
    const rad = r * (i % 2 === 0 ? 1 : 0.8);
    pts.push([cx + Math.cos(a) * rad, cy + Math.sin(a) * rad]);
  }
  for (let i = 0; i < sides; i += 1) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[(i + 1) % sides];
    c.drawLine(x0, y0, x1, y1, color);
  }
}

function buildSpriteSheet() {
  const c = createCanvasBuffer(256, 64);
  const cyan = [56, 189, 248, 255];
  const blueFill = [14, 116, 144, 180];
  const orange = [249, 115, 22, 255];
  const gold = [245, 158, 11, 255];
  const slate = [148, 163, 184, 255];
  const rose = [244, 63, 94, 255];

  for (let x = -14; x <= 18; x += 1) {
    const halfH = Math.max(0, Math.round(((18 - x) / 32) * 12));
    for (let y = -halfH; y <= halfH; y += 1) {
      if (x < -9 && Math.abs(y) < 4) continue;
      c.setPixel(32 + x, 32 + y, blueFill);
    }
  }
  c.drawLine(50, 32, 18, 20, cyan);
  c.drawLine(18, 20, 24, 32, cyan);
  c.drawLine(24, 32, 18, 44, cyan);
  c.drawLine(18, 44, 50, 32, cyan);
  c.fillCircle(35, 32, 3, [224, 242, 254, 255]);

  c.fillCircle(96, 16, 4, cyan);
  c.fillCircle(96, 16, 2, [255, 255, 255, 255]);
  c.fillCircle(96, 48, 6, gold);
  c.drawLine(86, 48, 92, 48, orange);

  drawPolygon(c, 160, 32, 24, 8, slate);
  drawPolygon(c, 160, 32, 11, 6, [100, 116, 139, 255]);

  drawPolygon(c, 224, 32, 23, 8, rose);
  c.fillCircle(224, 32, 5, orange);

  return encodePng(c.width, c.height, c.data);
}

function encodeWav(durationSec, sampleFn) {
  const sampleRate = 22050;
  const numSamples = Math.floor(sampleRate * durationSec);
  const dataSize = numSamples * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);

  for (let i = 0; i < numSamples; i += 1) {
    const t = i / sampleRate;
    const env = Math.max(0, 1 - t / durationSec);
    const sample = Math.max(-1, Math.min(1, sampleFn(t, env)));
    buf.writeInt16LE(Math.round(sample * 32767), 44 + i * 2);
  }
  return buf;
}

fs.writeFileSync(path.join('public', 'assets', 'spritesheet.png'), buildSpriteSheet());
fs.writeFileSync(path.join('public', 'assets', 'sfx-fire.wav'), encodeWav(0.14, (t, env) => Math.sin(2 * Math.PI * (880 - t * 3400) * t) * env * 0.45));
fs.writeFileSync(path.join('public', 'assets', 'sfx-hit.wav'), encodeWav(0.18, (t, env) => (Math.sin(2 * Math.PI * 220 * t) * 0.5 + (Math.random() * 2 - 1) * 0.5) * env * 0.5));
fs.writeFileSync(path.join('public', 'assets', 'sfx-explosion.wav'), encodeWav(0.42, (t, env) => ((Math.random() * 2 - 1) * 0.7 + Math.sin(2 * Math.PI * 65 * t) * 0.3) * (env ** 1.5) * 0.65));

fs.writeFileSync(path.join('public', 'manifest.json'), JSON.stringify({
  images: { spritesheet: '/assets/spritesheet.png' },
  audio: { fire: '/assets/sfx-fire.wav', hit: '/assets/sfx-hit.wav', explosion: '/assets/sfx-explosion.wav' },
  json: { rooms: '/api/rooms' },
}, null, 2));

fs.writeFileSync(path.join('public', 'api', 'rooms.json'), JSON.stringify([
  { id: 'sector-alpha', name: 'Sector Alpha (Training)', asteroidCount: 5, homingRatio: 0.25, players: 2, maxPlayers: 6 },
  { id: 'belt-omega', name: 'Asteroid Belt Omega', asteroidCount: 8, homingRatio: 0.4, players: 4, maxPlayers: 8 },
  { id: 'swarm-core', name: 'Homing Swarm Core', asteroidCount: 10, homingRatio: 0.65, players: 5, maxPlayers: 8 },
], null, 2));

node -v | Out-Null
Write-Host "Assets & config generated!"
