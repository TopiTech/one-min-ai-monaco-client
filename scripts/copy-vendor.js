/**
 * Copy small, pinned third-party assets from node_modules into public/vendor
 * so the SPA no longer depends on a CDN at runtime.
 *
 * Only the marked.min.js and DOMPurify purify.min.js bundles are vendored;
 * Monaco is handled separately by copy-monaco.js.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..");
const vendorDir = join(projectRoot, "public", "vendor");

if (!existsSync(vendorDir)) mkdirSync(vendorDir, { recursive: true });

const files = [
  {
    src: join(projectRoot, "node_modules", "dompurify", "dist", "purify.min.js"),
    dest: join(vendorDir, "purify.min.js"),
  },
  {
    src: join(projectRoot, "node_modules", "marked", "marked.min.js"),
    dest: join(vendorDir, "marked.min.js"),
  },
];

function fileExists(p) {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

let copied = 0;
let skipped = 0;
for (const f of files) {
  if (!existsSync(f.src)) {
    console.error(`Vendor source missing: ${f.src}`);
    process.exit(1);
  }
  // Skip the copy when the destination file is already present. This
  // mirrors copy-monaco.js so repeated `npm start` invocations stay
  // cheap and don't rewrite mtimes unnecessarily.
  if (fileExists(f.dest)) {
    skipped++;
    continue;
  }
  cpSync(f.src, f.dest, { recursive: false });
  copied++;
}

if (copied > 0) {
  console.log(`Vendored ${copied} file(s) into ${vendorDir}`);
} else if (skipped === files.length) {
  console.log(`Vendor assets already present at ${vendorDir}, skipping copy.`);
}

