/**
 * Node-side entry point for the 1min.ai response extractor.
 *
 * The implementation lives in `public/js/one-min-response.js` because the
 * browser bundle must ship it, and the module is dependency-free ESM, so the
 * server imports the very same file instead of keeping a copy that could
 * drift. `public/` is part of the staged project (scripts/android-prepare.js
 * copies it next to `utils/`), so this path resolves on every target.
 */
export * from '../public/js/one-min-response.js';
