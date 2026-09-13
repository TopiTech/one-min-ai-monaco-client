/**
 * Regression tests: search-artifact stripping must never corrupt agent
 * structural payloads.
 *
 * Root cause being guarded against: stripSearchArtifacts() originally ran
 * over the ENTIRE agent response, including the inside of <call_tool>
 * parameters and JSON string values. A write_file / apply_diff payload that
 * legitimately contained lines like "Searching for the needle in the stack"
 * or a "Sources:" section was silently rewritten before the tool executed,
 * persisting corrupted content into user files.
 *
 * The fix makes stripping structural-aware: content inside
 * <call_tool>/<finish>/<artifact> is preserved verbatim, and heuristic
 * cleanup only applies to the surrounding prose. These tests pin that
 * contract for both the backend copy (utils/web-search.js) and the frontend
 * copy (public/js/utils.js), which must stay behaviorally identical.
 */
import fs from 'fs/promises';

const { stripSearchArtifacts, parseXMLTags } = await import('../public/js/utils.js');
const {
  stripSearchArtifacts: stripSearchArtifactsBackend,
  cleanOutsideStructuralTags: cleanOutsideStructuralTagsBackend,
} = await import('../utils/web-search.js');

describe('stripSearchArtifacts preserves structural tool payloads', () => {
  test('keeps "Searching for ..." prose lines inside call_tool parameters verbatim', () => {
    const body = 'function find() {\n  // Searching for the needle in the stack\n  return needle;\n}';
    const input = `<thought>edit</thought><call_tool name="write_file"><parameter name="path">find.js</parameter><parameter name="content">${body}</parameter></call_tool>`;
    for (const strip of [stripSearchArtifacts, stripSearchArtifactsBackend]) {
      const cleaned = strip(input);
      expect(cleaned).toContain('// Searching for the needle in the stack');
      expect(cleaned).toBe(input);
    }
  });

  test('keeps a "Sources:" documentation section inside JSON write_file content', () => {
    const input =
      '{"thought": "add docs", "tool": "write_file", "params": {"path": "docs.md", "content": "# Guide\\n\\nSources:\\n- https://example.com/guide"}}';
    for (const strip of [stripSearchArtifacts, stripSearchArtifactsBackend]) {
      const cleaned = strip(input);
      expect(cleaned).toContain('Sources:\\n- https://example.com/guide');
    }
  });

  test('keeps SEARCH/REPLACE diff blocks inside apply_diff parameters intact', () => {
    const diff =
      '<<<<<<< SEARCH\n// Fetching data from url https://api.example.com\n=======\n// Updated comment\n>>>>>>> REPLACE';
    const input = `<call_tool name="apply_diff"><parameter name="path">a.js</parameter><parameter name="diff">${diff}</parameter></call_tool>`;
    for (const strip of [stripSearchArtifacts, stripSearchArtifactsBackend]) {
      expect(strip(input)).toBe(input);
    }
  });

  test('keeps a finish message that merely starts with "Searching for ..." intact', () => {
    const input = '<finish>Searching for duplicates is done: none found.</finish>';
    for (const strip of [stripSearchArtifacts, stripSearchArtifactsBackend]) {
      expect(strip(input)).toBe(input);
    }
  });

  test('still strips crawling status lines AROUND structural tags', () => {
    const input =
      '⚙ Crawling site https://example.com\n<call_tool name="write_file"><parameter name="path">a.js</parameter><parameter name="content">ok</parameter></call_tool>\n\nSources:\n[1] https://example.com';
    for (const strip of [stripSearchArtifacts, stripSearchArtifactsBackend]) {
      const cleaned = strip(input);
      expect(cleaned).not.toContain('Crawling site');
      expect(cleaned).not.toContain('Sources:');
      expect(cleaned).toContain('<call_tool');
      expect(cleaned).toContain('>ok<');
    }
  });

  test('still strips loose status lines only when they carry a URL (outside tags)', () => {
    const kept = 'Searching for the bug without a URL\n<finish>done</finish>';
    expect(stripSearchArtifacts(kept)).toContain('Searching for the bug without a URL');
    expect(stripSearchArtifactsBackend(kept)).toContain('Searching for the bug without a URL');

    const stripped = 'Fetching https://example.com/data\n<finish>done</finish>';
    expect(stripSearchArtifacts(stripped)).not.toContain('Fetching');
    expect(stripSearchArtifactsBackend(stripped)).not.toContain('Fetching');
  });

  test('backend cleanOutsideStructuralTags leaves tag content untouched', () => {
    const input =
      'noise before\n<finish>keep  this</finish>noise after\n\nReferences:\n[1] https://example.com';
    const out = cleanOutsideStructuralTagsBackend(input, (seg) => seg.replace(/noise/g, ''));
    expect(out).toContain('<finish>keep  this</finish>');
    expect(out).not.toContain('noise');
  });
});

describe('parseXMLTags structural payload integrity', () => {
  test('write_file content containing "Searching for ..." survives parsing', () => {
    const body = '// Searching for items below this line\nexport const list = [];';
    const result = parseXMLTags(
      `<thought>t</thought><call_tool name="write_file"><parameter name="path">list.js</parameter><parameter name="content">${body}</parameter></call_tool>`,
    );
    expect(result.toolCall).toEqual({
      name: 'write_file',
      params: { path: 'list.js', content: body },
    });
  });

  test('JSON tool call whose content contains a Sources section parses losslessly', () => {
    const content = 'Guide\n\nSources:\n- https://example.com';
    const input = `{"thought":"docs","tool":"write_file","params":{"path":"guide.md","content":${JSON.stringify(content)}}}`;
    const result = parseXMLTags(input);
    expect(result.toolCall).toEqual({
      name: 'write_file',
      params: { path: 'guide.md', content },
    });
  });

  test('thought/finish text outside tags still gets artifacts removed', () => {
    const input =
      '⚙ Crawling site https://example.com\n<thinking>plan</thinking><finish>All done</finish>\n\nSources:\n[1] https://example.com';
    const result = parseXMLTags(input);
    expect(result.thought).toBe('plan');
    expect(result.finish).toBe('All done');
  });
});

describe('frontend/backend stripSearchArtifacts implementations stay in sync', () => {
  test('exported source of stripSearchArtifacts is identical in both modules', async () => {
    const readExportedFn = async (relPath) => {
      const src = await fs.readFile(new URL(relPath, import.meta.url), 'utf-8');
      const match = src.match(/export function stripSearchArtifacts[\s\S]*?\n(?=^\/\*\*|\n)/m);
      expect(match).toBeTruthy();
      return match[0].trimEnd();
    };
    const frontend = await readExportedFn('../public/js/utils.js');
    const backend = await readExportedFn('../utils/web-search.js');
    expect(frontend).toBe(backend);
  });
});
