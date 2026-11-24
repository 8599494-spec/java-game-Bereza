import { MSG_TYPE, decodeBinaryPacket, encodeInputBinary, encodePingPongBinary } from '@game/shared';

export class GameSocket extends EventTarget {
  #url;
  #ws = null;
  #queue = [];
  #reconnectAttempt = 0;
  #reconnectTimer = null;
  #pingTimer = null;
  #manualClose = false;
  #activeJoin = null;
  #useJsonCodec = false;

  #bytesInWindow = 0;
  #bytesOutWindow = 0;
  #bytesInPerSec = 0;
  #bytesOutPerSec = 0;
  #rttMs = 0;

  constructor(path = '/ws', { useJsonCodec = false } = {}) {
    super();
    this.#useJsonCodec = useJsonCodec;
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    this.#url = `${proto}//${window.location.host}${path}`;
    setInterval(() => {
      this.#bytesInPerSec = this.#bytesInWindow;
      this.#bytesOutPerSec = this.#bytesOutWindow;
      this.#bytesInWindow = 0;
      this.#bytesOutWindow = 0;
    }, 1000);
  }

  get useJsonCodec() {
    return this.#useJsonCodec;
  }

  get metrics() {
    return {
      rttMs: this.#rttMs,
      bytesInPerSec: this.#bytesInPerSec,
      bytesOutPerSec: this.#bytesOutPerSec,
      codec: this.#useJsonCodec ? 'JSON' : 'BINARY (DataView)',
    };
  }

  setCodec(useJson) {
    this.#useJsonCodec = Boolean(useJson);
    this.sendControl({ type: 'codec', codec: this.#useJsonCodec ? 'json' : 'binary' });
  }

  connect() {
    this.#manualClose = false;
    if (
      this.#ws &&
      (this.#ws.readyState === WebSocket.OPEN || this.#ws.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }

    this.#emitStatus('connecting');
    const ws = new WebSocket(this.#url);
    ws.binaryType = 'arraybuffer';
    this.#ws = ws;

    ws.addEventListener('open', () => {
      this.#reconnectAttempt = 0;
      this.#emitStatus('connected');

      if (this.#activeJoin) {
        this.#sendRawText(
          JSON.stringify({
            type: 'join',
            ...this.#activeJoin,
            codec: this.#useJsonCodec ? 'json' : 'binary',
          }),
        );
      }

      while (this.#queue.length > 0 && ws.readyState === WebSocket.OPEN) {
        this.#sendRawText(this.#queue.shift());
      }

      this.#startPingLoop();
    });

    ws.addEventListener('message', (event) => {
      if (event.data instanceof ArrayBuffer) {
        this.#bytesInWindow += event.data.byteLength;
        try {
          const packet = decodeBinaryPacket(event.data);
          if (packet.kind === 'pong') {
            const sample = performance.now() - packet.clientTimeMs;
            this.#rttMs = this.#rttMs === 0 ? sample : this.#rttMs * 0.75 + sample * 0.25;
            return;
          }
          if (packet.kind === 'snapshot') {
            this.dispatchEvent(new CustomEvent('snapshot', { detail: packet }));
          }
        } catch {
          // Ігноруємо пошкоджений бінарний фрейм
        }
        return;
      }

      if (typeof event.data === 'string') {
        this.#bytesInWindow += event.data.length;
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'pong') {
            const sample = performance.now() - msg.clientTimeMs;
            this.#rttMs = this.#rttMs === 0 ? sample : this.#rttMs * 0.75 + sample * 0.25;
            return;
          }
          if (msg.type === 'snapshot') {
            this.dispatchEvent(new CustomEvent('snapshot', { detail: msg }));
            return;
          }
          this.dispatchEvent(new CustomEvent('message', { detail: msg }));
        } catch {
          // Ігноруємо пошкоджений JSON
        }
      }
    });

    ws.addEventListener('close', (event) => {
      this.#stopPingLoop();
      this.#emitStatus('disconnected', event.reason || `code ${event.code}`);
      if (!this.#manualClose && event.code !== 1008 && event.code !== 1003) {
        this.#scheduleReconnect();
      }
    });
  }

  joinRoom(roomId, playerName) {
    this.#activeJoin = { roomId, playerName };
    if (this.#ws?.readyState === WebSocket.OPEN) {
      this.#sendRawText(
        JSON.stringify({
          type: 'join',
          roomId,
          playerName,
          codec: this.#useJsonCodec ? 'json' : 'binary',
        }),
      );
    } else {
      this.connect();
    }
  }

  sendInput(input) {
    if (this.#ws?.readyState !== WebSocket.OPEN) return;
    if (this.#useJsonCodec) {
      this.#sendRawText(JSON.stringify({ type: 'input', ...input }));
    } else {
      const buf = encodeInputBinary(input);
      this.#bytesOutWindow += buf.byteLength;
      this.#ws.send(buf);
    }
  }

  sendControl(payload) {
    const serialized = JSON.stringify(payload);
    if (this.#ws?.readyState === WebSocket.OPEN) {
      this.#sendRawText(serialized);
      return;
    }
    if (this.#queue.length < 100) {
      this.#queue.push(serialized);
    }
    this.connect();
  }

  close() {
    this.#manualClose = true;
    this.#activeJoin = null;
    this.#queue.length = 0;
    this.#stopPingLoop();
    if (this.#reconnectTimer !== null) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }
    if (this.#ws) {
      this.#ws.close(1000, 'Client disconnect');
      this.#ws = null;
    }
  }

  #sendRawText(str) {
    if (this.#ws?.readyState === WebSocket.OPEN) {
      this.#bytesOutWindow += str.length;
      this.#ws.send(str);
    }
  }

  #startPingLoop() {
    this.#stopPingLoop();
    const sendPing = () => {
      if (this.#ws?.readyState !== WebSocket.OPEN) return;
      const now = performance.now();
      if (this.#useJsonCodec) {
        this.#sendRawText(JSON.stringify({ type: 'ping', clientTimeMs: now }));
      } else {
        const buf = encodePingPongBinary(MSG_TYPE.PING, now);
        this.#bytesOutWindow += buf.byteLength;
        this.#ws.send(buf);
      }
    };
    sendPing();
    this.#pingTimer = setInterval(sendPing, 500);
  }

  #stopPingLoop() {
    if (this.#pingTimer !== null) {
      clearInterval(this.#pingTimer);
      this.#pingTimer = null;
    }
  }

  #scheduleReconnect() {
    if (this.#reconnectTimer !== null) return;
    const baseDelay = Math.min(1000 * 2 ** this.#reconnectAttempt, 15000);
    const jitter = Math.random() * 400;
    this.#reconnectAttempt += 1;

    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      if (!this.#manualClose) {
        this.connect();
      }
    }, baseDelay + jitter);
  }

  #emitStatus(status, detail = '') {
    this.dispatchEvent(new CustomEvent('status', { detail: { status, detail } }));
  }
}
