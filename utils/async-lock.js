import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Lightweight per-key async lock with re-entrancy support.
 *
 * Ensures that concurrent operations targeting the same key are serialized,
 * while allowing re-entrant acquisitions from within the same asynchronous
 * execution context to avoid self-deadlocks (e.g. diff route invoking addHistoryEntry).
 *
 * @template T
 */
export class SessionLock {
  #locks = new Map();
  #storage = new AsyncLocalStorage();

  /**
   * Run `fn` while holding the lock for `key`. The lock is automatically
   * released when `fn` settles (resolves or rejects).
   * @param {string} key
   * @param {() => Promise<T>} fn
   * @returns {Promise<T>}
   */
  async acquire(key, fn) {
    const activeKeys = this.#storage.getStore();
    if (activeKeys && activeKeys.has(key)) {
      return await fn();
    }

    const promise = this.#locks.get(key) || Promise.resolve();
    let resolveLock = () => {};
    const nextPromise = new Promise((resolve) => {
      resolveLock = /** @type {any} */ (resolve);
    });
    this.#locks.set(key, nextPromise);

    try {
      await promise;
      const nextStore = new Set(activeKeys ? activeKeys : []);
      nextStore.add(key);
      return await this.#storage.run(nextStore, () => fn());
    } finally {
      resolveLock();
      if (this.#locks.get(key) === nextPromise) {
        this.#locks.delete(key);
      }
    }
  }

  get size() {
    return this.#locks.size;
  }
}
