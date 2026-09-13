import { jest } from '@jest/globals';
import request from 'supertest';
import path from 'path';
import fs from 'fs/promises';

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
const { repairAndParseJson, parseXMLTags, parseAgentResponse } = await import('../public/js/utils.js');
const { validateCodeSyntax, extractSymbols, getProjectMetadata } = await import(
  '../services/code-analyzer.js'
);

describe('Agent Supercharge: Parser Robustness & JSON Self-Repair', () => {
  test('repairAndParseJson parses standard JSON directly', () => {
    const input = '{"name": "test", "count": 42}';
    expect(repairAndParseJson(input)).toEqual({ name: 'test', count: 42 });
  });

  test('repairAndParseJson fixes trailing commas in arrays and objects', () => {
    const input = '{"items": [1, 2, 3,], "status": "ok",}';
    expect(repairAndParseJson(input)).toEqual({ items: [1, 2, 3], status: 'ok' });
  });

  test('repairAndParseJson converts single-quoted keys and values', () => {
    const input = "{'tool': 'write_file', 'params': {'path': 'a.js', 'content': 'hello'}}";
    expect(repairAndParseJson(input)).toEqual({
      tool: 'write_file',
      params: { path: 'a.js', content: 'hello' },
    });
  });

  test('repairAndParseJson normalizes smart/curly quotes', () => {
    const input = '{\u201Ctool\u201D: \u201Cread_file\u201D, \u201Cparams\u201D: {\u201Cpath\u201D: \u201Cmain.py\u201D}}';
    expect(repairAndParseJson(input)).toEqual({
      tool: 'read_file',
      params: { path: 'main.py' },
    });
  });

  test('repairAndParseJson strips single-line and multi-line comments', () => {
    const input = `{\n  // Target tool\n  "tool": "list_directory",\n  /* Directory path */\n  "params": {"path": "src"}\n}`;
    expect(repairAndParseJson(input)).toEqual({
      tool: 'list_directory',
      params: { path: 'src' },
    });
  });

  test('repairAndParseJson fixes unescaped raw newlines inside string literals', () => {
    const input = '{"tool": "write_file", "params": {"content": "function hello() {\n  return true;\n}"}}';
    const result = repairAndParseJson(input);
    expect(result.tool).toBe('write_file');
    expect(result.params.content).toContain('return true;');
  });

  test('repairAndParseJson extracts and parses markdown code fences', () => {
    const input = '```json\n{"thought": "exploring", "tool": "search_files", "params": {"query": "api"}}\n```';
    expect(repairAndParseJson(input)).toEqual({
      thought: 'exploring',
      tool: 'search_files',
      params: { query: 'api' },
    });
  });

  test('repairAndParseJson extracts JSON embedded within conversational text', () => {
    const input = 'I will inspect the workspace.\n```json\n{"tool": "find_files", "params": {"pattern": "*.js"}}\n```\nLet me know if you need more.';
    expect(repairAndParseJson(input)).toEqual({
      tool: 'find_files',
      params: { pattern: '*.js' },
    });
  });

  test('repairAndParseJson auto-closes truncated JSON objects', () => {
    const input = '{"thought": "writing", "tool": "write_file", "params": {"path": "out.js", "content": "const a = 1;';
    const result = repairAndParseJson(input);
    expect(result.tool).toBe('write_file');
    expect(result.params.path).toBe('out.js');
    expect(result.params.content).toBe('const a = 1;');
  });

  test('parseXMLTags and parseAgentResponse handle dual protocol (XML & JSON)', () => {
    // Pure XML
    const xml = '<thought>checking</thought><call_tool name="read_file"><parameter name="path">a.js</parameter></call_tool>';
    const parsedXml = parseAgentResponse(xml);
    expect(parsedXml.thought).toBe('checking');
    expect(parsedXml.toolCall).toEqual({ name: 'read_file', params: { path: 'a.js' } });

    // XML with CDATA
    const xmlCdata = '<thought><![CDATA[thinking <deeply>]]></thought><call_tool name="validate_code"><parameter name="code"><![CDATA[if (a < b && c > d) {}]]></parameter></call_tool>';
    const parsedCdata = parseXMLTags(xmlCdata);
    expect(parsedCdata.thought).toBe('thinking <deeply>');
    expect(parsedCdata.toolCall.params.code).toBe('if (a < b && c > d) {}');

    // JSON response in markdown code fence
    const jsonFenced = '```json\n{"thought": "done", "finish": "Refactoring complete."}\n```';
    const parsedJson = parseAgentResponse(jsonFenced);
    expect(parsedJson.thought).toBe('done');
    expect(parsedJson.finish).toBe('Refactoring complete.');

    // Malformed JSON tool call with trailing commas and unescaped line breaks
    const malformedJson = '{"thought": "fixing", "tool": "apply_diff", "params": {"path": "index.js", "diff": "line1\nline2",},}';
    const parsedMalformed = parseXMLTags(malformedJson);
    expect(parsedMalformed.thought).toBe('fixing');
    expect(parsedMalformed.toolCall.name).toBe('apply_diff');
    expect(parsedMalformed.toolCall.params.path).toBe('index.js');
  });
});

describe('Code Analyzer Service: Syntax Validation & Symbols', () => {
  test('validateCodeSyntax validates correct JavaScript without executing', () => {
    const validJs = 'export const add = (a, b) => a + b;\nconsole.log(add(1, 2));';
    const result = validateCodeSyntax(validJs, 'javascript');
    expect(result.valid).toBe(true);
  });

  test('validateCodeSyntax catches syntax errors with line numbers', () => {
    const invalidJs = 'function broken( { return 1;';
    const result = validateCodeSyntax(invalidJs, 'javascript');
    expect(result.valid).toBe(false);
    expect(result.error).toBeDefined();
  });

  test('validateCodeSyntax validates valid and invalid JSON', () => {
    expect(validateCodeSyntax('{"valid": true}', 'json').valid).toBe(true);
    const invalidJson = validateCodeSyntax('{"invalid": true,}', 'json');
    expect(invalidJson.valid).toBe(false);
    expect(invalidJson.error).toBeDefined();
  });

  test('extractSymbols extracts function and class outlines', () => {
    const code = `
export class UserService {
  constructor() {}
}

export function findUser(id) {
  return null;
}

export const deleteUser = async (id) => {
  return true;
};
`;
    const symbols = extractSymbols(code, 'javascript');
    expect(symbols.length).toBe(3);
    expect(symbols.some((s) => s.name === 'UserService' && s.type === 'class')).toBe(true);
    expect(symbols.some((s) => s.name === 'findUser' && s.type === 'function')).toBe(true);
    expect(symbols.some((s) => s.name === 'deleteUser' && s.type === 'function')).toBe(true);
  });

  test('getProjectMetadata retrieves package.json info and config files', async () => {
    const metadata = await getProjectMetadata(process.cwd());
    expect(metadata.hasPackageJson).toBe(true);
    expect(metadata.projectName).toBe('one-min-ai-monaco-client');
    expect(metadata.testCommand).toBe('npm test');
    expect(metadata.configFiles.length).toBeGreaterThan(0);
  });
});

describe('Agent New Endpoints & apply_diff Enhancements', () => {
  let app;
  let sessionId;

  beforeEach(async () => {
    process.env.NODE_ENV = 'test';
    app = createApp({ requireLocalAuth: false, enableRateLimit: false });

    const sessionRes = await request(app)
      .post('/api/agent/sessions')
      .send({ cwd: process.cwd(), task: 'Supercharge testing' });

    sessionId = sessionRes.body.session.id;
  });

  afterEach(() => {
    delete process.env.NODE_ENV;
  });

  test('GET /sessions/:id/find-files finds files matching glob pattern', async () => {
    const res = await request(app)
      .get(`/api/agent/sessions/${sessionId}/find-files`)
      .query({ pattern: 'server.js' });

    expect(res.status).toBe(200);
    expect(res.body.count).toBeGreaterThanOrEqual(1);
    expect(res.body.files.some((f) => f.name === 'server.js')).toBe(true);
  });

  test('GET /sessions/:id/outline extracts symbols from file', async () => {
    const res = await request(app)
      .get(`/api/agent/sessions/${sessionId}/outline`)
      .query({ path: 'server.js' });

    expect(res.status).toBe(200);
    expect(res.body.path).toBeDefined();
    expect(res.body.symbols).toBeInstanceOf(Array);
    expect(res.body.count).toBeGreaterThanOrEqual(1);
  });

  test('POST /sessions/:id/validate checks code syntax via API', async () => {
    const validRes = await request(app)
      .post(`/api/agent/sessions/${sessionId}/validate`)
      .send({ code: 'const a = 1; const b = 2;', language: 'javascript' });

    expect(validRes.status).toBe(200);
    expect(validRes.body.valid).toBe(true);

    const invalidRes = await request(app)
      .post(`/api/agent/sessions/${sessionId}/validate`)
      .send({ code: 'const a = ;', language: 'javascript' });

    expect(invalidRes.status).toBe(200);
    expect(invalidRes.body.valid).toBe(false);
  });

  test('GET /sessions/:id/project-info returns structured project metadata', async () => {
    const res = await request(app).get(`/api/agent/sessions/${sessionId}/project-info`);

    expect(res.status).toBe(200);
    expect(res.body.project).toBeDefined();
    expect(res.body.project.hasPackageJson).toBe(true);
    expect(res.body.project.projectName).toBe('one-min-ai-monaco-client');
  });

  test('POST /sessions/:id/diff returns actionable diagnostic hints when matching fails', async () => {
    const tempFile = path.join(process.cwd(), 'temp-hint-test.txt');
    await fs.writeFile(tempFile, 'line 1\nconst myTargetVariable = 100;\nline 3', 'utf-8');

    try {
      const diffContent = `<<<<<<< SEARCH
const myTargetVariable = 999;
=======
const myTargetVariable = 200;
>>>>>>> REPLACE`;

      const res = await request(app)
        .post(`/api/agent/sessions/${sessionId}/diff`)
        .send({ path: tempFile, diff: diffContent });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('置換対象の SEARCH ブロックのコードが見つかりません');
      // Should provide diagnostic hint showing closest match in file
      expect(res.body.hint).toBeDefined();
      expect(res.body.hint.snippet).toContain('const myTargetVariable = 100;');
    } finally {
      await fs.unlink(tempFile).catch(() => {});
    }
  });

  test('POST /sessions/:id/diff supports startLine disambiguation when multiple matches exist', async () => {
    const tempFile = path.join(process.cwd(), 'temp-startline-test.txt');
    await fs.writeFile(tempFile, 'block_a\nrepeat\nblock_b\nrepeat\nblock_c', 'utf-8');

    try {
      const diffContent = `<<<<<<< SEARCH
repeat
=======
replaced_second
>>>>>>> REPLACE`;

      // Pass startLine = 4 to disambiguate the 2nd 'repeat'
      const res = await request(app)
        .post(`/api/agent/sessions/${sessionId}/diff`)
        .send({ path: tempFile, diff: diffContent, startLine: 4 });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);

      const updated = await fs.readFile(tempFile, 'utf-8');
      expect(updated).toContain('block_a\nrepeat\nblock_b\nreplaced_second\nblock_c');
    } finally {
      await fs.unlink(tempFile).catch(() => {});
    }
  });
});
