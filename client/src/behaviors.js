import { Entity } from "./entity.js";
import { Vector2 } from "./vector2.js";

function wrapCoord(value, max) {
	if (value < 0) return value + max;
	if (value >= max) return value - max;
	return value;
}

export function createWrapBehavior(arena) {
	return (entity) => {
		entity.pos = new Vector2(
			wrapCoord(entity.pos.x, arena.width),
			wrapCoord(entity.pos.y, arena.height),
		);
	};
}

export function createDragBehavior(linearDrag = 0.985) {
	return (entity, dt) => {
		const damping = linearDrag ** (dt * 60);
		entity.vel = entity.vel.scale(damping);
	};
}

export function createTtlBehavior(seconds) {
	let remaining = seconds;
	return (entity, dt) => {
		remaining -= dt;
		entity.meta.ttl = Math.max(0, remaining);
		if (remaining <= 0) {
			entity.markDead();
		}
	};
}

export function createHomingBehavior({
	targetKind,
	turnRate = 3.5,
	speed = 420,
}) {
	return (entity, dt, world) => {
		let nearest = null;
		let bestDist = Infinity;

		for (const candidate of world.ofKind(targetKind)) {
			if (candidate.id === entity.meta.ownerId) continue;
			const dist = entity.pos.distanceTo(candidate.pos);
			if (dist < bestDist) {
				bestDist = dist;
				nearest = candidate;
			}
		}

		if (!nearest) return;

		const toTarget = nearest.pos.sub(entity.pos).normalize();
		const currentDir =
			entity.vel.len() > 0
				? entity.vel.normalize()
				: Vector2.fromAngle(entity.angle);
		const blendedDir = currentDir
			.add(toTarget.scale(turnRate * dt))
			.normalize();

		entity.vel = blendedDir.scale(speed);
		entity.angle = Math.atan2(blendedDir.y, blendedDir.x);
	};
}

export function createPickupBehavior({ pickupType, amount }) {
	let pulse = 0;
	return (entity, dt) => {
		pulse += dt * 4;
		entity.meta.pickupType = pickupType;
		entity.meta.amount = amount;
		entity.meta.pulse = Math.sin(pulse);
	};
}

export function createBullet({
	pos,
	vel,
	angle,
	ownerId,
	homing = false,
	arena = { width: 900, height: 600 },
}) {
	const bullet = new Entity({
		kind: "bullet",
		pos,
		vel,
		radius: homing ? 5 : 3,
		angle,
		behaviors: [
			createTtlBehavior(homing ? 2.4 : 1.3),
			createWrapBehavior(arena),
		],
	});

	bullet.meta.ownerId = ownerId;
	bullet.meta.homing = homing;

	if (homing) {
		bullet.addBehavior(
			createHomingBehavior({
				targetKind: "asteroid",
				turnRate: 5.5,
				speed: 450,
			}),
		);
	}

	return bullet;
}

export function createAsteroid({
	pos,
	vel,
	radius = 26,
	homing = false,
	arena = { width: 900, height: 600 },
}) {
	const asteroid = new Entity({
		kind: "asteroid",
		pos,
		vel,
		radius,
		angle: Math.random() * Math.PI * 2,
		behaviors: [
			createWrapBehavior(arena),
			(entity, dt) => {
				entity.angle += (homing ? 1.8 : 0.9) * dt;
			},
		],
	});

	asteroid.meta.homing = homing;

	if (homing) {
		asteroid.addBehavior(
			createHomingBehavior({ targetKind: "ship", turnRate: 1.6, speed: 155 }),
		);
	}

	return asteroid;
}

export function createPickup({ pos, pickupType = "heal", amount = 30 }) {
	const pickup = new Entity({
		kind: "pickup",
		pos,
		vel: new Vector2(0, 0),
		radius: 13,
		behaviors: [
			createPickupBehavior({ pickupType, amount }),
			createTtlBehavior(14),
		],
	});
	pickup.meta.pickupType = pickupType;
	pickup.meta.amount = amount;
	return pickup;
}

export function createExplosion(world, pos, color = "#f97316", count = 14) {
	for (let i = 0; i < count; i += 1) {
		const angle = (Math.PI * 2 * i) / count + Math.random() * 0.4;
		const speed = 60 + Math.random() * 190;
		const particle = new Entity({
			kind: "particle",
			pos,
			vel: Vector2.fromAngle(angle, speed),
			radius: 2,
			behaviors: [
				createDragBehavior(0.94),
				createTtlBehavior(0.35 + Math.random() * 0.35),
			],
		});
		particle.meta.color = color;
		world.spawn(particle);
	}
}
