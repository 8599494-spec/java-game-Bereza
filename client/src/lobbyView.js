export function mountLobbyView(root, lobby, { onUserGesture } = {}) {
  root.innerHTML = `
    <div class="lobby-card">
      <h2 class="lobby-title">ORBITAL DOGFIGHT — MULTIPLAYER LOBBY</h2>
      <p class="lobby-sub">HTTP GET/POST /api/rooms + WebSocket (/ws) кімнати й чат</p>
      <div class="field-row">
        <input id="pilot-name-input" type="text" maxlength="18" placeholder="Ваш позивний" value="${lobby.playerName}" />
        <button id="refresh-rooms-btn" class="btn btn-secondary" type="button">Refresh</button>
      </div>
      <div class="field-row">
        <input id="new-room-input" type="text" maxlength="28" placeholder="Назва нової кімнати (POST /api/rooms)" />
        <button id="create-room-btn" class="btn btn-secondary" type="button">Create Room</button>
      </div>
      <div id="lobby-status" class="lobby-status"></div>
      <div id="room-list" class="room-list"></div>
      <div id="replay-box" class="replay-box" style="display: none;"></div>
      <div class="field-row" style="margin-bottom: 0; justify-content: space-between;">
        <button id="replay-btn" class="btn btn-secondary" type="button">Stream NDJSON Log</button>
        <button id="join-room-btn" class="btn" type="button">Join Arena</button>
      </div>
    </div>
  `;

  const nameInput = root.querySelector('#pilot-name-input');
  const newRoomInput = root.querySelector('#new-room-input');
  const createRoomBtn = root.querySelector('#create-room-btn');
  const refreshBtn = root.querySelector('#refresh-rooms-btn');
  const replayBtn = root.querySelector('#replay-btn');
  const replayBox = root.querySelector('#replay-box');
  const joinBtn = root.querySelector('#join-room-btn');
  const roomListEl = root.querySelector('#room-list');
  const statusEl = root.querySelector('#lobby-status');

  const renderRooms = (event) => {
    const { rooms, selectedRoomId } = event.detail;
    statusEl.textContent = '';
    joinBtn.disabled = rooms.length === 0;
    roomListEl.innerHTML = rooms
      .map(
        (room) => `
      <div class="room-item ${room.id === selectedRoomId ? 'selected' : ''}" data-room-id="${room.id}">
        <div>
          <strong>${room.name}</strong>
          <div class="room-meta">ID: ${room.id} | Asteroids: ${room.asteroidCount} | Homing: ${Math.round(room.homingRatio * 100)}%</div>
        </div>
        <div>${room.players}/${room.maxPlayers} pilots</div>
      </div>
    `,
      )
      .join('');
  };

  const onError = (event) => {
    statusEl.textContent = `Server notice: ${event.detail.message}`;
  };
  const onRoomClick = (event) => {
    const card = event.target.closest('[data-room-id]');
    if (!card) return;
    onUserGesture?.();
    lobby.selectRoom(card.dataset.roomId);
  };
  const onNameInput = () => lobby.setPlayerName(nameInput.value);
  const onRefreshClick = () => {
    onUserGesture?.();
    lobby.refresh();
  };

  const onCreateRoom = async () => {
    const name = newRoomInput.value.trim();
    if (!name) return;
    onUserGesture?.();
    try {
      const res = await fetch('/api/rooms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, asteroidCount: 7, homingRatio: 0.35 }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const created = await res.json();
      newRoomInput.value = '';
      await lobby.refresh();
      lobby.selectRoom(created.id);
    } catch (err) {
      statusEl.textContent = `Create failed: ${err.message}`;
    }
  };

  const onStreamReplay = async () => {
    const room = lobby.selectedRoom;
    if (!room) return;
    replayBox.style.display = 'block';
    replayBox.textContent = `Streaming /api/replays/${room.id} ...`;
    try {
      const res = await fetch(`/api/replays/${encodeURIComponent(room.id)}`);
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        replayBox.textContent = err.error || `HTTP ${res.status}`;
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let text = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
        replayBox.textContent = text.slice(-1200);
      }
    } catch (err) {
      replayBox.textContent = `Stream error: ${err.message}`;
    }
  };

  const onJoinClick = () => {
    onUserGesture?.();
    lobby.setPlayerName(nameInput.value);
    lobby.join();
  };

  const onJoinComplete = () => {
    root.classList.remove('visible');
    lobby.removeEventListener('rooms-updated', renderRooms);
    lobby.removeEventListener('error', onError);
    lobby.removeEventListener('join', onJoinComplete);
    roomListEl.removeEventListener('click', onRoomClick);
    nameInput.removeEventListener('input', onNameInput);
    refreshBtn.removeEventListener('click', onRefreshClick);
    createRoomBtn.removeEventListener('click', onCreateRoom);
    replayBtn.removeEventListener('click', onStreamReplay);
    joinBtn.removeEventListener('click', onJoinClick);
  };

  lobby.addEventListener('rooms-updated', renderRooms);
  lobby.addEventListener('error', onError);
  lobby.addEventListener('join', onJoinComplete);
  roomListEl.addEventListener('click', onRoomClick);
  nameInput.addEventListener('input', onNameInput);
  refreshBtn.addEventListener('click', onRefreshClick);
  createRoomBtn.addEventListener('click', onCreateRoom);
  replayBtn.addEventListener('click', onStreamReplay);
  joinBtn.addEventListener('click', onJoinClick);
  root.classList.add('visible');
}
