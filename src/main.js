import { createInput } from "./input.js";
import { createLoop } from "./loop.js";
import { createShip, integrate } from "./physics.js";
import { createRenderer } from "./renderer.js";

const ARENA = { width: 900, height: 600 };
const canvas = document.querySelector("#game");

const input = createInput();
const renderer = createRenderer(canvas, ARENA);

let prevShip = createShip(ARENA.width / 2, ARENA.height / 2);
let currShip = { ...prevShip };
let stats = { stepsPerSec: 60, framesPerSec: 60, frameTimeMs: "0.00" };

const loop = createLoop({
	step(dt) {
		prevShip = currShip;
		currShip = integrate(currShip, input.getState(), dt, ARENA);
	},
	render(alpha) {
		renderer.draw(prevShip, currShip, alpha, input.getState().thrust, stats);
	},
	onStats(nextStats) {
		stats = nextStats;
	},
});

loop.start();
