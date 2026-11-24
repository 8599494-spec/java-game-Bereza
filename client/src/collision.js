import { createExplosion, createPickup } from "./behaviors.js";

export function circlesOverlap(a, b) {
	return a.pos.distanceTo(b.pos) < a.radius + b.radius;
}

export function resolveCollisions(world) {
	const entities = [...world];
	for (let i = 0; i < entities.length; i += 1) {
		const a = entities[i];
		if (a.dead) continue;
		for (let j = i + 1; j < entities.length; j += 1) {
			const b = entities[j];
			if (b.dead || !circlesOverlap(a, b)) continue;
			handlePair(a, b, world);
		}
	}
}

function handlePair(a, b, world) {
	const pair = [a, b];
	const bullet = pair.find((e) => e.kind === "bullet");
	const asteroid = pair.find((e) => e.kind === "asteroid");
	const ship = pair.find((e) => e.kind === "ship");
	const pickup = pair.find((e) => e.kind === "pickup");

	if (bullet && asteroid) {
		bullet.markDead();
		asteroid.markDead();
		const score = asteroid.meta.homing ? 200 : 100;
		createExplosion(
			world,
			asteroid.pos,
			asteroid.meta.homing ? "#f43f5e" : "#38bdf8",
			16,
		);
		world.events?.emit("hit", { targetKind: "asteroid", pos: asteroid.pos });
		world.events?.emit("exploded", {
			kind: "asteroid",
			pos: asteroid.pos,
			score,
		});
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
		world.events?.emit("hit", {
			targetKind: "ship",
			damage: 35,
			pos: ship.pos,
		});
		if (ship.dead) {
			createExplosion(world, ship.pos, "#ef4444", 32);
			world.events?.emit("exploded", { kind: "ship", pos: ship.pos, score: 0 });
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
		world.events?.emit("hit", { targetKind: "pickup", pos: pickup.pos });
		pickup.markDead();
	}
}
