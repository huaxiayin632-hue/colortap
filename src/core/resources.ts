export type ResourceKind = 'decoded-audio' | 'decoded-image' | 'gpu-texture' | 'render-target';
export interface LoadedResource<T> {
  value: T;
  bytes: number;
  dispose?: () => void;
}
export interface ResourceLease<T> {
  value: T;
  release(): void;
}
type Entry = {
  kind: ResourceKind;
  refs: number;
  promise: Promise<LoadedResource<unknown>>;
  loaded?: LoadedResource<unknown>;
};

// Stage 1 provides ownership, shared loads and accounting. Streaming/LRU scheduling comes later.
export class ResourcePool {
  private readonly entries = new Map<string, Entry>();
  private closed = false;
  constructor(readonly budgets = { cpuBytes: 1024 ** 3, gpuBytes: 256 * 1024 ** 2 }) {}
  async acquire<T>(
    key: string,
    kind: ResourceKind,
    load: () => Promise<LoadedResource<T>>,
  ): Promise<ResourceLease<T>> {
    if (this.closed) throw new Error('资源池已关闭');
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { kind, refs: 0, promise: Promise.resolve().then(load) };
      this.entries.set(key, entry);
      const owned = entry;
      entry.promise = entry.promise
        .then((resource) => {
          if (!Number.isSafeInteger(resource.bytes) || resource.bytes < 0) {
            resource.dispose?.();
            throw new Error('资源占用记录无效');
          }
          if (this.closed || this.entries.get(key) !== owned) {
            resource.dispose?.();
            throw new Error('资源任务已取消');
          }
          owned.loaded = resource;
          return resource;
        })
        .catch((error) => {
          if (this.entries.get(key) === owned) this.entries.delete(key);
          throw error;
        });
    }
    if (entry.kind !== kind) throw new Error('资源类型不一致');
    entry.refs++;
    let resource: LoadedResource<T>;
    try {
      resource = (await entry.promise) as LoadedResource<T>;
    } catch (error) {
      entry.refs--;
      throw error;
    }
    let released = false;
    const owned = entry;
    return {
      value: resource.value,
      release: () => {
        if (released) return;
        released = true;
        if (--owned.refs === 0 && this.entries.get(key) === owned) {
          this.entries.delete(key);
          owned.loaded?.dispose?.();
        }
      },
    };
  }
  stats() {
    const bytes: Record<ResourceKind, number> = {
      'decoded-audio': 0,
      'decoded-image': 0,
      'gpu-texture': 0,
      'render-target': 0,
    };
    let pending = 0;
    for (const entry of this.entries.values()) {
      if (entry.loaded) bytes[entry.kind] += entry.loaded.bytes;
      else pending++;
    }
    return { bytes, pending, count: this.entries.size, budgets: this.budgets };
  }
  dispose(): void {
    this.closed = true;
    for (const entry of this.entries.values()) entry.loaded?.dispose?.();
    this.entries.clear();
  }
}
