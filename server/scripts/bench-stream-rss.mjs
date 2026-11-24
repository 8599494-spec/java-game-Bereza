import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ndjson-rss-bench-'));
const logPath = path.join(tempDir, 'large-match.ndjson');

// 1. Генеруємо великий лог (~32 МБ) через стрімовий pipeline
const TOTAL_LINES = 260_000;
let generated = 0;

const generator = new Transform({
  readableObjectMode: false,
  read() {
    while (generated < TOTAL_LINES) {
      generated += 1;
      const line = `${JSON.stringify({
        seq: generated,
        ts: '2026-11-24T12:00:00.000Z',
        type: 'chat',
        roomId: 'sector-alpha',
        from: `Pilot-${generated % 16}`,
        text: 'Telemetry & chat payload line for backpressure memory test',
      })}\n`;
      if (!this.push(line)) return;
    }
    this.push(null);
  },
});

await pipeline(generator, fs.createWriteStream(logPath));
const fileSizeMb = +(fs.statSync(logPath).size / (1024 * 1024)).toFixed(2);

// 2. Піднімаємо HTTP-сервер, що віддає файл через fs.createReadStream -> pipeline
const server = http.createServer(async (req, res) => {
  if (req.url === '/replay') {
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
    await pipeline(fs.createReadStream(logPath, { highWaterMark: 16 * 1024 }), res);
  }
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();

// 3. Повільний клієнт (~4 МБ/с) читає потік і заміряє RSS процесу
const samples = [];
const t0 = performance.now();
const timer = setInterval(() => {
  samples.push({
    sec: +((performance.now() - t0) / 1000).toFixed(1),
    rssMb: +(process.memoryUsage().rss / (1024 * 1024)).toFixed(2),
  });
}, 250);

await new Promise((resolve, reject) => {
  http.get(`http://127.0.0.1:${port}/replay`, (res) => {
    res.on('data', () => {
      res.pause();
      setTimeout(() => res.resume(), 4);
    });
    res.on('end', resolve);
    res.on('error', reject);
  });
});

clearInterval(timer);
server.close();
fs.rmSync(tempDir, { recursive: true, force: true });

console.log(`Streamed ${fileSizeMb} MB NDJSON file over throttled socket:`);
console.table(samples);
