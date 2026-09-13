import { jest } from '@jest/globals';
import request from 'supertest';

// Mock API client for server testing
jest.unstable_mockModule('../utils/api-client.js', () => ({
  callOneMin: jest.fn(),
  extractText: jest.fn((data) => data?.result || JSON.stringify(data)),
  isFailedResponse: jest.fn(() => false),
  extractFailureMessage: jest.fn(() => 'mocked failure'),
  normalizeOneMinRawResponse: jest.fn(async (data) => data),
  normalizeAssetResponse: jest.fn((data) => ({ key: data?.asset?.key || '', url: '', raw: data })),
  parseResponsePayload: jest.fn(async (response) => {
    const text = await response.text();
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch {
      return { message: text };
    }
  }),
}));

const { createApp } = await import('../server.js');
const { buildCodePayload } = await import('../utils/web-search.js');
const { stripSearchArtifacts, repairAndParseJson, parseXMLTags, parseAgentResponse } =
  await import('../public/js/utils.js');
const { extractTextFromOneMinResponse } = await import('../utils/one-min-response.js');
const { callOneMin } = await import('../utils/api-client.js');

describe('Agent Web Search Resilience & Forceful Intervention Prevention', () => {
  let app;

  beforeAll(() => {
    app = createApp();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('1min.ai Schema Compliance: buildCodePayload', () => {
    test('omits numOfSite and maxWord when webSearch is false even if they are passed', () => {
      const payload = buildCodePayload({
        prompt: 'test prompt',
        model: 'qwen3-coder-plus',
        webSearch: false,
        parsedNumOfSite: 3,
        parsedMaxWord: 1000,
      });

      expect(payload.promptObject.webSearch).toBe(false);
      expect(payload.promptObject).not.toHaveProperty('numOfSite');
      expect(payload.promptObject).not.toHaveProperty('maxWord');
    });

    test('includes numOfSite and maxWord when webSearch is true', () => {
      const payload = buildCodePayload({
        prompt: 'test prompt',
        model: 'qwen3-coder-plus',
        webSearch: true,
        parsedNumOfSite: 5,
        parsedMaxWord: 2000,
      });

      expect(payload.promptObject.webSearch).toBe(true);
      expect(payload.promptObject.numOfSite).toBe(5);
      expect(payload.promptObject.maxWord).toBe(2000);
    });
  });

  describe('stripSearchArtifacts utility', () => {
    test('strips trailing Sources and References blocks', () => {
      const input = `{"thought": "done", "tool": "read_file", "params": {"path": "a.js"}}\n\nSources:\n[1] https://nodejs.org\n[2] https://github.com`;
      const cleaned = stripSearchArtifacts(input);
      expect(cleaned).toBe('{"thought": "done", "tool": "read_file", "params": {"path": "a.js"}}');
    });

    test('strips trailing markdown footnote link references', () => {
      const input = `{"thought": "done", "tool": "read_file", "params": {"path": "a.js"}}\n\n[1]: https://nodejs.org "Node.js Docs"`;
      const cleaned = stripSearchArtifacts(input);
      expect(cleaned).toBe('{"thought": "done", "tool": "read_file", "params": {"path": "a.js"}}');
    });

    test('strips leading Search Results blocks preceding agent actions', () => {
      const input = `Search Results for "fs":\n1. Node docs https://nodejs.org\n2. MDN docs\n\n<thought>Found it</thought><call_tool name="read_file"><parameter name="path">a.js</parameter></call_tool>`;
      const cleaned = stripSearchArtifacts(input);
      expect(cleaned).toBe(
        '<thought>Found it</thought><call_tool name="read_file"><parameter name="path">a.js</parameter></call_tool>',
      );
    });

    test('strips leading Web Search Results preceding JSON actions', () => {
      const input = `Web Search Results:\n1. Title: React 19 Docs\n   URL: https://react.dev\n\n{"thought": "Found docs", "tool": "read_file", "params": {"path": "package.json"}}`;
      const cleaned = stripSearchArtifacts(input);
      expect(cleaned).toBe(
        '{"thought": "Found docs", "tool": "read_file", "params": {"path": "package.json"}}',
      );
    });

    test('strips gear crawling status lines preceding artifact tags', () => {
      const input = `⚙ Crawling site https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js\n<artifact identifier="threejs-scroll-portfolio" type="text/html" title="Portfolio">\n<!DOCTYPE html><html></html>\n</artifact>`;
      const cleaned = stripSearchArtifacts(input);
      expect(cleaned).toBe(
        '<artifact identifier="threejs-scroll-portfolio" type="text/html" title="Portfolio">\n<!DOCTYPE html><html></html>\n</artifact>',
      );
    });

    test('strips gear crawling status lines preceding thinking tags', () => {
      const input = `⚙ Crawling site https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js\n<thinking>Three.js portfolio</thinking><call_tool name="write_file"><parameter name="path">index.html</parameter></call_tool>`;
      const cleaned = stripSearchArtifacts(input);
      expect(cleaned).toBe(
        '<thinking>Three.js portfolio</thinking><call_tool name="write_file"><parameter name="path">index.html</parameter></call_tool>',
      );
    });

    test('strips multiple crawling, browsing, and search status lines', () => {
      const input = `⚙ Crawling site https://a.com\nCrawled site https://b.com\n⚙ Browsing page https://c.com\nSearching the web for threejs\n<thinking>Done</thinking><finish>All good</finish>`;
      const cleaned = stripSearchArtifacts(input);
      expect(cleaned).toBe('<thinking>Done</thinking><finish>All good</finish>');
    });
  });

  describe('Parser Resilience against Injected Search Results', () => {
    test('repairAndParseJson parses JSON with trailing search sources', () => {
      const input = `{"thought": "I will read a.js", "tool": "read_file", "params": {"path": "a.js"}}\n\nSources:\n[1] https://nodejs.org\n[2] https://github.com`;
      const parsed = repairAndParseJson(input);
      expect(parsed).toEqual({
        thought: 'I will read a.js',
        tool: 'read_file',
        params: { path: 'a.js' },
      });
    });

    test('repairAndParseJson parses JSON with both leading search results and trailing citations', () => {
      const input = `Search Results for "express":\n- Express routing guide\n\n{"thought": "Routing", "tool": "write_file", "params": {"path": "server.js", "content": "const app = express();"}}\n\nCitations:\n- https://expressjs.com`;
      const parsed = repairAndParseJson(input);
      expect(parsed).toEqual({
        thought: 'Routing',
        tool: 'write_file',
        params: { path: 'server.js', content: 'const app = express();' },
      });
    });

    test('parseAgentResponse extracts action when search snippet contains unmatched opening brace', () => {
      const input = `Web Search Results:
1. Snippet: function parseConfig() {
  return true;
// end snippet

{"thought": "I will read a.js", "tool": "read_file", "params": {"path": "a.js"}}

Sources:
[1] https://nodejs.org`;

      const result = parseAgentResponse(input);
      expect(result.thought).toBe('I will read a.js');
      expect(result.toolCall).toEqual({
        name: 'read_file',
        params: { path: 'a.js' },
      });
    });

    test('parseAgentResponse extracts XML action when search results precede XML tags', () => {
      const input = `Search Results:
<a href="https://example.com">Link</a>
Snippet: <div>sample</div>

<thought>Found it</thought>
<call_tool name="read_file"><parameter name="path">a.js</parameter></call_tool>

Sources:
1. https://example.com`;

      const xmlResult = parseXMLTags(input);
      expect(xmlResult.thought).toBe('Found it');
      expect(xmlResult.toolCall).toEqual({
        name: 'read_file',
        params: { path: 'a.js' },
      });

      const result = parseAgentResponse(input);
      expect(result.thought).toBe('Found it');
      expect(result.toolCall).toEqual({
        name: 'read_file',
        params: { path: 'a.js' },
      });
    });

    test('parseAgentResponse extracts agent action when search metadata JSON object precedes agent action JSON', () => {
      const input = `{"search_results": [{"title": "node docs", "url": "https://nodejs.org"}]}\n{"thought": "I will read a.js", "tool": "read_file", "params": {"path": "a.js"}}`;
      const result = parseAgentResponse(input);
      expect(result.thought).toBe('I will read a.js');
      expect(result.toolCall).toEqual({
        name: 'read_file',
        params: { path: 'a.js' },
      });
    });

    test('parseAgentResponse extracts action and thought when crawling noise precedes thinking and artifact tags', () => {
      const input = `⚙ Crawling site https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js\n<thinking>Three.js portfolio</thinking>\n<artifact identifier="threejs-scroll-portfolio" type="text/html" title="Portfolio">\n<!DOCTYPE html><html><body><h1>Portfolio</h1></body></html>\n</artifact>`;
      const result = parseAgentResponse(input);
      expect(result.thought).toBe('Three.js portfolio');
      expect(result.toolCall).toEqual({
        name: 'write_file',
        params: {
          path: 'threejs-scroll-portfolio.html',
          content: '<!DOCTYPE html><html><body><h1>Portfolio</h1></body></html>',
        },
      });
    });
  });

  describe('one-min-response text extractor with search metadata', () => {
    test('filters out search metadata objects from resultObject arrays', () => {
      const mockResponse = {
        aiRecord: {
          aiRecordDetail: {
            resultObject: [
              { type: 'web_search', searchResults: [{ title: 'test', url: 'https://...' }] },
              '{"thought": "Actual AI completion", "finish": "done"}',
            ],
          },
        },
      };

      const extracted = extractTextFromOneMinResponse(mockResponse);
      expect(extracted).toBe('{"thought": "Actual AI completion", "finish": "done"}');
    });

    test('filters out standalone crawling status strings from resultObject arrays', () => {
      const mockResponse = {
        aiRecord: {
          aiRecordDetail: {
            resultObject: [
              '⚙ Crawling site https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js',
              '<thinking>Done</thinking><finish>Completed</finish>',
            ],
          },
        },
      };

      const extracted = extractTextFromOneMinResponse(mockResponse);
      expect(extracted).toBe('<thinking>Done</thinking><finish>Completed</finish>');
    });
  });

  describe('POST /api/agent/chat search artifact sanitization', () => {
    test('sanitizes text returned by upstream even if search results are injected', async () => {
      callOneMin.mockResolvedValueOnce({
        result: `Search Results:\n1. https://nodejs.org\n\n{"thought": "Fixing code", "tool": "read_file", "params": {"path": "index.js"}}\n\nSources:\n[1] https://nodejs.org`,
      });

      const response = await request(app).post('/api/agent/chat').send({
        prompt: 'Fix the bug',
        model: 'qwen3-coder-plus',
        webSearch: false,
      });

      expect(response.status).toBe(200);
      expect(response.body.text).toBe(
        '{"thought": "Fixing code", "tool": "read_file", "params": {"path": "index.js"}}',
      );
    });

    test('sanitizes gear crawling status line returned by upstream on 2nd turn', async () => {
      callOneMin.mockResolvedValueOnce({
        result: `⚙ Crawling site https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js\n<thinking>Portfolio built</thinking><finish>All done</finish>`,
      });

      const response = await request(app).post('/api/agent/chat').send({
        prompt: 'Repair output',
        model: 'deepseek-v4-flash',
        webSearch: false,
      });

      expect(response.status).toBe(200);
      expect(response.body.text).toBe('<thinking>Portfolio built</thinking><finish>All done</finish>');
    });
  });
});
