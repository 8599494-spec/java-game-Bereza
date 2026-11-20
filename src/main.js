import {
	createAsteroid,
	createBullet,
	createDragBehavior,
	createWrapBehavior,
} from "./behaviors.js";
import { Ship } from "./entity.js";
import { createInput } from "./input.js";
import { createLoop } from "./loop.js";
import { createRenderer } from "./renderer.js";
import { Vector2 } from "./vector2.js";
import { World } from "./world.js";

const ARENA = { width: 900, height: 600 };
const canvas = document.querySelector("#game");

const input = createInput();
const renderer = createRenderer(canvas, ARENA);
const world = new World();

const ship = new Ship({
	pos: new Vector2(ARENA.width / 2, ARENA.height / 2),
	maxHp: 100,
	behaviors: [createDragBehavior(0.985), createWrapBehavior(ARENA)],
});

world.spawn(ship);
window.__gameDebug = { world, ship };

let score = 0;
let respawnTimer = 0;
let asteroidCountSpawned = 0;
let stats = { stepsPerSec: 60, framesPerSec: 144, frameTimeMs: "0.00" };

function spawnRandomAsteroid() {
	const edge = Math.floor(Math.random() * 4);
	let x = 0;
	let y = 0;

	if (edge === 0) {
		x = Math.random() * ARENA.width;
		y = 0;
	} else if (edge === 1) {
		x = ARENA.width;
		y = Math.random() * ARENA.height;
	} else if (edge === 2) {
		x = Math.random() * ARENA.width;
		y = ARENA.height;
	} else {
		x = 0;
		y = Math.random() * ARENA.height;
	}

	asteroidCountSpawned += 1;
	const isHoming = asteroidCountSpawned % 3 === 0;
	const angle = Math.random() * Math.PI * 2;
	const speed = isHoming ? 130 : 75 + Math.random() * 85;

	world.spawn(
		createAsteroid({
			pos: new Vector2(x, y),
			vel: Vector2.fromAngle(angle, speed),
			radius: isHoming ? 22 : 26,
			homing: isHoming,
			arena: ARENA,
		}),
	);
}

for (let i = 0; i < 6; i += 1) {
	spawnRandomAsteroid();
}

const loop = createLoop({
	step(dt) {
		const state = input.getState();

		if (!ship.dead) {
			ship.control(state, dt);

			if (state.fire) {
				ship.fire(world, {
					homing: false,
					createBulletFn: (opts) => createBullet({ ...opts, arena: ARENA }),
				});
			}
			if (state.fireHoming) {
				ship.fire(world, {
					homing: true,
					createBulletFn: (opts) => createBullet({ ...opts, arena: ARENA }),
				});
			}
		} else {
			respawnTimer -= dt;
			if (respawnTimer <= 0) {
				ship.reset(new Vector2(ARENA.width / 2, ARENA.height / 2));
				world.spawn(ship);
			}
		}

		const wasAlive = !ship.dead;
		world.step(dt, (points) => {
			score += points;
		});

		if (wasAlive && ship.dead) {
			respawnTimer = 2.0;
		}

		while (world.countKind("asteroid") < 6) {
			spawnRandomAsteroid();
		}
	},
	render() {
		renderer.draw(world, ship, {
			stats,
			score,
			respawnTimer,
			isThrusting: input.getState().thrust,
		});
	},
	onStats(nextStats) {
		stats = nextStats;
	},
});

loop.start();
