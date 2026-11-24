export class Vector2 {
	constructor(x = 0, y = 0) {
		this.x = x;
		this.y = y;
		Object.freeze(this);
	}

	static fromAngle(angle, length = 1) {
		return new Vector2(Math.cos(angle) * length, Math.sin(angle) * length);
	}

	add(other) {
		return new Vector2(this.x + other.x, this.y + other.y);
	}

	sub(other) {
		return new Vector2(this.x - other.x, this.y - other.y);
	}

	scale(scalar) {
		return new Vector2(this.x * scalar, this.y * scalar);
	}

	len() {
		return Math.hypot(this.x, this.y);
	}

	normalize() {
		const length = this.len();
		return length === 0 ? new Vector2(0, 0) : this.scale(1 / length);
	}

	dot(other) {
		return this.x * other.x + this.y * other.y;
	}

	distanceTo(other) {
		return this.sub(other).len();
	}
}
