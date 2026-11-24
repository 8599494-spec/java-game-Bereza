import fs from 'node:fs';
import path from 'node:path';
import { PassThrough, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export class NdjsonSerializeTransform extends Transform {
  constructor() {
    super({ writableObjectMode: true, readableObjectMode: false });
  }

  _transform(chunk, _encoding, callback) {
    try {
      const record = {
        ts: new Date().toISOString(),
        ...chunk,
      };
      callback(null, `${JSON.stringify(record)}\n`);
    } catch (error) {
      callback(error);
    }
  }
}

export class MatchLogger {
  #filePath;
  #source;
  #transform;
  #destination;
  #donePromise;
  #closed = false;

  constructor(logDir, roomId) {
    fs.mkdirSync(logDir, { recursive: true });
    const safeId = roomId.replace(/[^a-zA-Z0-9_-]/g, '_');
    this.#filePath = path.join(logDir, `${safeId}.ndjson`);
    this.#source = new PassThrough({ objectMode: true });
    this.#transform = new NdjsonSerializeTransform();
    this.#destination = fs.createWriteStream(this.#filePath, { flags: 'a', encoding: 'utf8' });

    this.#donePromise = pipeline(this.#source, this.#transform, this.#destination).catch((err) => {
      if (err?.code !== 'ERR_STREAM_PREMATURE_CLOSE') {
        console.error(`[MatchLogger:${roomId}] pipeline error:`, err.message);
      }
    });
  }

  get filePath() {
    return this.#filePath;
  }

  write(event) {
    if (this.#closed) return false;
    return this.#source.write(event);
  }

  async close() {
    if (this.#closed) return this.#donePromise;
    this.#closed = true;
    this.#source.end();
    await this.#donePromise;
  }
}

export async function streamReplayToResponse(logDir, roomId, res) {
  const safeId = roomId.replace(/[^a-zA-Z0-9_-]/g, '_');
  const filePath = path.join(logDir, `${safeId}.ndjson`);

  try {
    await fs.promises.access(filePath, fs.constants.R_OK);
  } catch {
    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'Replay log not found for this room yet' }));
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-store',
  });

  const fileStream = fs.createReadStream(filePath, { highWaterMark: 16 * 1024 });
  try {
    await pipeline(fileStream, res);
  } catch (err) {
    if (err?.code !== 'ERR_STREAM_PREMATURE_CLOSE' && err?.code !== 'ECONNRESET') {
      console.error(`[Replay:${roomId}] stream error:`, err.message);
    }
  }
}
