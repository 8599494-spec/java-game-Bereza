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
		draw(world, ship, hud) {
			ctx.fillStyle = "#0b0f19";
			ctx.fillRect(0, 0, arena.width, arena.height);

			for (const entity of world) {
				if (entity.dead) continue;

				if (entity.kind === "particle") {
					ctx.fillStyle = entity.meta.color || "#f97316";
					ctx.fillRect(entity.pos.x - 1.5, entity.pos.y - 1.5, 3, 3);
					continue;
				}

				if (entity.kind === "pickup") {
					const isHeal = entity.meta.pickupType === "heal";
					const pulseScale = 1 + (entity.meta.pulse || 0) * 0.12;
					ctx.save();
					ctx.translate(entity.pos.x, entity.pos.y);
					ctx.scale(pulseScale, pulseScale);
					ctx.strokeStyle = isHeal ? "#22c55e" : "#eab308";
					ctx.lineWidth = 2;
					ctx.strokeRect(-9, -9, 18, 18);
					ctx.fillStyle = isHeal ? "#22c55e" : "#eab308";
					ctx.font = "bold 12px monospace";
					ctx.textAlign = "center";
					ctx.textBaseline = "middle";
					ctx.fillText(isHeal ? "+" : "H", 0, 1);
					ctx.restore();
					continue;
				}

				if (entity.kind === "asteroid") {
					ctx.save();
					ctx.translate(entity.pos.x, entity.pos.y);
					ctx.rotate(entity.angle);
					ctx.strokeStyle = entity.meta.homing ? "#f43f5e" : "#94a3b8";
					ctx.lineWidth = 2;
					ctx.beginPath();
					const sides = 8;
					for (let i = 0; i < sides; i += 1) {
						const theta = (Math.PI * 2 * i) / sides;
						const r = entity.radius * (i % 2 === 0 ? 1 : 0.82);
						const px = Math.cos(theta) * r;
						const py = Math.sin(theta) * r;
						if (i === 0) ctx.moveTo(px, py);
						else ctx.lineTo(px, py);
					}
					ctx.closePath();
					ctx.stroke();
					ctx.restore();
					continue;
				}

				if (entity.kind === "bullet") {
					ctx.save();
					ctx.translate(entity.pos.x, entity.pos.y);
					ctx.fillStyle = entity.meta.homing ? "#f59e0b" : "#38bdf8";
					ctx.beginPath();
					ctx.arc(0, 0, entity.radius, 0, Math.PI * 2);
					ctx.fill();
					ctx.restore();
					continue;
				}

				if (entity.kind === "ship") {
					if (
						entity.invulnTimer > 0 &&
						Math.floor(entity.invulnTimer * 12) % 2 === 0
					) {
						continue;
					}

					ctx.save();
					ctx.translate(entity.pos.x, entity.pos.y);
					ctx.rotate(entity.angle);

					ctx.strokeStyle = "#38bdf8";
					ctx.lineWidth = 2;
					ctx.beginPath();
					ctx.moveTo(16, 0);
					ctx.lineTo(-12, -10);
					ctx.lineTo(-7, 0);
					ctx.lineTo(-12, 10);
					ctx.closePath();
					ctx.stroke();

					if (hud.isThrusting) {
						ctx.strokeStyle = "#f97316";
						ctx.beginPath();
						ctx.moveTo(-9, -4);
						ctx.lineTo(-20, 0);
						ctx.lineTo(-9, 4);
						ctx.stroke();
					}
					ctx.restore();
				}
			}

			ctx.fillStyle = "#94a3b8";
			ctx.font = "14px monospace";
			ctx.fillText(
				`steps/s: ${hud.stats.stepsPerSec} | frames/s: ${hud.stats.framesPerSec} | ${hud.stats.frameTimeMs} ms`,
				16,
				24,
			);

			ctx.fillStyle = ship.hp > 35 ? "#22c55e" : "#ef4444";
			ctx.fillText(`HP: ${ship.hp}/${ship.maxHp}`, 16, 48);

			ctx.fillStyle = "#38bdf8";
			ctx.fillText(
				`Score: ${hud.score} | Homing [E/Shift]: ${ship.homingAmmo}`,
				16,
				70,
			);

			ctx.fillStyle = "#64748b";
			ctx.font = "12px monospace";
			ctx.fillText(
				"WASD / Arrows: Fly | Space: Fire | E / Shift: Homing Missile",
				16,
				arena.height - 16,
			);

			if (ship.dead) {
				ctx.fillStyle = "#f8fafc";
				ctx.font = "bold 22px monospace";
				ctx.textAlign = "center";
				ctx.fillText(
					`SHIP DESTROYED — RESPAWN IN ${hud.respawnTimer.toFixed(1)}s`,
					arena.width / 2,
					arena.height / 2,
				);
				ctx.textAlign = "left";
			}
		},
	};
}
