export class GameSocket extends EventTarget {
  #url;
  #ws = null;
  #queue = [];
  #reconnectAttempt = 0;
  #reconnectTimer = null;
  #manualClose = false;
  #activeJoin = null;

  constructor(path = '/ws') {
    super();
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    this.#url = `${proto}//${window.location.host}${path}`;
  }

  get state() {
    if (!this.#ws) return 'disconnected';
    if (this.#ws.readyState === WebSocket.OPEN) return 'connected';
    if (this.#ws.readyState === WebSocket.CONNECTING) return 'connecting';
    return 'disconnected';
  }

  connect() {
    this.#manualClose = false;
    if (this.#ws && (this.#ws.readyState === WebSocket.OPEN || this.#ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    this.#emitStatus('connecting');
    const ws = new WebSocket(this.#url);
    this.#ws = ws;

    ws.addEventListener('open', () => {
      this.#reconnectAttempt = 0;
      this.#emitStatus('connected');

      if (this.#activeJoin) {
        ws.send(JSON.stringify({ type: 'join', ...this.#activeJoin }));
      }

      while (this.#queue.length > 0 && ws.readyState === WebSocket.OPEN) {
        ws.send(this.#queue.shift());
      }
    });

    ws.addEventListener('message', (event) => {
      try {
        const msg = JSON.parse(event.data);
        this.dispatchEvent(new CustomEvent('message', { detail: msg }));
      } catch {
        // Ігноруємо пошкоджені фрейми
      }
    });

    ws.addEventListener('close', (event) => {
      this.#emitStatus('disconnected', event.reason || `code ${event.code}`);
      if (!this.#manualClose && event.code !== 1008 && event.code !== 1003) {
        this.#scheduleReconnect();
      }
    });
  }

  joinRoom(roomId, playerName) {
    this.#activeJoin = { roomId, playerName };
    if (this.#ws?.readyState === WebSocket.OPEN) {
      this.#ws.send(JSON.stringify({ type: 'join', roomId, playerName }));
    } else {
      this.connect();
    }
  }

  send(payload) {
    const serialized = JSON.stringify(payload);
    if (this.#ws?.readyState === WebSocket.OPEN) {
      this.#ws.send(serialized);
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
    if (this.#reconnectTimer !== null) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }
    if (this.#ws) {
      this.#ws.close(1000, 'Client disconnect');
      this.#ws = null;
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
