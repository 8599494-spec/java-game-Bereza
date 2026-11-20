import { createExplosion, createPickup } from "./behaviors.js";

export function circlesOverlap(a, b) {
	return a.pos.distanceTo(b.pos) < a.radius + b.radius;
}

export function resolveCollisions(world, onScore) {
	const entities = [...world];

	for (let i = 0; i < entities.length; i += 1) {
		const a = entities[i];
		if (a.dead) continue;

		for (let j = i + 1; j < entities.length; j += 1) {
			const b = entities[j];
			if (b.dead) continue;
			if (!circlesOverlap(a, b)) continue;

			handlePair(a, b, world, onScore);
		}
	}
}

function handlePair(a, b, world, onScore) {
	const pair = [a, b];
	const bullet = pair.find((e) => e.kind === "bullet");
	const asteroid = pair.find((e) => e.kind === "asteroid");
	const ship = pair.find((e) => e.kind === "ship");
	const pickup = pair.find((e) => e.kind === "pickup");

	if (bullet && asteroid) {
		bullet.markDead();
		asteroid.markDead();
		createExplosion(
			world,
			asteroid.pos,
			asteroid.meta.homing ? "#f43f5e" : "#38bdf8",
			16,
		);
		onScore?.(asteroid.meta.homing ? 200 : 100);

		if (Math.random() < 0.45) {
			const pickupType = Math.random() < 0.5 ? "heal" : "ammo";
			world.spawn(
				createPickup({
					pos: asteroid.pos,
					pickupType,
					amount: pickupType === "heal" ? 30 : 3,
				}),
			);
		}
		return;
	}

	if (ship && asteroid) {
		asteroid.markDead();
		ship.takeDamage(35);
		createExplosion(world, asteroid.pos, "#f97316", 18);
		if (ship.dead) {
			createExplosion(world, ship.pos, "#ef4444", 32);
		}
		return;
	}

	if (ship && pickup) {
		if (pickup.meta.pickupType === "heal") {
			ship.heal(pickup.meta.amount);
			createExplosion(world, pickup.pos, "#22c55e", 10);
		} else {
			ship.homingAmmo += pickup.meta.amount;
			createExplosion(world, pickup.pos, "#eab308", 10);
		}
		pickup.markDead();
	}
}
