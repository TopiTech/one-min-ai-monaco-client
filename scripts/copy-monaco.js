/**
 * Copy Monaco Editor assets from node_modules to public/vs/
 * This avoids CDN loading issues with Firefox Tracking Prevention.
 *
 * Skips the copy when public/vs/ already contains the source directory
 * to avoid redundant I/O on repeated `npm start` / `npm run dev` calls.
 */
import { cpSync, existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..");

const src = join(projectRoot, "node_modules", "monaco-editor", "min", "vs");
const dest = join(projectRoot, "public", "vs");

if (!existsSync(src)) {
    console.error("Monaco Editor source not found at:", src);
    process.exit(1);
}

function dirExists(dirPath) {
    try {
        return statSync(dirPath).isDirectory();
    } catch {
        return false;
    }
}

// Check if dest already has content (skip redundant copy)
if (dirExists(dest)) {
    try {
        const entries = readdirSync(dest);
        if (entries.length > 0) {
            console.log(`Monaco Editor assets already present at ${dest}, skipping copy.`);
            process.exit(0);
        }
    } catch {
        // Fall through to copy
    }
}

// Copy the entire vs/ directory
cpSync(src, dest, { recursive: true });
console.log(`Copied Monaco Editor assets to ${dest}`);
