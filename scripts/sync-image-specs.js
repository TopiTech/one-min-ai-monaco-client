#!/usr/bin/env node
/**
 * Regenerates config/image-specs/1min.json from the public 1min.AI API docs.
 *
 * The docs publish one page per (feature type, model) pair under
 * https://docs.1min.ai/docs/api/ai-for-image/<family>/<page>, each with a
 * "Parameters" / "Prompt Object Parameters" table. This script scrapes those
 * tables so the per-model payload shape is derived from the docs instead of
 * being guessed in code.
 *
 * Usage:
 *   node scripts/sync-image-specs.js            # write the JSON file
 *   node scripts/sync-image-specs.js --dry-run  # print a summary, write nothing
 *   node scripts/sync-image-specs.js --verbose  # per-page diagnostics
 *
 * The result is a review artifact: commit it and diff the changes. UI metadata
 * (labels, enums, ranges) lives in config/image-specs/1min-overrides.json so
 * this file stays a faithful transcription of the upstream docs.
 */
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT_PATH = path.join(ROOT, 'config', 'image-specs', '1min.json');

const DOCS_BASE = 'https://docs.1min.ai';
const SITEMAP_URL = `${DOCS_BASE}/sitemap.xml`;
// The sitemap lists http:// URLs; only the path identifies a page.
const PAGE_PATH_PREFIX = '/docs/api/ai-for-image/';
const FETCH_TIMEOUT_MS = 45_000;
const FETCH_CONCURRENCY = 6;
const MAX_RETRIES = 3;

/** Top-level fields of POST /api/features, not promptObject parameters. */
const NON_PROMPT_OBJECT_FIELDS = new Set([
  'type',
  'model',
  'promptObject',
  'async',
  'conversationId',
  'brandVoiceId',
  'metadata',
]);

/**
 * Doc folder -> feature type. Pages usually state the type explicitly
 * ("Must be IMAGE_GENERATOR"); the folder mapping is the fallback for pages
 * whose copy omits it.
 */
const FAMILY_FEATURE_MAP = {
  'image-generator': 'IMAGE_GENERATOR',
  'image-text-editor': 'IMAGE_EDITOR',
  'image-mask-editor': 'IMAGE_INPAINTER',
  'image-variator': 'IMAGE_VARIATOR',
  'image-upscaler': 'IMAGE_UPSCALER',
  'image-extender': 'IMAGE_EXTENDER',
  'background-remover': 'BACKGROUND_REMOVER',
  'background-replacer': 'BACKGROUND_REPLACER',
  'object-remover': 'IMAGE_OBJECT_REMOVER',
  'text-remover': 'TEXT_REMOVER',
  'search-and-replace': 'SEARCH_AND_REPLACE',
  'face-swapper': 'FACE_SWAPPER',
  'sketch-to-image': 'SKETCH_TO_IMAGE',
  '3d-image-generator': 'IMAGE_3D_GENERATOR',
  'image-to-prompt': 'IMAGE_TO_PROMPT',
  'image-analysis': 'IMAGE_ANALYSIS',
};

const FEATURE_TYPE_PATTERN =
  /\b(IMAGE_[A-Z0-9]+(?:_[A-Z0-9]+)*|FACE_SWAPPER|BACKGROUND_[A-Z_]+|SKETCH_TO_IMAGE|SEARCH_AND_REPLACE|TEXT_REMOVER)\b/;

/** Entity decode for the handful of entities Docusaurus emits in tables. */
function decodeEntities(input) {
  return String(input)
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&#x2F;/g, '/')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

function stripTags(html) {
  return decodeEntities(String(html).replace(/<[^>]+>/g, ' '))
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function slugToModelGuess(slug) {
  return slug
    .replace(/-(image-generation|image-text-editor|image-mask-editor|image-variator|image-upscaler|image-extender|background-remover|background-replacer|object-remover|text-remover|search-and-replace|face-swapper|sketch-to-image|3d-image-generator|image-to-prompt|image-analysis)$/i, '')
    .trim();
}

/**
 * Extracts every <table> whose header row starts with "Parameter".
 * Other tables on the page (quality options, size constraints, ...) are
 * descriptive and must not be mistaken for the request shape.
 */
function extractParameterTables(html) {
  const rows = [];
  const tableRe = /<table>([\s\S]*?)<\/table>/gi;
  let tableMatch;
  while ((tableMatch = tableRe.exec(html)) !== null) {
    const table = tableMatch[1];
    const headerMatch = table.match(/<thead>[\s\S]*?<\/thead>/i);
    if (!headerMatch) continue;
    const headers = [...headerMatch[0].matchAll(/<th[^>]*>([\s\S]*?)<\/th>/gi)].map((m) =>
      stripTags(m[1]).toLowerCase(),
    );
    if (headers[0] !== 'parameter') continue;

    const bodyMatch = table.match(/<tbody>([\s\S]*?)<\/tbody>/i);
    const body = bodyMatch ? bodyMatch[1] : '';
    for (const rowMatch of body.matchAll(/<tr>([\s\S]*?)<\/tr>/gi)) {
      const cells = [...rowMatch[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => m[1]);
      if (cells.length < 2) continue;
      rows.push({
        name: stripTags(cells[0]),
        type: stripTags(cells[1]),
        required: /^yes$/i.test(stripTags(cells[2] || '')),
        description: stripTags(cells[3] || ''),
        defaultValue: cells[4] === undefined ? undefined : stripTags(cells[4]),
      });
    }
  }
  return rows;
}

function extractModelId(html, slug) {
  const decoded = decodeEntities(html);
  const isPlausibleId = (value) =>
    Boolean(value) &&
    value.length <= 80 &&
    !/\s/.test(value) &&
    !/^[A-Z0-9_]+$/.test(value) &&
    !/^(one|a|an|the|in|of|or|and|divisible|provided|between|stable)$/i.test(value);

  // JSON examples are HTML-encoded in the docs source, so decode before matching.
  const example = decoded.match(/"model"\s*:\s*"([^"]+)"/)?.[1];
  if (isPlausibleId(example)) return example;

  const explicit = decoded.match(/Must be\s*<code>([^<]+)<\/code>/i)?.[1];
  const explicitClean = explicit ? stripTags(explicit) : '';
  if (isPlausibleId(explicitClean)) return explicitClean;

  return slugToModelGuess(slug);
}

function extractFeatureType(html, family) {
  const block = html.match(/Must be\s*<code>\s*([A-Z0-9_]+)\s*<\/code>/);
  if (block) return block[1];
  const text = stripTags(html);
  const explicit = text.match(FEATURE_TYPE_PATTERN);
  if (explicit) return explicit[1];
  return FAMILY_FEATURE_MAP[family] || null;
}

/** Pulls "(1-10)", "(15-50)", "(0-100, higher = better quality)" style hints. */
function extractNumericRange(description) {
  const match = String(description).match(/\((\d+(?:\.\d+)?)\s*[-–~]\s*(\d+(?:\.\d+)?)/);
  if (!match) return null;
  return { min: Number(match[1]), max: Number(match[2]) };
}

async function fetchText(url, attempt = 1) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'user-agent': 'one-min-ai-monaco-client/spec-sync' },
    });
    if (!res.ok) {
      throw new Error(`${res.status} ${res.statusText} for ${url}`);
    }
    return await res.text();
  } catch (err) {
    if (attempt < MAX_RETRIES) {
      await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
      return fetchText(url, attempt + 1);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

async function listDocPages() {
  const sitemap = await fetchText(SITEMAP_URL);
  const urls = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].trim());
  return urls
    .filter((url) => url.includes(PAGE_PATH_PREFIX))
    .map((url) => {
      const relative = url.slice(url.indexOf(PAGE_PATH_PREFIX) + PAGE_PATH_PREFIX.length);
      const [family, page] = relative.split('/');
      return { url: `${DOCS_BASE}${PAGE_PATH_PREFIX}${relative}`, family, page };
    })
    .filter((entry) => entry.family && entry.page && FAMILY_FEATURE_MAP[entry.family]);
}

function toParam(entry) {
  const param = {
    name: entry.name,
    type: entry.type || 'string',
    required: entry.required,
  };
  const range = extractNumericRange(entry.description);
  if (range) {
    param.min = range.min;
    param.max = range.max;
  }
  if (entry.defaultValue && entry.defaultValue !== '-' && entry.defaultValue !== '') {
    param.default = entry.defaultValue;
  }
  if (entry.description) {
    param.description = entry.description;
  }
  return param;
}

async function buildSpec({ verbose = false } = {}) {
  const pages = await listDocPages();
  if (verbose) console.log(`Found ${pages.length} documentation pages`);
  if (pages.length === 0) {
    throw new Error('No ai-for-image pages were found in the docs sitemap');
  }

  const failures = [];
  const skipped = [];
  const parsed = await mapWithConcurrency(pages, FETCH_CONCURRENCY, async (entry) => {
    try {
      const html = await fetchText(entry.url);
      const feature = extractFeatureType(html, entry.family);
      if (!feature) {
        throw new Error('feature type not detected');
      }
      const model = extractModelId(html, entry.page);
      const rows = extractParameterTables(html).filter(
        (row) => row.name && !NON_PROMPT_OBJECT_FIELDS.has(row.name),
      );
      if (rows.length === 0) {
        // "-tag" pages are per-feature overviews with no request shape.
        if (/-tag$/.test(entry.page)) {
          skipped.push(entry.url);
          return null;
        }
        throw new Error('no parameter table found');
      }
      return { ...entry, feature, model, rows };
    } catch (err) {
      failures.push({ url: entry.url, error: err?.message || String(err) });
      return null;
    }
  });

  const features = {};
  const duplicates = [];
  let pageCount = 0;
  for (const result of parsed) {
    if (!result) continue;
    pageCount += 1;
    features[result.feature] ||= { models: {} };
    const bucket = features[result.feature].models;
    if (bucket[result.model]) {
      duplicates.push({
        feature: result.feature,
        model: result.model,
        kept: bucket[result.model].source,
        ignored: result.url,
      });
    }
    // Later duplicates win: docs sometimes publish one page per alias.
    bucket[result.model] = {
      source: result.url,
      params: result.rows.map(toParam),
    };
  }

  const spec = {
    generatedAt: new Date().toISOString(),
    source: `${DOCS_BASE}/docs/api/ai-for-image`,
    pageCount,
    failures,
    skipped,
    duplicates,
    features,
  };
  if (verbose) {
    for (const [feature, value] of Object.entries(features)) {
      console.log(`${feature}: ${Object.keys(value.models).length} models`);
    }
    console.log(`Skipped ${skipped.length} overview pages`);
    for (const duplicate of duplicates) {
      console.warn(`DUPLICATE ${duplicate.feature} ${duplicate.model}: ignored ${duplicate.ignored}`);
    }
    for (const failure of failures) {
      console.warn(`FAILED ${failure.url}: ${failure.error}`);
    }
  }
  return spec;
}

/**
 * Groups model ids into the families the docs use, so the printed report (and
 * the API reference tables) can be read at a glance.
 */
export function classifyModelFamily(modelId) {
  const id = String(modelId || '');
  if (id.startsWith('gpt-image')) return 'gpt-image';
  if (id.startsWith('black-forest-labs/flux-2')) return 'flux-2';
  if (id.startsWith('black-forest-labs/flux-kontext')) return 'flux-kontext';
  if (id.startsWith('black-forest-labs/flux-fill')) return 'flux-fill';
  if (id.startsWith('black-forest-labs/flux')) return 'flux-1.x';
  if (id.startsWith('leonardo')) return 'leonardo';
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return 'leonardo (uuid)';
  if (id.startsWith('magic-art')) return 'magic-art';
  if (id.startsWith('ideogram')) return 'ideogram';
  if (id.startsWith('qwen')) return 'qwen';
  if (id.startsWith('gemini')) return 'gemini';
  if (id.startsWith('stable') || id.startsWith('sd3')) return 'stable-diffusion';
  if (id.startsWith('Qubico')) return 'Qubico';
  return id;
}

/** Prints the parameter union per (feature, family) pair. */
export function reportSpec(spec) {
  for (const [feature, value] of Object.entries(spec.features)) {
    console.log(`\n## ${feature} (${Object.keys(value.models).length} models)`);
    const families = {};
    for (const [modelId, model] of Object.entries(value.models)) {
      const family = classifyModelFamily(modelId);
      families[family] ||= { models: [], params: new Set() };
      families[family].models.push(modelId);
      for (const param of model.params) families[family].params.add(param.name);
    }
    for (const [family, group] of Object.entries(families)) {
      console.log(`- ${family} (${group.models.length}): ${[...group.params].join(', ')}`);
    }
  }
}

async function main() {
  const args = new Set(process.argv.slice(2));
  if (args.has('--report')) {
    const existing = JSON.parse(await fs.readFile(OUT_PATH, 'utf8'));
    reportSpec(existing);
    return;
  }
  const spec = await buildSpec({ verbose: args.has('--verbose') || args.has('--dry-run') });

  if (args.has('--dry-run')) {
    console.log(
      `Dry run: ${spec.pageCount} pages, ${Object.keys(spec.features).length} features, ${spec.failures.length} failures`,
    );
    return;
  }

  await fs.mkdir(path.dirname(OUT_PATH), { recursive: true });
  await fs.writeFile(OUT_PATH, `${JSON.stringify(spec, null, 2)}\n`, 'utf8');
  console.log(
    `Wrote ${path.relative(ROOT, OUT_PATH)} (${spec.pageCount} pages, ${Object.keys(spec.features).length} features, ${spec.failures.length} failures)`,
  );
  if (spec.failures.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
