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
 * Strips web search artifacts, grounding preambles, and citation footers
 * that may be injected into the LLM output by search-enabled models or 1min.ai
 * grounding features.
 * @param {string} text
 * @returns {string}
 */
export function stripSearchArtifacts(text) {
  if (typeof text !== 'string') return '';
  let cleaned = text;

  // 1. Remove trailing sources / references / citations blocks
  cleaned = cleaned.replace(
    /\n+(?:(?:Web\s+)?Sources?|(?:Web\s+)?References?|Citations?|External\s+[Ll]inks?|Web\s+Search\s+Sources?):\s*\n+[\s\S]*$/i,
    '',
  );
  cleaned = cleaned.replace(/\n+(?:\[\d+\]:?\s*https?:\/\/[^\s\n]+[\s\S]*)$/i, '');
  cleaned = cleaned.replace(/\n+(?:\[\^\d+\]:?[\s\S]*)$/i, '');

  // 2. Remove leading search result blocks
  cleaned = cleaned.replace(
    /^(?:[\s\S]*?(?:(?:Web\s+)?Search\s+results?(?:\s+for[^\n]*)?|Searching\s+the\s+web[^\n]*|Grounding\s+results?):\s*\n+[\s\S]*?)(?=(?:<thought>|<call_tool>|<finish>|```(?:json|xml)?|\{\s*["'\u201C\u2018]?(?:thought|tool|call_tool|action|finish)))/i,
    '',
  );

  return cleaned.trim();
}
