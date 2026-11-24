export interface Poolable {
  active: boolean;
}

export class ObjectPool<T extends Poolable> {
  private readonly factory: () => T;
  private readonly resetFn: (item: T) => void;
  private readonly free: T[] = [];
  private totalCreated = 0;

  public constructor(factory: () => T, resetFn: (item: T) => void, initialCapacity = 0) {
    this.factory = factory;
    this.resetFn = resetFn;
    this.preallocate(initialCapacity);
  }

  public preallocate(count: number): void {
    for (let i = 0; i < count; i += 1) {
      const item = this.factory();
      item.active = false;
      this.free.push(item);
      this.totalCreated += 1;
    }
  }

  public acquire(): T {
    const recycled = this.free.pop();
    if (recycled) {
      this.resetFn(recycled);
      recycled.active = true;
      return recycled;
    }
    const created = this.factory();
    this.resetFn(created);
    created.active = true;
    this.totalCreated += 1;
    return created;
  }

  public release(item: T): void {
    if (!item.active) return;
    item.active = false;
    this.free.push(item);
  }

  public get freeCount(): number {
    return this.free.length;
  }

  public get createdCount(): number {
    return this.totalCreated;
  }
}
