export class SimpleQueue<T> {
  private items: T[] = [];
  private waiters: Array<{
    resolve: (item: T) => void;
    reject: (reason: unknown) => void;
  }> = [];

  enqueue(item: T): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve(item);
    } else {
      this.items.push(item);
    }
  }

  enqueueMany(items: readonly T[]): void {
    for (const item of items) this.enqueue(item);
  }

  async take(signal?: AbortSignal): Promise<T> {
    if (this.items.length > 0) return this.items.shift()!;
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        const idx = this.waiters.indexOf(entry);
        if (idx !== -1) this.waiters.splice(idx, 1);
        reject(signal!.reason);
      };
      const entry = {
        resolve: (item: T) => {
          signal?.removeEventListener("abort", onAbort);
          resolve(item);
        },
        reject,
      };
      this.waiters.push(entry);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  get size(): number {
    return this.items.length;
  }
}
