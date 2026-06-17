/**
 * Pure helper functions shared across the app.
 *
 * These helpers are dependency-free (no global state, no DOM reads) so
 * they can be unit-tested in isolation and re-used from any feature
 * module. Anything that needs `state`, `dom`, `window`, or `monaco`
 * should stay in the originating feature file.
 */

export const SVG_NS = "http://www.w3.org/2000/svg";

const STEP_ICON_MAP = {
  thought: {
    label: "思考",
    viewBox: "0 0 24 24",
    paths: "M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3M12 17h.01M12 21a9 9 0 1 0-9-9",
  },
  action: {
    label: "ツール呼び出し",
    viewBox: "0 0 24 24",
    paths:
      "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm8.94-2.83 1.72 2.99a1 1 0 0 1-.41 1.36l-3.06 1.49a1 1 0 0 1-1.26-.27l-1.15-1.4a8 8 0 0 1-1.86.78l-.34 1.65A1 1 0 0 1 14 19h-4a1 1 0 0 1-1-.83l-.34-1.65a8 8 0 0 1-1.86-.78l-1.15 1.4a1 1 0 0 1-1.26.27L1.33 16.5a1 1 0 0 1-.41-1.36l1.72-2.99A8 8 0 0 1 3 10.5c0-.6.07-1.18.21-1.74L1.5 6.5a1 1 0 0 1 .41-1.36l3.06-1.49a1 1 0 0 1 1.26.27l1.15 1.4a8 8 0 0 1 1.86-.78L9.58 3a1 1 0 0 1 1-.83h4a1 1 0 0 1 1 .83l.34 1.65a8 8 0 0 1 1.86.78l1.15-1.4a1 1 0 0 1 1.26-.27l3.06 1.49a1 1 0 0 1 .41 1.36l-1.72 2.99c.14.56.21 1.14.21 1.74z",
  },
  result: {
    label: "実行結果",
    viewBox: "0 0 24 24",
    paths: "M20 6 9 17l-5-5",
  },
  error: {
    label: "エラー",
    viewBox: "0 0 24 24",
    paths: "M12 9v4m0 4h.01M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z",
  },
  approval: {
    label: "承認要求",
    viewBox: "0 0 24 24",
    paths:
      "M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0zM12 9v4m0 4h.01",
  },
};

/**
 * HTML-escape a value for safe innerHTML insertion. Non-string inputs
 * are coerced to an empty string so the caller never has to special-case
 * undefined/null.
 */
export function escapeHtml(text) {
  if (typeof text !== "string") return "";
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/**
 * Render a markdown string into an element using marked + DOMPurify
 * when those globals are available, falling back to plain text rendering
 * when either is missing (e.g. before the CDN script finishes loading).
 */
export function renderMarkdownSafely(element, markdown) {
  if (!element) return;
  if (typeof markdown !== "string") {
    element.textContent = "";
    return;
  }
  if (typeof window === "undefined" || !window.marked || !window.DOMPurify) {
    element.textContent = markdown;
    return;
  }
  element.innerHTML = window.DOMPurify.sanitize(window.marked.parse(markdown));
}

/**
 * Minimal inline-only Markdown formatter. Useful when we want bold/inline
 * code styling without spinning up a full Markdown parser. Output must
 * still be inserted with textContent semantics.
 */
export function formatMarkdownLike(text) {
  if (typeof text !== "string") return "";
  let html = escapeHtml(text);
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  return html;
}

/**
 * Build a 12x12 inline SVG icon with a single <path> element. Returns
 * the SVG element so callers can appendChild it into any container.
 */
export function createSvgIcon(viewBox, paths) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("xmlns", SVG_NS);
  svg.setAttribute("width", "12");
  svg.setAttribute("height", "12");
  svg.setAttribute("viewBox", viewBox);
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.classList.add("agent-step-icon-svg");

  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", paths);
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
  container.appendChild(createSvgIcon(cfg.viewBox, cfg.paths));
  container.appendChild(document.createTextNode(cfg.label + ": "));
}

/**
 * Strip a single leading and trailing ``` fence from a code block, if
 * present. Handles optional language tags and a missing closing fence.
 */
export function stripMarkdownCodeBlock(text) {
  if (typeof text !== "string") return text;
  const trimmed = text.trim();
  const match = trimmed.match(/^```(?:xml|js|javascript|json|text)?\s*\n?([\s\S]*?)\n?```$/i);
  return match ? match[1].trim() : text;
}

/**
 * Unescape XML entity references (used to recover raw code that was
 * escaped for transport inside <parameter> blocks).
 */
export function unescapeXmlText(value) {
  if (typeof value !== "string") return value;
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/**
 * Parse the agent's XML-style output (<thought>, <call_tool>, <finish>)
 * into a structured object. Falls back to a JSON-shaped fragment when
 * the model returns JSON instead of XML, so the agent loop can keep
 * working across providers.
 */
export function parseXMLTags(text) {
  const empty = { thought: null, finish: null, toolCall: null };
  if (!text || typeof text !== "string") return empty;

  const normalizedText = stripMarkdownCodeBlock(text);

  const extractTag = (input, tag) => {
    const startTag = `<${tag}>`;
    const endTag = `</${tag}>`;
    const startIdx = input.indexOf(startTag);
    if (startIdx === -1) return null;
    const contentStart = startIdx + startTag.length;
    const endIdx = input.indexOf(endTag, contentStart);
    return endIdx !== -1
      ? input.substring(contentStart, endIdx).trim()
      : input.substring(contentStart).trim();
  };

  let toolCall = null;
  const toolMatch = normalizedText.match(
    /<call_tool\s+name\s*=\s*["']?([\w-]+)["']?\s*>([\s\S]*?)(?:<\/call_tool>|$)/i,
  );
  if (toolMatch) {
    const params = {};
    const paramRegex =
      /<parameter\s+name\s*=\s*["']?([\w-]+)["']?\s*>([\s\S]*?)(?:<\/parameter>|$)/gi;
    let pMatch;
    while ((pMatch = paramRegex.exec(toolMatch[2])) !== null) {
      params[pMatch[1]] = unescapeXmlText(pMatch[2].trim());
    }
    toolCall = { name: toolMatch[1], params };
  }

  const thought = extractTag(normalizedText, "thought");
  const finish = extractTag(normalizedText, "finish");

  if (!toolCall && !finish) {
    // Walk through every top-level {...} candidate so nested JSON inside
    // `params` (e.g. {"params": {"path": "."}}) still parses correctly.
    for (const candidate of extractBalancedObjects(normalizedText)) {
      try {
        const data = JSON.parse(candidate);
        const jsonTool =
          data.tool || data.toolName || data.call_tool || data.toolCall?.name || data.action;
        const jsonParams =
          data.parameters || data.params || data.toolCall?.params || data.arguments || data.args;
        if (jsonTool) toolCall = { name: String(jsonTool), params: jsonParams || {} };
        if (data.thought && !thought)
          return { thought: data.thought, finish: data.finish || null, toolCall };
        if (data.finish && !finish) return { thought, finish: data.finish, toolCall };
        if (toolCall) break;
      } catch {
        /* try the next candidate */
      }
    }
  }

  return { thought, finish, toolCall };
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
      if (ch === "\\") escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
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
  if (!record) return "";
  if (typeof record === "string") return record;
  return (
    record.content ||
    record?.choices?.[0]?.delta?.content ||
    record?.choices?.[0]?.message?.content ||
    record?.message?.content ||
    record?.delta?.content ||
    record?.text ||
    ""
  );
}
