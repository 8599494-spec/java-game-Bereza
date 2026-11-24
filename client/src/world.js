import { resolveCollisions } from './collision.js';

export class World {
  #entities = new Map();

  constructor({ events = null } = {}) {
    this.events = events;
  }

  get size() {
    return this.#entities.size;
  }
  spawn(entity) {
    this.#entities.set(entity.id, entity);
    return entity;
  }

  despawn(idOrEntity) {
    const id = typeof idOrEntity === 'object' ? idOrEntity.id : idOrEntity;
    const entity = this.#entities.get(id);
    if (entity) entity.markDead();
  }

  [Symbol.iterator]() {
    return this.#entities.values();
  }

  *ofKind(kind) {
    for (const entity of this.#entities.values()) {
      if (!entity.dead && entity.kind === kind) yield entity;
    }
  }

  countKind(kind) {
    let total = 0;
    for (const entity of this.#entities.values()) {
      if (!entity.dead && entity.kind === kind) total += 1;
    }
    return total;
  }

  sweep() {
    for (const [id, entity] of this.#entities.entries()) {
      if (entity.dead) this.#entities.delete(id);
    }
  }

  step(dt) {
    for (const entity of this.#entities.values()) {
      if (!entity.dead) entity.update(dt, this);
    }
    resolveCollisions(this);
    this.sweep();
  }
}
