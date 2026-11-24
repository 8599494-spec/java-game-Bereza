export function createRenderer(canvas, arena) {
	const ctx = canvas.getContext("2d");
	let spriteSheet = null;

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
		setSpriteSheet(img) {
			spriteSheet = img;
		},

		drawLoading({
			title = "LOADING ASSETS...",
			progress,
			errorMessage = null,
		}) {
			ctx.fillStyle = "#050811";
			ctx.fillRect(0, 0, arena.width, arena.height);

			const barW = 480;
			const barH = 22;
			const barX = (arena.width - barW) / 2;
			const barY = 210;
			const ratio = progress?.ratio ?? 0;

			ctx.fillStyle = "#38bdf8";
			ctx.font = "bold 20px monospace";
			ctx.textAlign = "center";
			ctx.fillText(title, arena.width / 2, 175);

			ctx.strokeStyle = "#334155";
			ctx.lineWidth = 2;
			ctx.strokeRect(barX, barY, barW, barH);

			ctx.fillStyle = errorMessage ? "#ef4444" : "#0284c7";
			ctx.fillRect(
				barX + 2,
				barY + 2,
				Math.max(0, (barW - 4) * ratio),
				barH - 4,
			);

			ctx.fillStyle = "#e2e8f0";
			ctx.font = "13px monospace";
			ctx.fillText(
				`${Math.round(ratio * 100)}% (${progress?.completed ?? 0}/${progress?.total ?? 0} assets)`,
				arena.width / 2,
				barY + 44,
			);

			ctx.textAlign = "left";
			for (const [idx, item] of (progress?.items ?? []).entries()) {
				const y = 290 + idx * 24;
				const badge =
					item.status === "done"
						? "[OK]"
						: item.status === "error"
							? "[ERR]"
							: item.status === "loading"
								? "[..]"
								: "[  ]";
				ctx.fillStyle =
					item.status === "done"
						? "#22c55e"
						: item.status === "error"
							? "#f87171"
							: "#94a3b8";
				ctx.fillText(`${badge} ${item.key} -> ${item.url}`, barX, y);
			}

			if (errorMessage) {
				ctx.fillStyle = "#fca5a5";
				ctx.textAlign = "center";
				ctx.fillText(`Failure: ${errorMessage}`, arena.width / 2, 465);
				ctx.textAlign = "left";
			}
		},

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
					if (spriteSheet) {
						const sx = entity.meta.homing ? 192 : 128;
						const size = entity.radius * 2.4;
						ctx.drawImage(
							spriteSheet,
							sx,
							0,
							64,
							64,
							-size / 2,
							-size / 2,
							size,
							size,
						);
					} else {
						ctx.strokeStyle = entity.meta.homing ? "#f43f5e" : "#94a3b8";
						ctx.lineWidth = 2;
						ctx.beginPath();
						ctx.arc(0, 0, entity.radius, 0, Math.PI * 2);
						ctx.stroke();
					}
					ctx.restore();
					continue;
				}

				if (entity.kind === "bullet") {
					ctx.save();
					ctx.translate(entity.pos.x, entity.pos.y);
					ctx.rotate(entity.angle);
					if (spriteSheet) {
						const sy = entity.meta.homing ? 32 : 0;
						ctx.drawImage(spriteSheet, 64, sy, 64, 32, -16, -8, 32, 16);
					} else {
						ctx.fillStyle = entity.meta.homing ? "#f59e0b" : "#38bdf8";
						ctx.beginPath();
						ctx.arc(0, 0, entity.radius, 0, Math.PI * 2);
						ctx.fill();
					}
					ctx.restore();
					continue;
				}

				if (entity.kind === "ship") {
					if (
						entity.invulnTimer > 0 &&
						Math.floor(entity.invulnTimer * 12) % 2 === 0
					)
						continue;
					ctx.save();
					ctx.translate(entity.pos.x, entity.pos.y);
					ctx.rotate(entity.angle);
					if (spriteSheet) {
						ctx.drawImage(spriteSheet, 0, 0, 64, 64, -24, -24, 48, 48);
					} else {
						ctx.strokeStyle = "#38bdf8";
						ctx.lineWidth = 2;
						ctx.beginPath();
						ctx.moveTo(16, 0);
						ctx.lineTo(-12, -10);
						ctx.lineTo(-12, 10);
						ctx.closePath();
						ctx.stroke();
					}
					if (hud.isThrusting) {
						ctx.strokeStyle = "#f97316";
						ctx.lineWidth = 2;
						ctx.beginPath();
						ctx.moveTo(-12, -4);
						ctx.lineTo(-22, 0);
						ctx.lineTo(-12, 4);
						ctx.stroke();
					}
					ctx.restore();
				}
			}

			ctx.fillStyle = "#94a3b8";
			ctx.font = "14px monospace";
			ctx.fillText(
				`Pilot: ${hud.playerName} | Room: ${hud.roomName} | ${hud.stats.framesPerSec} FPS`,
				16,
				24,
			);
			ctx.fillStyle = ship.hp > 35 ? "#22c55e" : "#ef4444";
			ctx.fillText(`HP: ${ship.hp}/${ship.maxHp}`, 16, 48);
			ctx.fillStyle = "#38bdf8";
			ctx.fillText(
				`Score: ${hud.score} | Homing [E/Shift]: ${ship.homingAmmo} | Sound [M]: ${hud.muted ? "OFF" : "ON"}`,
				16,
				70,
			);
			ctx.fillStyle = "#64748b";
			ctx.font = "12px monospace";
			ctx.fillText(
				"WASD / Arrows: Fly | Space: Fire | E/Shift: Homing | M: Mute | ?fail=404|timeout|abort|json",
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
