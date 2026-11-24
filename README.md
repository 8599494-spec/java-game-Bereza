# Space Dogfight — Multiplayer Authoritative WebSocket Game

Багатокористувацька космічна аркада в реальному часі з авторитативним сервером (30 Hz), клієнтським передбаченням і реконсиліацією, інтерполяцією сутностей, компенсацією затримки (lag compensation), бінарним мережевим протоколом, Prometheus-метриками та підтримкою **PWA** (встановлення як окремого застосунку й офлайн-оболонка).

## Live Deployment (Production)

- **Ігровий клієнт (HTTPS + PWA):** https://java-game-bereza.onrender.com/
- **WebSocket-сервер (WSS):** `wss://java-game-bereza.onrender.com/ws`
- **Liveness Probe:** https://java-game-bereza.onrender.com/health
- **Readiness Probe:** https://java-game-bereza.onrender.com/ready
- **Prometheus Metrics:** https://java-game-bereza.onrender.com/metrics
- **Container Image (GHCR):** `ghcr.io/8599494-spec/java-game-bereza:lab-08` (також `:latest`)

---

## Архітектура проєкту

Монорепозиторій організовано у вигляді npm workspaces:

- `shared/` — детермінована симуляція (`sim.ts`), фіксований крок 30 Hz, просторове хешування колізій (`spatialHash.ts`), пул об'єктів (`pool.ts`), детермінований PRNG (`prng.ts`), бінарний кодек (`codec.ts`) із JSON-фолбеком, схеми валідації Zod (`protocol.ts`) та token-bucket rate limiter.
- `server/` — авторитативний ігровий цикл (`room.ts`), менеджер кімнат (`match.ts`), AI-боти (`bot.ts`), HTTP/WS-сервер (`httpServer.ts`, `wsServer.ts`), структуроване JSON-логування (`logger.ts`), метрики Prometheus (`metrics.ts`), graceful shutdown (`shutdown.ts`).
- `client/` — рендеринг на HTML5 Canvas, локальне передбачення руху (client-side prediction), інтерполяція віддалених кораблів, HUD телеметрії (RTT, jitter, packet loss, FPS), PWA маніфест (`public/manifest.webmanifest`) і Service Worker (`public/sw.js`).
- `e2e/` — наскрізні тести Playwright (мультиплеєр між двома браузерами, `/health`, `/ready`, `/metrics`, PWA маніфест, Service Worker і режим `offline`).

---

## Локальний запуск та розробка

### Вимоги
- **Node.js** `>= 22` (у продакшені використовується `Node.js 24 LTS`)
- **npm** `>= 10`

### Встановлення та запуск у dev-режимі
```bash
npm install
npm run dev
```
Після запуску клієнт і сервер доступні на `http://localhost:3000`.

### Перевірка якості коду та тестування
```bash
npm run check         # Лінтинг та форматування (Biome)
npm run typecheck     # Перевірка типів TypeScript у всіх пакетах
npm test              # 60 тестів Vitest (unit, property-based, integration, chaos)
npm run test:e2e      # E2E-тести Playwright (мультиплеєр + PWA + telemetry)
```

### Продакшн-збірка
```bash
npm run build         # Збірка клієнта (Vite -> client/dist)
npm run build:server  # Компіляція shared та server (TypeScript -> dist)
NODE_ENV=production ALLOWED_ORIGINS=http://localhost:3000 npm start
```

---

## Docker та Container Registry

Образ збирається багатоетапним `Dockerfile` на базі `node:24-alpine` (фінальний розмір `< 200 MB`), працює від непривілейованого користувача `node` і містить вбудований `HEALTHCHECK`.

### Запуск через Docker Compose
```bash
docker compose up --build
```

### Запуск готового образу з GHCR
```bash
docker pull ghcr.io/8599494-spec/java-game-bereza:lab-08
docker run --rm -p 3000:3000 \
  -e NODE_ENV=production \
  -e ALLOWED_ORIGINS=http://localhost:3000 \
  ghcr.io/8599494-spec/java-game-bereza:lab-08
```

---

## Конфігурація середовища

| Змінна | За замовчуванням | Опис |
| :--- | :--- | :--- |
| `PORT` | `3000` | HTTP/WebSocket порт сервера |
| `NODE_ENV` | `development` | Режим роботи (`development` / `production` / `test`) |
| `ALLOWED_ORIGINS` | `*` у dev | Обов'язковий список дозволених `Origin` через кому у `production` |
| `LOG_LEVEL` | `info` | Рівень структурованих JSON-логів (`debug`, `info`, `warn`, `error`) |
| `MAX_CONNECTIONS_PER_IP` | `16` | Максимум одночасних WebSocket-з'єднань з однієї IP-адреси |
| `MAX_ROOMS` | `32` | Максимальна кількість активних ігрових кімнат |
| `MAX_PLAYERS_PER_ROOM` | `160` | Максимальна кількість гравців і ботів в одній кімнаті |

---

## PWA та офлайн-режим

- **Встановлення:** відкрийте https://java-game-bereza.onrender.com/ у Chrome/Edge/Safari та натисніть **Install App** у верхній панелі гри (або іконку встановлення в адресному рядку), щоб запустити гру в окремому вікні (`display: standalone`).
- **Кешування (`sw.js`):** статичні ресурси (JS, CSS, іконки, маніфест) обслуговуються за стратегією *cache-first*, навігація HTML — *network-first* із резервним поверненням закешованої оболонки при втраті мережі.

---

## Production Runbook

### 1. Перевірка стану сервісу
- **`GET /health`** — повертає `200 OK` з JSON-метриками процесу (`uptimeSec`, `rssMB`, `heapUsedMB`, `eventLoopUtilization`). Якщо ендпоінт не відповідає, оркестратор перезапускає контейнер.
- **`GET /ready`** — повертає `200 OK` (`{"ready":true}`), коли сервер приймає підключення, та `503 Service Unavailable` під час завершення роботи (`SIGTERM`/`SIGINT`).
- **`GET /metrics`** — віддає метрики у форматі Prometheus:
  - `game_connected_players` — поточна кількість підключених гравців
  - `game_active_rooms` — кількість активних кімнат
  - `game_tick_duration_seconds` — гістограма тривалості серверного тіку (бюджет 33.3 мс для 30 Hz)
  - `game_ws_messages_total` — лічильник вхідних/вихідних WebSocket-повідомлень

### 2. Типові інциденти та дії
- **WebSocket повертає `403 Forbidden` у продакшені:** перевірте точний збіг заголовка `Origin` браузера зі значенням `ALLOWED_ORIGINS` (протокол `https://`, домен, без завершального `/`).
- **Зростання `game_tick_duration_seconds` (> 0.033 с):** перевірте кількість активних ботів або гравців у кімнаті (`POST/DELETE /api/rooms/:room/bots`) та за потреби зменште `MAX_PLAYERS_PER_ROOM`.
- **Холодний старт на Render Free Tier:** після 15 хвилин неактивності інстанс засинає; перший запит пробуджує контейнер за ~20–40 секунд, після чого `/health` і `/ws` працюють у штатному режимі.
- **Відкат релізу (Rollback):** у GitHub Container Registry збережено незмінні теги релізів (`:lab-08` та `:sha-<commit>`), на які можна миттєво перемкнути деплой у разі регресії.