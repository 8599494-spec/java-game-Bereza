export class HttpError extends Error {
  constructor(status, url) {
    super(`HTTP ${status} while fetching ${url}`);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
  }
}

export function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export async function withRetry(fn, { retries = 3, baseDelayMs = 150, signal } = {}) {
  let attempt = 0;
  while (true) {
    if (signal?.aborted) {
      throw signal.reason ?? new DOMException('Aborted', 'AbortError');
    }
    try {
      return await fn();
    } catch (error) {
      const isAbort = error?.name === 'AbortError' || signal?.aborted;
      const isClient4xx = error instanceof HttpError && error.status >= 400 && error.status < 500;
      const isBrokenJson = error instanceof SyntaxError;
      if (isAbort || isClient4xx || isBrokenJson || attempt >= retries) {
        throw error;
      }
      const backoff = baseDelayMs * 2 ** attempt;
      const jitter = Math.random() * baseDelayMs;
      attempt += 1;
      await delay(backoff + jitter, signal);
    }
  }
}

export async function fetchJson(url, { signal } = {}) {
  const response = await fetch(url, { signal });
  if (!response.ok) {
    throw new HttpError(response.status, url);
  }
  return response.json();
}

export function loadJson(url, { signal, retries = 2 } = {}) {
  return withRetry(() => fetchJson(url, { signal }), { retries, signal });
}

export function loadImage(url, { signal, retries = 2 } = {}) {
  return withRetry(
    async () => {
      const response = await fetch(url, { signal });
      if (!response.ok) throw new HttpError(response.status, url);
      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      try {
        const img = new Image();
        img.src = objectUrl;
        await img.decode();
        return img;
      } finally {
        URL.revokeObjectURL(objectUrl);
      }
    },
    { retries, signal },
  );
}

export function loadAudio(url, audioContext, { signal, retries = 2 } = {}) {
  return withRetry(
    async () => {
      const response = await fetch(url, { signal });
      if (!response.ok) throw new HttpError(response.status, url);
      const arrayBuffer = await response.arrayBuffer();
      return audioContext.decodeAudioData(arrayBuffer);
    },
    { retries, signal },
  );
}

export async function loadAll(
  manifest,
  { audioContext, signal, onProgress, mode = 'concurrent', allowPartial = false } = {},
) {
  const tasks = [
    ...Object.entries(manifest.images ?? {}).map(([key, url]) => ({
      category: 'images',
      key,
      url,
      run: () => loadImage(url, { signal }),
    })),
    ...Object.entries(manifest.audio ?? {}).map(([key, url]) => ({
      category: 'audio',
      key,
      url,
      run: () => loadAudio(url, audioContext, { signal }),
    })),
    ...Object.entries(manifest.json ?? {}).map(([key, url]) => ({
      category: 'json',
      key,
      url,
      run: () => loadJson(url, { signal }),
    })),
  ];

  const items = tasks.map((t) => ({
    key: `${t.category}:${t.key}`,
    url: t.url,
    status: 'pending',
    error: null,
  }));

  let completed = 0;
  const total = tasks.length;
  const notify = () => {
    onProgress?.({
      completed,
      total,
      ratio: total === 0 ? 1 : completed / total,
      items: items.map((item) => ({ ...item })),
    });
  };
  notify();

  const bundle = { images: {}, audio: {}, json: {}, errors: [] };

  const executeTask = async (task, index) => {
    items[index].status = 'loading';
    notify();
    try {
      const asset = await task.run();
      bundle[task.category][task.key] = asset;
      items[index].status = 'done';
      completed += 1;
      notify();
    } catch (error) {
      items[index].status = 'error';
      items[index].error = error.message;
      bundle.errors.push({ key: items[index].key, error });
      completed += 1;
      notify();
      if (!allowPartial) throw error;
    }
  };

  if (mode === 'sequential') {
    for (let i = 0; i < tasks.length; i += 1) {
      await executeTask(tasks[i], i);
    }
  } else {
    await Promise.all(tasks.map((task, index) => executeTask(task, index)));
  }

  return bundle;
}
