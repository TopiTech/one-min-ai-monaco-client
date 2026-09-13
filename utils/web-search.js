import { serverConfig } from '../config/server.js';
import { BadRequestError } from './errors.js';

/**
 * Validates and parses web search parameters.
 * @param {object} [params] - The parameters to validate.
 * @param {boolean} [params.webSearch] - Whether web search is enabled.
 * @param {number|string} [params.numOfSite] - Number of sites to search.
 * @param {number|string} [params.maxWord] - Maximum words per site.
 * @returns {{ parsedWebSearch: boolean, parsedNumOfSite?: number, parsedMaxWord?: number }}
 */
export function parseWebSearchParams({ webSearch = false, numOfSite, maxWord } = {}) {
  const parsedWebSearch = Boolean(webSearch);

  let parsedNumOfSite;
  if (numOfSite !== undefined && numOfSite !== '') {
    parsedNumOfSite = Number(numOfSite);
    if (isNaN(parsedNumOfSite) || parsedNumOfSite < 1 || parsedNumOfSite > 10) {
      throw new BadRequestError('numOfSite must be a number between 1 and 10');
    }
  }

  let parsedMaxWord;
  if (maxWord !== undefined && maxWord !== '') {
    parsedMaxWord = Number(maxWord);
    if (isNaN(parsedMaxWord) || parsedMaxWord < 100 || parsedMaxWord > 10000) {
      throw new BadRequestError('maxWord must be a number between 100 and 10000');
    }
  }

  return { parsedWebSearch, parsedNumOfSite, parsedMaxWord };
}

/**
 * Builds web search settings in the shape currently used by Chat with AI.
 * @param {object} opts
 * @param {boolean} opts.webSearch
 * @param {number} [opts.parsedNumOfSite]
 * @param {number} [opts.parsedMaxWord]
 * @returns {{ webSearch: boolean, numOfSite?: number, maxWord?: number }}
 */
export function buildWebSearchSettings({ webSearch, parsedNumOfSite, parsedMaxWord }) {
  return {
    webSearch,
    ...(parsedNumOfSite !== undefined ? { numOfSite: parsedNumOfSite } : {}),
    ...(parsedMaxWord !== undefined ? { maxWord: parsedMaxWord } : {}),
  };
}

/**
 * Builds a CODE_GENERATOR payload matching the 1min.ai API schema:
 * promptObject.prompt + flat webSearch/numOfSite/maxWord on promptObject.
 * @param {object} opts
 * @param {string} opts.prompt - The prompt text.
 * @param {string} [opts.model] - The model to use.
 * @param {boolean} opts.webSearch
 * @param {number} [opts.parsedNumOfSite]
 * @param {number} [opts.parsedMaxWord]
 * @returns {{ type: string, model: string, promptObject: { prompt: string, webSearch: boolean, numOfSite?: number, maxWord?: number } }} The payload object.
 */
export function buildCodePayload({ prompt, model, webSearch, parsedNumOfSite, parsedMaxWord }) {
  const isWebSearch = Boolean(webSearch);
  return {
    type: 'CODE_GENERATOR',
    model: model || serverConfig.defaultCodeModel,
    promptObject: {
      prompt,
      webSearch: isWebSearch,
      ...(isWebSearch && parsedNumOfSite !== undefined ? { numOfSite: parsedNumOfSite } : {}),
      ...(isWebSearch && parsedMaxWord !== undefined ? { maxWord: parsedMaxWord } : {}),
    },
  };
}

/**
 * Applies a cleaning function only to the regions of the agent response that
 * live OUTSIDE the structural tags (<call_tool>, <finish>, <artifact>, ...).
 * Content inside tool parameters is the agent's raw payload (e.g. file bodies
 * or diffs) and must never be rewritten by heuristic cleanup.
 * @param {string} text
 * @param {(segment: string) => string} cleanFn
 * @returns {string}
 */
export function cleanOutsideStructuralTags(text, cleanFn) {
  if (typeof text !== 'string' || typeof cleanFn !== 'function') return text;
  const pattern =
    /<(?:call_tool|tool_call|finish|artifact)\b[\s\S]*?<\/(?:call_tool|tool_call|finish|artifact)>/g;
  const matches = [...text.matchAll(pattern)];
  if (matches.length === 0) return cleanFn(text);
  let out = '';
  let cursor = 0;
  for (const m of matches) {
    out += cleanFn(text.slice(cursor, m.index));
    out += m[0]; // structural tag content is preserved verbatim
    cursor = m.index + m[0].length;
  }
  out += cleanFn(text.slice(cursor));
  return out;
}

function stripCrawlStatusLines(cleaned) {
  // Tightened: the loose 'Searching for ...' form matched legitimate content,
  // so bare prose is preserved now. Status-like lines are only removed when
  // they carry a URL, except the explicit 'Searching the web' form which is
  // always treated as a status line.
  return cleaned.replace(
    /(?:^|\n)[ \t]*(?:⚙\s*|[•\-*]\s*)?(?:(?:Crawling(?:\s+site)?|Crawled(?:\s+site)?|Browsing(?:\s+page|\s+site)?|Reading\s+site|Navigating\s+to|Fetching(?:\s+URL)?|Searching(?:\s+the\s+web|\s+for)?)[^\n]*https?:\/\/\S*|Searching\s+the\s+web[^\n]*)[^\n]*(?=\n|$)/gi,
    '',
  );
}

/**
 * Strips web search artifacts, grounding preambles, and citation footers
 * that may be injected into the LLM output by search-enabled models or 1min.ai
 * grounding features.
 *
 * Structural regions of agent output (<call_tool>..., <finish>..., <artifact>...)
 * are never rewritten: their content is the agent's raw payload (file bodies,
 * diffs), and heuristic cleanup would silently corrupt it.
 * @param {string} text
 * @returns {string}
 */
export function stripSearchArtifacts(text) {
  if (typeof text !== 'string') return '';

  const cleanSegment = (segment) => {
    let cleaned = segment;

    // 1. Remove trailing sources / references / citations blocks
    cleaned = cleaned.replace(
      /\n+(?:(?:Web\s+)?Sources?|(?:Web\s+)?References?|Citations?|External\s+[Ll]inks?|Web\s+Search\s+Sources?):\s*\n+[\s\S]*$/i,
      '',
    );
    cleaned = cleaned.replace(/\n+(?:\[\d+\]:?\s*https?:\/\/[^\s\n]+[\s\S]*)$/i, '');
    cleaned = cleaned.replace(/\n+(?:\[\^\d+\]:?[\s\S]*)$/i, '');

    // 2. Remove crawl / browsing / search status lines (URL-anchored)
    cleaned = stripCrawlStatusLines(cleaned);

    // 3. Remove leading search result blocks
    cleaned = cleaned.replace(
      /^(?:[\s\S]*?(?:(?:Web\s+)?Search\s+results?(?:\s+for[^\n]*)?|Searching\s+the\s+web[^\n]*|Grounding\s+results?):?\s*\n+[\s\S]*?)(?=(?:<(?:thought|thinking|think|call_tool|tool_call|finish|artifact)\b|```(?:json|xml)?|\{\s*["'\u201C\u2018]?(?:thought|thinking|think|tool|call_tool|action|finish)))/i,
      '',
    );

    return cleaned;
  };

  return cleanOutsideStructuralTags(text, cleanSegment).trim();
}
