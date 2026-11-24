export function createInput(target = window) {
	const pressed = new Set();

	const onKeyDown = (event) => {
		if (["ArrowUp", "ArrowLeft", "ArrowRight", "Space"].includes(event.code)) {
			event.preventDefault();
		}
		pressed.add(event.code);
	};

	const onKeyUp = (event) => {
		pressed.delete(event.code);
	};

	const onBlur = () => {
		pressed.clear();
	};

	target.addEventListener("keydown", onKeyDown);
	target.addEventListener("keyup", onKeyUp);
	target.addEventListener("blur", onBlur);

	return {
		getState() {
			return {
				thrust: pressed.has("KeyW") || pressed.has("ArrowUp"),
				left: pressed.has("KeyA") || pressed.has("ArrowLeft"),
				right: pressed.has("KeyD") || pressed.has("ArrowRight"),
				fire: pressed.has("Space"),
				fireHoming:
					pressed.has("KeyE") ||
					pressed.has("ShiftLeft") ||
					pressed.has("ShiftRight"),
			};
		},
		destroy() {
			target.removeEventListener("keydown", onKeyDown);
			target.removeEventListener("keyup", onKeyUp);
			target.removeEventListener("blur", onBlur);
		},
	};
}
