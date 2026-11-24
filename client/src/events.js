export class GameEventBus extends EventTarget {
  emit(type, detail = {}) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
}
