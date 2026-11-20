import { Vector2 } from "./vector2.js";

export class Entity {
	static #nextId = 1;
	#id;

	constructor({
		kind,
		pos = new Vector2(0, 0),
		vel = new Vector2(0, 0),
		radius = 10,
		angle = 0,
		behaviors = [],
	}) {
		this.#id = Entity.#nextId;
		Entity.#nextId += 1;
		this.kind = kind;
		this.pos = pos;
		this.vel = vel;
		this.radius = radius;
		this.angle = angle;
		this.dead = false;
		this.meta = {};
		this.behaviors = [...behaviors];
	}

	get id() {
		return this.#id;
	}

	addBehavior(behavior) {
		this.behaviors.push(behavior);
		return this;
	}

	markDead() {
		this.dead = true;
	}

	update(dt, world) {
		if (this.dead) return;
		this.pos = this.pos.add(this.vel.scale(dt));
		for (const behavior of this.behaviors) {
			behavior(this, dt, world);
		}
	}
}

export class Ship extends Entity {
	#hp;
	#maxHp;

	constructor({ pos, maxHp = 100, behaviors = [] }) {
		super({
			kind: "ship",
			pos,
			vel: new Vector2(0, 0),
			radius: 14,
			angle: -Math.PI / 2,
			behaviors,
		});
		this.#maxHp = maxHp;
		this.#hp = maxHp;
		this.turnSpeed = 4.2;
		this.thrustAccel = 340;
		this.maxSpeed = 440;
		this.fireCooldown = 0;
		this.homingAmmo = 3;
		this.invulnTimer = 0;
	}

	get hp() {
		return this.#hp;
	}

	get maxHp() {
		return this.#maxHp;
	}

	takeDamage(amount) {
		if (this.dead || this.invulnTimer > 0) return;
		this.#hp = Math.max(0, this.#hp - amount);
		if (this.#hp === 0) {
			this.markDead();
		}
	}

	heal(amount) {
		if (this.dead) return;
		this.#hp = Math.min(this.#maxHp, this.#hp + amount);
	}

	reset(pos) {
		this.pos = pos;
		this.vel = new Vector2(0, 0);
		this.angle = -Math.PI / 2;
		this.#hp = this.#maxHp;
		this.dead = false;
		this.fireCooldown = 0;
		this.invulnTimer = 1.5;
	}

	control(input, dt) {
		if (this.dead) return;
		const turnDir = (input.right ? 1 : 0) - (input.left ? 1 : 0);
		this.angle += turnDir * this.turnSpeed * dt;

		if (input.thrust) {
			const accel = Vector2.fromAngle(this.angle, this.thrustAccel * dt);
			this.vel = this.vel.add(accel);
		}

		if (this.vel.len() > this.maxSpeed) {
			this.vel = this.vel.normalize().scale(this.maxSpeed);
		}
	}

	fire(world, { homing = false, createBulletFn } = {}) {
		if (this.dead || this.fireCooldown > 0 || !createBulletFn) return null;
		if (homing && this.homingAmmo <= 0) return null;

		if (homing) {
			this.homingAmmo -= 1;
			this.fireCooldown = 0.45;
		} else {
			this.fireCooldown = 0.16;
		}

		const nosePos = this.pos.add(
			Vector2.fromAngle(this.angle, this.radius + 8),
		);
		const bulletVel = this.vel.add(
			Vector2.fromAngle(this.angle, homing ? 420 : 580),
		);

		const bullet = createBulletFn({
			pos: nosePos,
			vel: bulletVel,
			angle: this.angle,
			ownerId: this.id,
			homing,
		});

		world.spawn(bullet);
		return bullet;
	}

	update(dt, world) {
		if (this.dead) return;
		if (this.fireCooldown > 0)
			this.fireCooldown = Math.max(0, this.fireCooldown - dt);
		if (this.invulnTimer > 0)
			this.invulnTimer = Math.max(0, this.invulnTimer - dt);
		super.update(dt, world);
	}
}
