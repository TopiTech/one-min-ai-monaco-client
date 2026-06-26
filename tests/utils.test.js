/**
 * Unit tests for the pure helper functions in public/js/utils.js.
 *
 * The module is browser-only (uses document / window) so we run it inside
 * jsdom. These tests are intentionally narrow: the helpers are stateless
 * and side-effect free.
 */
import { jest } from '@jest/globals';
import { TextEncoder } from 'util';

/**
 * Minimal browser-ish globals. We only need what utils.js touches:
 * document.createElementNS for the SVG helpers and window.* for the
 * markdown renderer fallback.
 */
const fakeSvgNS = 'http://www.w3.org/2000/svg';
const created = [];

global.document = {
  createElementNS: (_ns, tag) => {
    const el = {
      tagName: tag,
      attrs: {},
      children: [],
      setAttribute(k, v) {
        this.attrs[k] = String(v);
      },
      appendChild(child) {
        this.children.push(child);
        return child;
      },
      classList: { add: () => {} },
    };
    created.push(el);
    return el;
  },
  createTextNode: (text) => ({ nodeType: 3, data: String(text) }),
};

global.window = {};

// Make TextEncoder available for the runtime in case utils.js needs it.
if (typeof global.TextEncoder === 'undefined') {
  global.TextEncoder = TextEncoder;
}

const {
  escapeHtml,
  formatMarkdownLike,
  stripMarkdownCodeBlock,
  unescapeXmlText,
  parseXMLTags,
  createSvgIcon,
  appendStepIcon,
  SVG_NS,
} = await import('../public/js/utils.js');

describe('escapeHtml', () => {
  test('escapes all dangerous characters', () => {
    expect(escapeHtml(`<script>alert("x&y'z")</script>`)).toBe(
      '&lt;script&gt;alert(&quot;x&amp;y&#039;z&quot;)&lt;/script&gt;',
    );
  });
  test('returns empty string for non-string input', () => {
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(undefined)).toBe('');
    expect(escapeHtml(42)).toBe('');
  });
});

describe('formatMarkdownLike', () => {
  test('wraps inline code and bold', () => {
    const out = formatMarkdownLike('use `foo` then **bar**');
    expect(out).toContain('<code>foo</code>');
    expect(out).toContain('<strong>bar</strong>');
  });
  test('html-escapes raw markup so it cannot inject', () => {
    const out = formatMarkdownLike('<img src=x onerror=alert(1)>');
    expect(out).not.toContain('<img');
    expect(out).toContain('&lt;img');
  });
});

describe('stripMarkdownCodeBlock', () => {
  test('strips a single fenced block', () => {
    expect(stripMarkdownCodeBlock('```js\nconst x = 1;\n```')).toBe('const x = 1;');
  });
  test('returns the original text when not fenced', () => {
    expect(stripMarkdownCodeBlock('plain text')).toBe('plain text');
  });
});

describe('unescapeXmlText', () => {
  test('reverses the five XML entities', () => {
    expect(unescapeXmlText('a &lt; b &gt; c &amp; d &quot;e&quot; &apos;f&apos;')).toBe(
      'a < b > c & d "e" \'f\'',
    );
  });
});

describe('parseXMLTags', () => {
  test('extracts thought + call_tool + parameter', () => {
    const xml =
      '<thought>thinking</thought><call_tool name="read_file"><parameter name="path">a.js</parameter></call_tool>';
    const out = parseXMLTags(xml);
    expect(out.thought).toBe('thinking');
    expect(out.toolCall).toEqual({ name: 'read_file', params: { path: 'a.js' } });
  });
  test('decodes XML-escaped parameter values', () => {
    const xml =
      '<call_tool name="write_file"><parameter name="content">a &lt; b &amp;&amp; c &gt; d</parameter></call_tool>';
    const out = parseXMLTags(xml);
    expect(out.toolCall.params.content).toBe('a < b && c > d');
  });
  test('extracts finish tag', () => {
    const out = parseXMLTags('<finish>all done</finish>');
    expect(out.finish).toBe('all done');
  });
  test('falls back to JSON-shaped fragment', () => {
    const out = parseXMLTags('{"tool": "ls", "params": {"path": "."}}');
    expect(out.toolCall).toEqual({ name: 'ls', params: { path: '.' } });
  });
  test('returns nulls for empty input', () => {
    expect(parseXMLTags('')).toEqual({ thought: null, finish: null, toolCall: null });
    expect(parseXMLTags(null)).toEqual({ thought: null, finish: null, toolCall: null });
  });
  test('handles JSON with nested params', () => {
    const input = JSON.stringify({
      tool: 'read_file',
      parameters: { path: '/tmp/a.js', options: { recursive: true } },
    });
    const out = parseXMLTags(input);
    expect(out.toolCall).toEqual({
      name: 'read_file',
      params: { path: '/tmp/a.js', options: { recursive: true } },
    });
  });
  test('handles JSON with action field', () => {
    const input = JSON.stringify({ action: 'write_file', args: { content: 'hello world' } });
    const out = parseXMLTags(input);
    expect(out.toolCall).toEqual({ name: 'write_file', params: { content: 'hello world' } });
  });
  test('handles malformed XML gracefully', () => {
    const input = String.fromCharCode(60) + 'thought>partial';
    const out = parseXMLTags(input);
    expect(out.thought).toBe('partial');
    expect(out.finish).toBeNull();
    expect(out.toolCall).toBeNull();
  });
  test('handles non-string input', () => {
    expect(parseXMLTags(42)).toEqual({ thought: null, finish: null, toolCall: null });
    expect(parseXMLTags({})).toEqual({ thought: null, finish: null, toolCall: null });
  });
  test('extracts multiple parameters', () => {
    var dq = String.fromCharCode(34);
    var cp = String.fromCharCode(60) + '/parameter>';
    var cc = String.fromCharCode(60) + '/call_tool>';
    var input =
      String.fromCharCode(60) +
      'call_tool name=' +
      dq +
      'read_file' +
      dq +
      '>' +
      String.fromCharCode(60) +
      'parameter name=' +
      dq +
      'path' +
      dq +
      '>a.js' +
      cp +
      String.fromCharCode(60) +
      'parameter name=' +
      dq +
      'encoding' +
      dq +
      '>utf-8' +
      cp +
      cc;
    const out = parseXMLTags(input);
    expect(out.toolCall).toEqual({ name: 'read_file', params: { path: 'a.js', encoding: 'utf-8' } });
  });
  test('handles unquoted XML attribute', () => {
    var input =
      String.fromCharCode(60) +
      'call_tool name=git_status>' +
      String.fromCharCode(60) +
      'parameter name=repo>/tmp/my-repo' +
      String.fromCharCode(60) +
      '/parameter>' +
      String.fromCharCode(60) +
      '/call_tool>';
    const out = parseXMLTags(input);
    expect(out.toolCall).toEqual({ name: 'git_status', params: { repo: '/tmp/my-repo' } });
  });

  // F-14: parseXMLTags must reject oversized input to prevent DoS.
  test('drops inputs larger than the maximum size cap', () => {
    const big = '<thought>' + 'a'.repeat(300 * 1024) + '</thought>';
    const out = parseXMLTags(big);
    expect(out).toEqual({ thought: null, finish: null, toolCall: null });
  });

  // F-14: parseXMLTags caps the number of JSON-fallback candidates.
  test('caps the JSON-fallback candidate count', () => {
    // Build a long string of 64 separate JSON object fragments so the
    // balanced-object extractor returns many candidates. parseXMLTags
    // should still complete quickly and not exceed the candidate cap.
    let payload = '';
    for (let i = 0; i < 64; i++) {
      payload += `{"tool":"t${i}","params":{"i":${i}}}`;
    }
    const out = parseXMLTags(payload);
    // Some tool call should be returned (within the cap), but never all 64.
    expect(out.toolCall).not.toBeNull();
    expect(out.toolCall.name).toMatch(/^t\d+$/);
    expect(Number(out.toolCall.params.i)).toBeLessThan(64);
  });
});

describe('createSvgIcon / appendStepIcon', () => {
  test('createSvgIcon builds an <svg> with the requested viewBox + path', () => {
    const svg = createSvgIcon('0 0 1 1', 'M0 0');
    expect(svg.tagName).toBe('svg');
    expect(svg.attrs.viewBox).toBe('0 0 1 1');
    expect(svg.children).toHaveLength(1);
    expect(svg.children[0].attrs.d).toBe('M0 0');
  });
  test("appendStepIcon falls back to 'thought' for unknown types", () => {
    const container = { appendChild: jest.fn() };
    appendStepIcon(container, 'this-type-does-not-exist');
    expect(container.appendChild).toHaveBeenCalled();
    // First call is the SVG, second is the text node.
    const textNode = container.appendChild.mock.calls[1][0];
    // i18n returns the key when translations aren't loaded in test environment
    expect(textNode.data.endsWith(': ')).toBe(true);
  });
  test('SVG_NS is the SVG namespace', () => {
    expect(SVG_NS).toBe(fakeSvgNS);
  });
});
