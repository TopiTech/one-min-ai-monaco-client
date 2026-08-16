/**
 * Jest setup file: ensure NODE_ENV is 'test' before any module evaluation.
 *
 * When the host system exports NODE_ENV=production (or development), the
 * test worker inherits that value.  server.js guards its top-level
 * validateEnvironment() call with `if (NODE_ENV !== 'test')`, so a
 * non-test value causes process.exit(1) on import—breaking every test
 * suite that loads server.js.
 *
 * Running this via Jest's `setupFiles` guarantee it executes before the
 * test file's top-level imports, making the guard see 'test' reliably.
 */
process.env.NODE_ENV = 'test';
