/**
 * Validates and parses web search parameters.
 * @param {object} params - The parameters to validate.
 * @param {boolean} params.webSearch - Whether web search is enabled.
 * @param {number|string} [params.numOfSite] - Number of sites to search.
 * @param {number|string} [params.maxWord] - Maximum words per site.
 * @returns {{ parsedWebSearch: boolean, parsedNumOfSite?: number, parsedMaxWord?: number }}
 */
export function parseWebSearchParams({ webSearch = false, numOfSite, maxWord } = {}) {
  const parsedWebSearch = Boolean(webSearch);

  let parsedNumOfSite;
  if (numOfSite !== undefined && numOfSite !== "") {
    parsedNumOfSite = Number(numOfSite);
    if (isNaN(parsedNumOfSite) || parsedNumOfSite < 1 || parsedNumOfSite > 10) {
      throw Object.assign(new Error("numOfSite must be a number between 1 and 10"), { status: 400 });
    }
  }

  let parsedMaxWord;
  if (maxWord !== undefined && maxWord !== "") {
    parsedMaxWord = Number(maxWord);
    if (isNaN(parsedMaxWord) || parsedMaxWord < 100 || parsedMaxWord > 10000) {
      throw Object.assign(new Error("maxWord must be a number between 100 and 10000"), { status: 400 });
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
 * @returns {object}
 */
export function buildWebSearchSettings({ webSearch, parsedNumOfSite, parsedMaxWord }) {
  return {
    webSearch,
    ...(parsedNumOfSite !== undefined ? { numOfSite: parsedNumOfSite } : {}),
    ...(parsedMaxWord !== undefined ? { maxWord: parsedMaxWord } : {}),
  };
}

import crypto from 'crypto';
import { serverConfig } from '../config/server.js';

/**
 * Builds a CODE_GENERATOR payload matching the 1min.ai API schema:
 * promptObject.prompt, promptObject.webSearch, promptObject.numOfSite, promptObject.maxWord.
 * @param {object} opts
 * @param {string} opts.prompt - The prompt text.
 * @param {string} [opts.model] - The model to use.
 * @param {boolean} opts.webSearch
 * @param {number} [opts.parsedNumOfSite]
 * @param {number} [opts.parsedMaxWord]
 * @returns {object} The payload object.
 */
export function buildCodePayload({ prompt, model, webSearch, parsedNumOfSite, parsedMaxWord }) {
  return {
    type: "CODE_GENERATOR",
    model: model || serverConfig.defaultCodeModel,
    conversationId: `CODE_GEN_${crypto.randomUUID()}`,
    promptObject: {
      prompt,
      webSearch: Boolean(webSearch),
      ...(parsedNumOfSite !== undefined ? { numOfSite: parsedNumOfSite } : {}),
      ...(parsedMaxWord !== undefined ? { maxWord: parsedMaxWord } : {}),
    },
  };
}
