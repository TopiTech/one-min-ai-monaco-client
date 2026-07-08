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
    let queue = this.#locks.get(key);
    if (!queue) {
      queue = [];
      this.#locks.set(key, queue);
    }
    while (queue.length > 0) {
      await queue[queue.length - 1];
    }
    let release = () => {};
    const holder = new Promise((resolve) => {
      release = /** @type {any} */ (resolve);
    });
    queue.push(holder);
    try {
      return await fn();
    } finally {
      queue.shift();
      if (queue.length === 0) this.#locks.delete(key);
      release();
    }
  }

  get size() {
    return this.#locks.size;
  }
}
