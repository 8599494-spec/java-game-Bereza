import { ENTITY_KIND } from '@game/shared';

export function createRenderer(canvas, arena) {
  const ctx = canvas.getContext('2d');
  let spriteSheet = null;

  const stars = Array.from({ length: 85 }, (_, i) => ({
    x: (i * 197) % arena.width,
    y: (i * 313) % arena.height,
    r: i % 3 === 0 ? 1.6 : 1.0,
    alpha: 0.35 + (i % 5) * 0.12,
  }));

  function drawShip(ship, { isLocal = false } = {}) {
    if (!ship.alive) return;
    ctx.save();
    ctx.translate(ship.x, ship.y);

    // Смужка HP над кораблем
    const hpRatio = Math.max(0, Math.min(1, (ship.hp ?? ship.extra ?? 100) / 100));
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(-18, -28, 36, 4);
    ctx.fillStyle = isLocal ? '#22c55e' : '#f59e0b';
    ctx.fillRect(-18, -28, 36 * hpRatio, 4);

    if (ship.name) {
      ctx.font = '10px ui-monospace, monospace';
      ctx.fillStyle = isLocal ? '#38bdf8' : '#fbbf24';
      ctx.textAlign = 'center';
      ctx.fillText(ship.name, 0, -33);
    }

    ctx.rotate(ship.angle);

    // Полум'я двигуна
    if (ship.thrusting || ship.special) {
      ctx.fillStyle = '#f97316';
      ctx.beginPath();
      ctx.moveTo(-14, -5);
      ctx.lineTo(-24 - Math.random() * 6, 0);
      ctx.lineTo(-14, 5);
      ctx.closePath();
      ctx.fill();
    }

    if (spriteSheet) {
      ctx.drawImage(spriteSheet, 0, 0, 64, 64, -24, -24, 48, 48);
    } else {
      ctx.strokeStyle = isLocal ? '#38bdf8' : '#f59e0b';
      ctx.fillStyle = isLocal ? 'rgba(56, 189, 248, 0.25)' : 'rgba(245, 158, 11, 0.25)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(18, 0);
      ctx.lineTo(-14, -12);
      ctx.lineTo(-8, 0);
      ctx.lineTo(-14, 12);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawAsteroid(ast) {
    const r = ast.extra || ast.radius || 24;
    ctx.save();
    ctx.translate(ast.x, ast.y);
    if (spriteSheet) {
      const sx = ast.special ? 192 : 128;
      ctx.drawImage(spriteSheet, sx, 0, 64, 64, -r, -r, r * 2, r * 2);
    } else {
      ctx.strokeStyle = ast.special ? '#f43f5e' : '#94a3b8';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawBullet(b, { predicted = false } = {}) {
    ctx.save();
    ctx.translate(b.x, b.y);
    ctx.fillStyle = predicted ? '#38bdf8' : b.special ? '#f59e0b' : '#f8fafc';
    ctx.beginPath();
    ctx.arc(0, 0, b.special ? 4.5 : 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  return {
    setSpriteSheet(img) {
      spriteSheet = img;
    },

    drawLoading({ title, progress, errorMessage = '' }) {
      ctx.fillStyle = '#050811';
      ctx.fillRect(0, 0, arena.width, arena.height);
      ctx.textAlign = 'center';
      ctx.font = 'bold 20px ui-monospace, monospace';
      ctx.fillStyle = '#38bdf8';
      ctx.fillText(title, arena.width / 2, 180);

      const barW = 460;
      const barH = 18;
      const bx = (arena.width - barW) / 2;
      const by = 215;
      ctx.strokeStyle = '#334155';
      ctx.strokeRect(bx, by, barW, barH);
      ctx.fillStyle = '#0284c7';
      ctx.fillRect(bx + 2, by + 2, (barW - 4) * (progress.ratio ?? 0), barH - 4);

      ctx.font = '13px ui-monospace, monospace';
      ctx.fillStyle = '#cbd5e1';
      ctx.fillText(
        `${Math.round((progress.ratio ?? 0) * 100)}% (${progress.completed}/${progress.total} assets)`,
        arena.width / 2,
        258,
      );

      if (errorMessage) {
        ctx.fillStyle = '#f87171';
        ctx.fillText(`Failure: ${errorMessage}`, arena.width / 2, 390);
      }
    },

    drawMultiplayer({ localShip, remoteEntities, predictedBullets, hud, netgraph, netMetrics }) {
      ctx.fillStyle = '#050811';
      ctx.fillRect(0, 0, arena.width, arena.height);

      for (const st of stars) {
        ctx.fillStyle = `rgba(226, 232, 240, ${st.alpha})`;
        ctx.fillRect(st.x, st.y, st.r, st.r);
      }

      for (const e of remoteEntities) {
        if (e.kind === ENTITY_KIND.ASTEROID) drawAsteroid(e);
        else if (e.kind === ENTITY_KIND.BULLET) drawBullet(e);
        else if (e.kind === ENTITY_KIND.SHIP) drawShip(e, { isLocal: false });
      }

      for (const pb of predictedBullets) {
        drawBullet(pb, { predicted: true });
      }

      if (localShip) {
        drawShip(localShip, { isLocal: true });
      }

      // Верхній HUD
      ctx.save();
      ctx.fillStyle = 'rgba(2, 6, 23, 0.78)';
      ctx.fillRect(0, 0, arena.width, 46);
      ctx.font = '12px ui-monospace, monospace';
      ctx.fillStyle = '#e2e8f0';
      ctx.textAlign = 'left';
      ctx.fillText(
        `PILOT: ${hud.playerName} | ROOM: ${hud.roomName} | HP: ${localShip?.hp ?? 0} | SCORE: ${localShip?.score ?? 0}`,
        14,
        20,
      );
      ctx.fillStyle = '#94a3b8';
      ctx.fillText(
        `FPS: ${hud.fps} | Server: 30 Hz | [WASD/Arrows] Fly  [Space/E] Fire  [Enter] Chat  [M] Mute`,
        14,
        37,
      );

      if (localShip && !localShip.alive) {
        ctx.textAlign = 'center';
        ctx.font = 'bold 22px ui-monospace, monospace';
        ctx.fillStyle = '#f43f5e';
        ctx.fillText('SHIP DESTROYED — RESPAWNING ON SERVER...', arena.width / 2, arena.height / 2);
      }
      ctx.restore();

      if (netgraph && netMetrics) {
        netgraph.draw(ctx, netMetrics);
      }
    },
  };
}
