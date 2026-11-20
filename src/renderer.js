function lerp(a, b, t) {
	return a + (b - a) * t;
}

export function createRenderer(canvas, arena) {
	const ctx = canvas.getContext("2d");

	function resize() {
		const dpr = window.devicePixelRatio || 1;
		canvas.style.width = `${arena.width}px`;
		canvas.style.height = `${arena.height}px`;
		canvas.width = Math.floor(arena.width * dpr);
		canvas.height = Math.floor(arena.height * dpr);
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
	}

	resize();
	window.addEventListener("resize", resize);

	return {
		draw(prevShip, currShip, alpha, isThrusting, stats) {
			ctx.fillStyle = "#0b0f19";
			ctx.fillRect(0, 0, arena.width, arena.height);

			const wrappedX = Math.abs(currShip.x - prevShip.x) > arena.width / 2;
			const wrappedY = Math.abs(currShip.y - prevShip.y) > arena.height / 2;

			const x = wrappedX ? currShip.x : lerp(prevShip.x, currShip.x, alpha);
			const y = wrappedY ? currShip.y : lerp(prevShip.y, currShip.y, alpha);
			const angle = lerp(prevShip.angle, currShip.angle, alpha);

			ctx.save();
			ctx.translate(x, y);
			ctx.rotate(angle);

			ctx.strokeStyle = "#38bdf8";
			ctx.lineWidth = 2;
			ctx.beginPath();
			ctx.moveTo(16, 0);
			ctx.lineTo(-12, -10);
			ctx.lineTo(-7, 0);
			ctx.lineTo(-12, 10);
			ctx.closePath();
			ctx.stroke();

			if (isThrusting) {
				ctx.strokeStyle = "#f97316";
				ctx.beginPath();
				ctx.moveTo(-9, -4);
				ctx.lineTo(-20, 0);
				ctx.lineTo(-9, 4);
				ctx.stroke();
			}
			ctx.restore();

			ctx.fillStyle = "#94a3b8";
			ctx.font = "14px monospace";
			ctx.fillText(`steps/s: ${stats.stepsPerSec}`, 16, 24);
			ctx.fillText(`frames/s: ${stats.framesPerSec}`, 16, 44);
			ctx.fillText(`frame time: ${stats.frameTimeMs} ms`, 16, 64);
		},
	};
}
