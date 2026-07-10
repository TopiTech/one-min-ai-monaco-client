/**
 * Lightweight per-key async lock.
 *
 * Ensures that concurrent operations targeting the same key are serialized
 * (non-reentrant). Useful for protecting shared mutable state like session
 * maps or file caches from concurrent read-modify-write races.
 *
 * @template T
 */
export class SessionLock {
  #locks = new Map();

  /**
   * Run `fn` while holding the lock for `key`. The lock is automatically
   * released when `fn` settles (resolves or rejects).
   * @param {string} key
   * @param {() => Promise<T>} fn
   * @returns {Promise<T>}
   */
  async acquire(key, fn) {
    const promise = this.#locks.get(key) || Promise.resolve();
    let resolveLock = () => {};
    const nextPromise = new Promise((resolve) => {
      resolveLock = /** @type {any} */ (resolve);
    });
    this.#locks.set(key, nextPromise);

    try {
      await promise;
      return await fn();
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
