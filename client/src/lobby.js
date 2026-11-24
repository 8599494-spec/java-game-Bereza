import { fetchJson } from "./assets.js";

export class Lobby extends EventTarget {
	#endpoint;
	#rooms = [];
	#selectedRoomId = null;
	#playerName = "Pilot-01";
	#pollTimer = null;
	#sessionController = null;
	#activeRequestController = null;
	#visible = false;

	constructor({ endpoint = "/api/rooms", initialRooms = [] } = {}) {
		super();
		this.#endpoint = endpoint;
		if (initialRooms.length > 0) {
			this.#rooms = initialRooms;
			this.#selectedRoomId = initialRooms[0].id;
		}
	}

	get rooms() {
		return this.#rooms;
	}
	get selectedRoom() {
		return (
			this.#rooms.find((r) => r.id === this.#selectedRoomId) ??
			this.#rooms[0] ??
			null
		);
	}
	get playerName() {
		return this.#playerName;
	}
	setPlayerName(name) {
		this.#playerName = name.trim() || "Pilot-01";
	}
	selectRoom(roomId) {
		this.#selectedRoomId = roomId;
		this.#emitState();
	}

	start({ intervalMs = 3000 } = {}) {
		this.stop();
		this.#visible = true;
		this.#sessionController = new AbortController();
		this.#emitState();
		this.refresh();
		this.#pollTimer = setInterval(() => {
			if (this.#visible) this.refresh();
		}, intervalMs);
	}

	stop() {
		this.#visible = false;
		if (this.#pollTimer !== null) {
			clearInterval(this.#pollTimer);
			this.#pollTimer = null;
		}
		this.#activeRequestController?.abort(
			new DOMException("Lobby closed", "AbortError"),
		);
		this.#sessionController?.abort(
			new DOMException("Lobby closed", "AbortError"),
		);
	}

	async refresh() {
		if (!this.#visible) return;
		this.#activeRequestController?.abort(
			new DOMException("Superseded refresh", "AbortError"),
		);
		const reqController = new AbortController();
		this.#activeRequestController = reqController;

		const timeoutSignal = AbortSignal.timeout(2500);
		const combinedSignal =
			typeof AbortSignal.any === "function"
				? AbortSignal.any([
						this.#sessionController.signal,
						reqController.signal,
						timeoutSignal,
					])
				: reqController.signal;

		try {
			const rooms = await fetchJson(this.#endpoint, { signal: combinedSignal });
			if (!this.#visible) return;
			this.#rooms = rooms;
			if (!this.#selectedRoomId && rooms.length > 0)
				this.#selectedRoomId = rooms[0].id;
			this.#emitState();
		} catch (error) {
			if (error?.name === "AbortError" || !this.#visible) return;
			this.dispatchEvent(
				new CustomEvent("error", { detail: { message: error.message } }),
			);
		}
	}

	join() {
		const room = this.selectedRoom;
		if (!room) return;
		const payload = { playerName: this.#playerName, room };
		this.stop();
		this.dispatchEvent(new CustomEvent("join", { detail: payload }));
	}

	#emitState() {
		this.dispatchEvent(
			new CustomEvent("rooms-updated", {
				detail: {
					rooms: this.#rooms,
					selectedRoomId: this.selectedRoom?.id ?? null,
				},
			}),
		);
	}
}
