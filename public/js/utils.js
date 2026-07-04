/**
 * Pure helper functions shared across the app.
 *
 * These helpers are dependency-free (no global state, no DOM reads) so
 * they can be unit-tested in isolation and re-used from any feature
 * module. Anything that needs `state`, `dom`, `window`, or `monaco`
 * should stay in the originating feature file.
 */

import { t } from './i18n.js';

export const SVG_NS = 'http://www.w3.org/2000/svg';

const STEP_ICON_LABEL_KEYS = {
  thought: 'icon_thought',
  action: 'icon_tool_call',
  result: 'icon_result',
  error: 'icon_error',
  approval: 'icon_approval_req',
};

const STEP_ICON_MAP = {
  thought: {
    viewBox: '0 0 24 24',
    paths: 'M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3M12 17h.01M12 21a9 9 0 1 0-9-9',
  },
  action: {
    viewBox: '0 0 24 24',
    paths:
      'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm8.94-2.83 1.72 2.99a1 1 0 0 1-.41 1.36l-3.06 1.49a1 1 0 0 1-1.26-.27l-1.15-1.4a8 8 0 0 1-1.86.78l-.34 1.65A1 1 0 0 1 14 19h-4a1 1 0 0 1-1-.83l-.34-1.65a8 8 0 0 1-1.86-.78l-1.15 1.4a1 1 0 0 1-1.26.27L1.33 16.5a1 1 0 0 1-.41-1.36l1.72-2.99A8 8 0 0 1 3 10.5c0-.6.07-1.18.21-1.74L1.5 6.5a1 1 0 0 1 .41-1.36l3.06-1.49a1 1 0 0 1 1.26.27l1.15 1.4a8 8 0 0 1 1.86-.78L9.58 3a1 1 0 0 1 1-.83h4a1 1 0 0 1 1 .83l.34 1.65a8 8 0 0 1 1.86.78l1.15-1.4a1 1 0 0 1 1.26-.27l3.06 1.49a1 1 0 0 1 .41 1.36l-1.72 2.99c.14.56.21 1.14.21 1.74z',
  },
  result: {
    viewBox: '0 0 24 24',
    paths: 'M20 6 9 17l-5-5',
  },
  error: {
    viewBox: '0 0 24 24',
    paths: 'M12 9v4m0 4h.01M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z',
  },
  approval: {
    viewBox: '0 0 24 24',
    paths:
      'M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0zM12 9v4m0 4h.01',
  },
};

/**
 * HTML-escape a value for safe innerHTML insertion. Non-string inputs
 * are coerced to an empty string so the caller never has to special-case
 * undefined/null.
 */
export function escapeHtml(text) {
  if (typeof text !== 'string') return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Render a markdown string into an element using marked + DOMPurify
 * when those globals are available, falling back to plain text rendering
 * when either is missing (e.g. before the CDN script finishes loading).
 *
 * @warning DANGEROUS if either library or its configuration is
 * compromised. Keep DOMPurify + marked up-to-date. Never assign raw
 * user/AI text to innerHTML anywhere else in the app; funnel all
 * untrusted HTML through this single function.
 */
export function renderMarkdownSafely(element, markdown) {
  if (!element) return;
  if (typeof markdown !== 'string') {
    element.textContent = '';
    return;
  }
  if (typeof window === 'undefined' || !window.marked || !window.DOMPurify) {
    element.textContent = markdown;
    return;
  }
  element.innerHTML = window.DOMPurify.sanitize(
    window.marked.parse(markdown, {
      gfm: true,
      breaks: false,
    }),
  );
}

/**
 * Build a 12x12 inline SVG icon with a single <path> element. Returns
 * the SVG element so callers can appendChild it into any container.
 */
export function createSvgIcon(viewBox, paths) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('xmlns', SVG_NS);
  svg.setAttribute('width', '12');
  svg.setAttribute('height', '12');
  svg.setAttribute('viewBox', viewBox);
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.classList.add('agent-step-icon-svg');

  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', paths);
  svg.appendChild(path);
  return svg;
}

/**
 * Append a labelled icon for an agent step (thought/action/result/...)
 * to the supplied container, followed by a "Label: " text node so
 * callers can add their own title.
 */
export function appendStepIcon(container, type) {
  const cfg = STEP_ICON_MAP[type] || STEP_ICON_MAP.thought;
  const labelKey = STEP_ICON_LABEL_KEYS[type] || STEP_ICON_LABEL_KEYS.thought;
  container.appendChild(createSvgIcon(cfg.viewBox, cfg.paths));
  container.appendChild(document.createTextNode(t(labelKey) + ': '));
}

/**
 * Strip a single leading and trailing ``` fence from a code block, if
 * present. Handles optional language tags and a missing closing fence.
 */
export function stripMarkdownCodeBlock(text) {
  if (typeof text !== 'string') return text;
  const trimmed = text.trim();
  const match = trimmed.match(/^```(?:xml|js|javascript|json|text)?\s*\n?([\s\S]*?)\n?```$/i);
  return match ? match[1].trim() : text;
}

/**
 * Unescape XML entity references (used to recover raw code that was
 * escaped for transport inside <parameter> blocks).
 */
export function unescapeXmlText(value) {
  if (typeof value !== 'string') return value;
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

// F-14: Hard caps on input size to prevent DoS via extremely large or
// deeply nested AI responses. These limits are intentionally generous —
// real model output rarely exceeds a few tens of KB — and only kick in
// when an attacker (or runaway loop) tries to allocate gigabytes.
const PARSE_INPUT_MAX_CHARS = 256 * 1024; // 256 KB
const PARSE_MAX_CANDIDATES = 32;

export const PARSE_LIMITS = Object.freeze({
  MAX_CHARS: PARSE_INPUT_MAX_CHARS,
  MAX_CANDIDATES: PARSE_MAX_CANDIDATES,
});

/**
 * Parse the agent's XML-style output (<thought>, <call_tool>, <finish>)
 * into a structured object. Falls back to a JSON-shaped fragment when
 * the model returns JSON instead of XML, so the agent loop can keep
 * working across providers.
 *
 * Hard caps on input length and JSON-fallback candidate count prevent
 * trivial denial-of-service via oversized or pathological payloads.
 */
export function parseXMLTags(text) {
  const empty = { thought: null, finish: null, toolCall: null };
  if (!text || typeof text !== 'string') return empty;

  // F-14: Reject absurdly large inputs up-front so we never spend CPU
  // on regex backtracking or JSON.parse over multi-megabyte strings.
  if (text.length > PARSE_INPUT_MAX_CHARS) {
    console.warn('parseXMLTags: input exceeds maximum size, dropping');
    return empty;
  }

  const normalizedText = stripMarkdownCodeBlock(text);

  const extractTag = (input, tag) => {
    const startRegex = new RegExp(`<${tag}(?:\\s+[\\s\\S]*?)?>`, 'i');
    const endRegex = new RegExp(`</${tag}>`, 'i');

    const startMatch = input.match(startRegex);
    if (!startMatch) return null;

    const contentStart = startMatch.index + startMatch[0].length;
    const endMatch = input.substring(contentStart).match(endRegex);

    if (endMatch) {
      return input.substring(contentStart, contentStart + endMatch.index).trim();
    } else {
      const nextTagRegex = /<(?:call_tool|parameter|finish|thought)/i;
      const nextTagMatch = input.substring(contentStart).match(nextTagRegex);
      if (nextTagMatch) {
        return input.substring(contentStart, contentStart + nextTagMatch.index).trim();
      }
      return input.substring(contentStart).trim();
    }
  };

  let toolCall = null;

  // Custom simple parsing to prevent ReDoS on huge unclosed tags
  const lowerText = normalizedText.toLowerCase();
  const findTag = (tagStr) => {
    const startIdx = lowerText.indexOf(`<${tagStr}`);
    if (startIdx === -1) return null;
    // Find the end of the start tag
    let endOfStartIdx = lowerText.indexOf('>', startIdx);
    if (endOfStartIdx === -1) return null;

    // Check if it's self-closing
    if (normalizedText[endOfStartIdx - 1] === '/') {
      return { startIdx, contentStart: endOfStartIdx + 1, content: '', tagEndIdx: endOfStartIdx + 1 };
    }

    // Check attributes (basic)
    const startTagContent = normalizedText.substring(startIdx + 1, endOfStartIdx);
    const tagParts = startTagContent.split(/\s+/);
    const actualTag = tagParts[0];

    // Find the close tag
    const closeTag = `</${actualTag.toLowerCase()}>`;
    let closeIdx = lowerText.indexOf(closeTag, endOfStartIdx);
    if (closeIdx === -1) {
      // Fallback: till the next <tag> or end of string
      const nextTagMatch = lowerText
        .substring(endOfStartIdx + 1)
        .search(/<(?:call_tool|parameter|finish|thought)/);
      if (nextTagMatch !== -1) {
        closeIdx = endOfStartIdx + 1 + nextTagMatch;
      } else {
        closeIdx = normalizedText.length;
      }
    }

    const content = normalizedText.substring(endOfStartIdx + 1, closeIdx).trim();
    return {
      startIdx,
      contentStart: endOfStartIdx + 1,
      content,
      tagEndIdx:
        closeIdx +
        (lowerText.substring(closeIdx, closeIdx + closeTag.length) === closeTag ? closeTag.length : 0),
      startTagContent,
    };
  };

  const toolMatch = findTag('call_tool');

  if (toolMatch) {
    const params = {};
    const innerText = toolMatch.content;

    // Extract name attribute
    let nameMatch = toolMatch.startTagContent.match(/name\s*=\s*["']?([\w-]+)["']?/i);
    const toolName = nameMatch ? nameMatch[1] : '';

    const paramStartRegex = /<parameter\s+name\s*=\s*["']?([\w-]+)["']?\s*(?:[^>]*?)?>/gi;
    let match;
    const matches = [];

    while ((match = paramStartRegex.exec(innerText)) !== null) {
      matches.push({
        name: match[1],
        startIndex: match.index,
        contentStart: match.index + match[0].length,
      });
    }

    for (let i = 0; i < matches.length; i++) {
      const current = matches[i];
      const next = matches[i + 1];
      const endTagRegex = /<\/parameter>/i;

      const searchSpace = next
        ? innerText.substring(current.contentStart, next.startIndex)
        : innerText.substring(current.contentStart);

      const endMatch = searchSpace.match(endTagRegex);
      let rawVal;
      if (endMatch) {
        rawVal = searchSpace.substring(0, endMatch.index);
      } else {
        rawVal = searchSpace;
      }
      params[current.name] = unescapeXmlText(rawVal.trim());
    }
    if (toolName) {
      toolCall = { name: toolName, params };
    }
  }

  const thought = extractTag(normalizedText, 'thought');
  const finish = extractTag(normalizedText, 'finish');

  if (!toolCall && !finish) {
    // Walk through every top-level {...} candidate so nested JSON inside
    // `params` (e.g. {"params": {"path": "."}}) still parses correctly.
    let candidates = 0;
    for (const candidate of extractBalancedObjects(normalizedText)) {
      // F-14: Cap the number of fallback candidates we attempt to parse.
      if (++candidates > PARSE_MAX_CANDIDATES) break;
      try {
        const data = JSON.parse(candidate);
        const jsonTool = data.tool || data.toolName || data.call_tool || data.toolCall?.name || data.action;
        const jsonParams =
          data.parameters || data.params || data.toolCall?.params || data.arguments || data.args;
        if (jsonTool) toolCall = { name: String(jsonTool), params: jsonParams || {} };
        if (data.thought && !thought) return { thought: data.thought, finish: data.finish || null, toolCall };
        if (data.finish && !finish) return { thought, finish: data.finish, toolCall };
        if (toolCall) break;
      } catch {
        /* try the next candidate */
      }
    }
  }

  return { thought, finish, toolCall };
}

// eslint-disable-next-line no-control-regex
const XML_CONTROL_CHAR_PATTERN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/gu;

export function sanitizeXmlText(text) {
  if (typeof text !== 'string') return '';
  return text
    .replace(XML_CONTROL_CHAR_PATTERN, '')
    .replace(/&(?!(?:amp|lt|gt|apos|quot);)/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function buildXmlRepairPrompt({
  aiText,
  errorReason,
  expectedTags = '<thought>, <call_tool>, <finish>',
} = {}) {
  const safeAiText = sanitizeXmlText(typeof aiText === 'string' ? aiText : '');
  const safeReason = sanitizeXmlText(typeof errorReason === 'string' ? errorReason : 'XML parse failed');

  return [
    '前回の出力は定義されたXMLフォーマットに準拠していませんでした。',
    `問題: ${safeReason}`,
    `必須タグ: ${expectedTags}`,
    '次のルールを厳守して、同じ内容をXMLとして再出力してください。',
    '1. 出力はXMLのみ。説明文、箇条書き、コードフェンス、Markdownは禁止。',
    '2. 最上位は <thought> か <call_tool> か <finish> のいずれかで始める。',
    '3. タグ内の &, <, > は必ずXMLエスケープする。',
    '4. <call_tool> を使う場合は <parameter name="..."> を閉じ忘れない。',
    '5. 迷ったら <finish> に要約だけを返す。',
    '',
    '前回の出力（参照用、修正して再送信）:',
    safeAiText || '(empty)',
  ].join('\n');
}

/**
 * Find every top-level {...} span in `text` while honouring string
 * literals and nested braces. Used as a fallback when the agent
 * returns JSON instead of <call_tool> markup; the naive
 * `\{[\s\S]*?\}` regex would stop at the first inner `}` and return
 * invalid JSON.
 */
function extractBalancedObjects(text) {
  const results = [];
  let depth = 0;
  let inString = false;
  let escape = false;
  let start = -1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (inString) {
      if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}') {
      if (depth > 0) depth--;
      if (depth === 0 && start !== -1) {
        results.push(text.substring(start, i + 1));
        start = -1;
      }
    }
  }
  return results;
}

/**
 * Extract the assistant text payload from a streamed `aiRecord` (or any
 * chunk shaped like an OpenAI completion response). Mirrors the same
 * fallback chain used while reading SSE chunks, so the final `result`
 * event can be parsed with the same logic.
 */
export function extractText(record) {
  if (!record) return '';
  if (typeof record === 'string') return record;
  return (
    record.content ||
    record?.choices?.[0]?.delta?.content ||
    record?.choices?.[0]?.message?.content ||
    record?.message?.content ||
    record?.delta?.content ||
    record?.text ||
    ''
  );
}
