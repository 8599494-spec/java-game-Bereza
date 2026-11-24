export class ObjectPool {
    factory;
    resetFn;
    free = [];
    totalCreated = 0;
    constructor(factory, resetFn, initialCapacity = 0) {
        this.factory = factory;
        this.resetFn = resetFn;
        this.preallocate(initialCapacity);
    }
    preallocate(count) {
        for (let i = 0; i < count; i += 1) {
            const item = this.factory();
            item.active = false;
            this.free.push(item);
            this.totalCreated += 1;
        }
    }
    acquire() {
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
    release(item) {
        if (!item.active)
            return;
        item.active = false;
        this.free.push(item);
    }
    get freeCount() {
        return this.free.length;
    }
    get createdCount() {
        return this.totalCreated;
    }
}
