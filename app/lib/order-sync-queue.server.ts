/**
 * Serialize short projection write phases for one order in this process.
 * This is a work queue, not a data cache: every caller runs its own work and
 * reads its own current facts outside the queue. Never put a whole request,
 * business-fact evaluation or a call that recursively queues inside work().
 * SQL transactions/guards/retries remain authoritative,
 * including for independent application instances and external writers.
 */
export function createOrderSyncQueue() {
  const tails = new Map<string, Promise<void>>();
  return {
    get pendingKeys() { return tails.size; },
    async run<T>(organizationId: string, orderId: string, work: () => Promise<T>): Promise<T> {
      const key = JSON.stringify([organizationId, orderId]);
      const previous = tails.get(key) ?? Promise.resolve();
      let release!: () => void;
      const pending = new Promise<void>(resolve => { release = resolve; });
      tails.set(key, pending);
      await previous;
      try {
        return await work();
      } finally {
        release();
        if (tails.get(key) === pending) tails.delete(key);
      }
    },
  };
}

const orderSyncQueue = createOrderSyncQueue();
export function withOrderProjectionSync<T>(organizationId: string, orderId: string, work: () => Promise<T>) {
  return orderSyncQueue.run(organizationId, orderId, work);
}
