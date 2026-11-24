export function mountLobbyView(root, lobby, { onUserGesture } = {}) {
	root.innerHTML = `
    <div class="lobby-card">
      <h2 class="lobby-title">ORBITAL DOGFIGHT — LOBBY</h2>
      <p class="lobby-sub">Оберіть позивний та сектор арени (автооновлення кожні 3 с через fetch + AbortSignal)</p>
      <div class="field-row">
        <input id="pilot-name-input" type="text" maxlength="18" placeholder="Ваш позивний" value="${lobby.playerName}" />
        <button id="refresh-rooms-btn" class="btn btn-secondary" type="button">Refresh</button>
      </div>
      <div id="lobby-status" class="lobby-status"></div>
      <div id="room-list" class="room-list"></div>
      <div class="field-row" style="margin-bottom: 0; justify-content: flex-end;">
        <button id="join-room-btn" class="btn" type="button">Join Arena</button>
      </div>
    </div>
  `;

	const nameInput = root.querySelector("#pilot-name-input");
	const refreshBtn = root.querySelector("#refresh-rooms-btn");
	const joinBtn = root.querySelector("#join-room-btn");
	const roomListEl = root.querySelector("#room-list");
	const statusEl = root.querySelector("#lobby-status");

	const renderRooms = (event) => {
		const { rooms, selectedRoomId } = event.detail;
		statusEl.textContent = "";
		joinBtn.disabled = rooms.length === 0;
		roomListEl.innerHTML = rooms
			.map(
				(room) => `
      <div class="room-item ${room.id === selectedRoomId ? "selected" : ""}" data-room-id="${room.id}">
        <div>
          <strong>${room.name}</strong>
          <div class="room-meta">Asteroids: ${room.asteroidCount} | Homing threat: ${Math.round(room.homingRatio * 100)}%</div>
        </div>
        <div>${room.players}/${room.maxPlayers} pilots</div>
      </div>
    `,
			)
			.join("");
	};

	const onError = (event) => {
		statusEl.textContent = `Network warning: ${event.detail.message}`;
	};
	const onRoomClick = (event) => {
		const card = event.target.closest("[data-room-id]");
		if (!card) return;
		onUserGesture?.();
		lobby.selectRoom(card.dataset.roomId);
	};
	const onNameInput = () => lobby.setPlayerName(nameInput.value);
	const onRefreshClick = () => {
		onUserGesture?.();
		lobby.refresh();
	};
	const onJoinClick = () => {
		onUserGesture?.();
		lobby.setPlayerName(nameInput.value);
		lobby.join();
	};

	const onJoinComplete = () => {
		root.classList.remove("visible");
		lobby.removeEventListener("rooms-updated", renderRooms);
		lobby.removeEventListener("error", onError);
		lobby.removeEventListener("join", onJoinComplete);
		roomListEl.removeEventListener("click", onRoomClick);
		nameInput.removeEventListener("input", onNameInput);
		refreshBtn.removeEventListener("click", onRefreshClick);
		joinBtn.removeEventListener("click", onJoinClick);
	};

	lobby.addEventListener("rooms-updated", renderRooms);
	lobby.addEventListener("error", onError);
	lobby.addEventListener("join", onJoinComplete);
	roomListEl.addEventListener("click", onRoomClick);
	nameInput.addEventListener("input", onNameInput);
	refreshBtn.addEventListener("click", onRefreshClick);
	joinBtn.addEventListener("click", onJoinClick);
	root.classList.add("visible");
}
