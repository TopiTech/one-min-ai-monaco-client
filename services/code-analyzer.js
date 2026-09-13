import vm from 'node:vm';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

function parseNodeCheckError(stderr) {
  if (!stderr) return { error: 'Unknown syntax error' };
  let line = undefined;
  let col = undefined;
  let errorMsg = 'Syntax error';

  const lineMatch = stderr.match(/\[stdin\]:(\d+)(?::(\d+))?/);
  if (lineMatch) {
    line = Number(lineMatch[1]);
    if (lineMatch[2]) col = Number(lineMatch[2]);
  }

  const errMatch = stderr.match(/SyntaxError:\s*([^\r\n]+)/);
  if (errMatch) {
    errorMsg = errMatch[1].trim();
  }

  return { error: errorMsg, line, column: col };
}

/**
 * Validate syntax of code in supported languages without executing it.
 *
 * @param {string} code - Source code string.
 * @param {string} language - Target language ('javascript', 'js', 'json', 'typescript', 'ts', 'css', etc.).
 * @returns {{ valid: boolean, error?: string, line?: number, column?: number }}
 */
export function validateCodeSyntax(code, language = 'javascript') {
  if (typeof code !== 'string') {
    return { valid: false, error: 'Code must be a string' };
  }

  const lang = String(language).toLowerCase().trim();

  // JSON Validation
  if (lang === 'json') {
    try {
      JSON.parse(code);
      return { valid: true };
    } catch (err) {
      let line = 1;
      let col = 1;
      const posMatch = err.message.match(/at position (\d+)/i);
      if (posMatch) {
        const pos = Number(posMatch[1]);
        const lines = code.slice(0, pos).split('\n');
        line = lines.length;
        col = lines[lines.length - 1].length + 1;
      }
      return { valid: false, error: err.message, line, column: col };
    }
  }

  // JavaScript Validation (ES module and script parsing via Node V8 AST check without executing)
  if (['javascript', 'js', 'mjs', 'cjs', 'node'].includes(lang)) {
    try {
      const res = spawnSync(process.execPath, ['--input-type=module', '--check'], {
        input: code,
        encoding: 'utf-8',
        timeout: 2000,
        windowsHide: true,
      });

      if (res.status === 0) {
        return { valid: true };
      }

      // If failed due to CommonJS top-level return, check as CommonJS script
      if (res.stderr && res.stderr.includes('Illegal return statement')) {
        const cjsRes = spawnSync(process.execPath, ['--check'], {
          input: code,
          encoding: 'utf-8',
          timeout: 2000,
          windowsHide: true,
        });
        if (cjsRes.status === 0) {
          return { valid: true };
        }
        const parsed = parseNodeCheckError(cjsRes.stderr);
        return { valid: false, ...parsed };
      }

      const parsed = parseNodeCheckError(res.stderr);
      return { valid: false, ...parsed };
    } catch {
      // In-memory fallback via vm.Script if process spawn fails
      try {
        new vm.Script(code, { filename: 'syntax_check.js' });
        return { valid: true };
      } catch (err) {
        let line = undefined;
        let col = undefined;
        const stack = err.stack || '';
        const match = stack.match(/syntax_check\.js:(\d+)(?::(\d+))?/);
        if (match) {
          line = Number(match[1]);
          col = match[2] ? Number(match[2]) : undefined;
        }
        return { valid: false, error: err.message, line, column: col };
      }
    }
  }

  // TypeScript / JSX / TSX Lightweight check
  if (['typescript', 'ts', 'tsx', 'jsx'].includes(lang)) {
    // Check balanced brackets and common syntax errors
    const errors = checkBracketsBalance(code);
    if (errors) {
      return { valid: false, error: errors };
    }
    return { valid: true };
  }

  // CSS Validation (basic balanced braces)
  if (['css', 'scss', 'less'].includes(lang)) {
    const errors = checkBracketsBalance(code);
    if (errors) {
      return { valid: false, error: errors };
    }
    return { valid: true };
  }

  return { valid: true };
}

/**
 * Check balanced pairs of braces, brackets, and parentheses with full state tracking
 * for strings, template literals with ${...}, and single-line/block comments.
 */
function checkBracketsBalance(code) {
  const stack = [];
  const pairs = { '}': '{', ']': '[', ')': '(' };
  let state = 'code'; // 'code' | 'line_comment' | 'block_comment' | 'single_quote' | 'double_quote' | 'template'
  let stringStart = null;
  let escape = false;

  let line = 1;
  let col = 0;

  for (let i = 0; i < code.length; i++) {
    const ch = code[i];
    col++;

    if (ch === '\n') {
      line++;
      col = 0;
      if (state === 'line_comment') {
        state = 'code';
      } else if ((state === 'single_quote' || state === 'double_quote') && !escape) {
        // Raw newline in single/double quoted string without backslash escape is a syntax error
        return `Unterminated string literal at line ${stringStart.line}, column ${stringStart.col}`;
      }
      escape = false;
      continue;
    }

    if (escape) {
      escape = false;
      continue;
    }

    if (ch === '\\' && (state === 'single_quote' || state === 'double_quote' || state === 'template')) {
      escape = true;
      continue;
    }

    if (state === 'code') {
      if (ch === '/' && code[i + 1] === '/') {
        state = 'line_comment';
        i++;
        col++;
        continue;
      }
      if (ch === '/' && code[i + 1] === '*') {
        state = 'block_comment';
        stringStart = { line, col };
        i++;
        col++;
        continue;
      }
      if (ch === "'") {
        state = 'single_quote';
        stringStart = { line, col };
        continue;
      }
      if (ch === '"') {
        state = 'double_quote';
        stringStart = { line, col };
        continue;
      }
      if (ch === '`') {
        state = 'template';
        stringStart = { line, col };
        continue;
      }

      if (ch === '{' || ch === '[' || ch === '(') {
        stack.push({ ch, line, col });
      } else if (ch === '}' || ch === ']' || ch === ')') {
        const last = stack.pop();
        if (!last) {
          return `Unmatched closing '${ch}' at line ${line}, column ${col}`;
        }
        if (last.ch === '${' && ch === '}') {
          state = last.prevState || 'template';
          continue;
        }
        if (last.ch !== pairs[ch]) {
          return `Unmatched closing '${ch}' at line ${line}, column ${col}`;
        }
      }
    } else if (state === 'block_comment') {
      if (ch === '*' && code[i + 1] === '/') {
        state = 'code';
        i++;
        col++;
      }
    } else if (state === 'single_quote') {
      if (ch === "'") {
        state = 'code';
      }
    } else if (state === 'double_quote') {
      if (ch === '"') {
        state = 'code';
      }
    } else if (state === 'template') {
      if (ch === '`') {
        state = 'code';
      } else if (ch === '$' && code[i + 1] === '{') {
        stack.push({ ch: '${', line, col, prevState: 'template' });
        i++;
        col++;
        state = 'code';
      }
    }
  }

  if (state === 'block_comment') {
    return `Unclosed block comment started at line ${stringStart.line}, column ${stringStart.col}`;
  }
  if (state === 'single_quote' || state === 'double_quote' || state === 'template') {
    return `Unclosed string literal started at line ${stringStart.line}, column ${stringStart.col}`;
  }

  if (stack.length > 0) {
    const unclosed = stack.pop();
    const symbol = unclosed.ch === '${' ? '${' : unclosed.ch;
    return `Unclosed '${symbol}' opened at line ${unclosed.line}, column ${unclosed.col}`;
  }

  return null;
}

/**
 * Extract outline symbols (functions, classes, exports, interfaces, methods) from code.
 *
 * @param {string} code - Source code string.
 * @param {string} language - Target language.
 * @returns {Array<{ name: string, type: string, line: number, signature?: string }>}
 */
export function extractSymbols(code, language = 'javascript') {
  if (typeof code !== 'string') return [];
  const symbols = [];
  const lines = code.split(/\r?\n/);
  const lang = String(language).toLowerCase();

  const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'function', 'return']);

  for (let i = 0; i < lines.length; i++) {
    const lineNum = i + 1;
    const line = lines[i];
    const trimmed = line.trim();

    // Skip empty or pure comment lines
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('#') || trimmed.startsWith('/*')) {
      continue;
    }

    if (['javascript', 'js', 'typescript', 'ts', 'jsx', 'tsx'].includes(lang)) {
      // 1. Function declarations (including generator, async, and multiline parameter definitions)
      const fnMatch = line.match(
        /(?:export\s+(?:default\s+)?)?(?:async\s+)?function(?:\s*\*|\s+)\s*([A-Za-z0-9_$]+)?(?:\s*\(([^)]*)\))?/,
      );
      if (fnMatch && (fnMatch[1] || line.includes('('))) {
        const name = fnMatch[1] || '(anonymous function)';
        const params = fnMatch[2] !== undefined ? fnMatch[2] : '...';
        symbols.push({
          name,
          type: 'function',
          line: lineNum,
          signature: `function ${name}(${params})`,
        });
        continue;
      }

      // 2. Class declarations: class Foo ...
      const classMatch = line.match(
        /(?:export\s+(?:default\s+)?)?class\s+([A-Za-z0-9_$]+)(?:\s+extends\s+([A-Za-z0-9_$]+))?/,
      );
      if (classMatch) {
        symbols.push({
          name: classMatch[1],
          type: 'class',
          line: lineNum,
          signature: `class ${classMatch[1]}${classMatch[2] ? ` extends ${classMatch[2]}` : ''}`,
        });
        continue;
      }

      // 3. Arrow functions / Variable functions: const foo = (...) => ...
      const varFnMatch = line.match(
        /(?:export\s+)?(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*(?:async\s*)?(?:\(([^)]*)\)|[A-Za-z0-9_$]+)?\s*=>/,
      );
      if (varFnMatch) {
        symbols.push({
          name: varFnMatch[1],
          type: 'function',
          line: lineNum,
          signature: `const ${varFnMatch[1]} = (${varFnMatch[2] || ''}) =>`,
        });
        continue;
      }

      // 4. Interfaces & Types (TypeScript)
      const typeMatch = line.match(/(?:export\s+)?(?:interface|type)\s+([A-Za-z0-9_$]+)/);
      if (typeMatch) {
        symbols.push({
          name: typeMatch[1],
          type: 'type',
          line: lineNum,
          signature: trimmed.split('{')[0].trim(),
        });
        continue;
      }

      // 5. Named exports: export { a, b }
      const exportMatch = line.match(/^export\s+\{([^}]+)\}/);
      if (exportMatch) {
        symbols.push({
          name: exportMatch[1].trim(),
          type: 'export',
          line: lineNum,
          signature: trimmed,
        });
        continue;
      }

      // 6. Class methods: e.g. constructor(...) or async myMethod(...) {
      const methodMatch = line.match(
        /^\s*(?:(?:public|private|protected|static|async)\s+)*([A-Za-z0-9_$]+)\s*\(([^)]*)\)\s*(?::\s*[^;{]+)?\s*\{/,
      );
      if (methodMatch && !KEYWORDS.has(methodMatch[1])) {
        symbols.push({
          name: methodMatch[1],
          type: 'method',
          line: lineNum,
          signature: `${methodMatch[1]}(${methodMatch[2] || ''})`,
        });
      }
    } else if (lang === 'python' || lang === 'py') {
      const pyDef = line.match(/^(?:\s*)def\s+([A-Za-z0-9_]+)\s*\(([^)]*)\)/);
      if (pyDef) {
        symbols.push({
          name: pyDef[1],
          type: 'function',
          line: lineNum,
          signature: `def ${pyDef[1]}(${pyDef[2]})`,
        });
        continue;
      }
      const pyClass = line.match(/^(?:\s*)class\s+([A-Za-z0-9_]+)(?:\(([^)]*)\))?:/);
      if (pyClass) {
        symbols.push({
          name: pyClass[1],
          type: 'class',
          line: lineNum,
          signature: `class ${pyClass[1]}${pyClass[2] ? `(${pyClass[2]})` : ''}`,
        });
      }
    }
  }

  return symbols;
}

/**
 * Inspect workspace metadata (package.json, tech stack, test runner, config files).
 *
 * @param {string} workspaceRoot - Absolute path to workspace root.
 * @returns {Promise<object>} Project metadata summary.
 */
export async function getProjectMetadata(workspaceRoot) {
  const info = {
    workspaceRoot,
    hasPackageJson: false,
    projectName: '',
    projectType: 'unknown',
    scripts: {},
    dependencies: [],
    devDependencies: [],
    testCommand: '',
    configFiles: [],
  };

  try {
    const pkgPath = path.join(workspaceRoot, 'package.json');
    const pkgStat = await fs.stat(pkgPath).catch(() => null);
    if (pkgStat && pkgStat.isFile()) {
      info.hasPackageJson = true;
      const raw = await fs.readFile(pkgPath, 'utf-8');
      const pkg = JSON.parse(raw);
      info.projectName = pkg.name || '';
      info.projectType = pkg.type || 'commonjs';
      info.scripts = pkg.scripts || {};
      info.dependencies = Object.keys(pkg.dependencies || {});
      info.devDependencies = Object.keys(pkg.devDependencies || {});
      if (pkg.scripts?.test) {
        info.testCommand = 'npm test';
      }
    }
  } catch {
    // Ignore parse error
  }

  // Detect key configuration files
  const probeFiles = [
    'tsconfig.json',
    'eslint.config.js',
    'vite.config.js',
    'next.config.js',
    'webpack.config.js',
    'jest.config.js',
    'pyproject.toml',
    'requirements.txt',
    'Cargo.toml',
  ];

  for (const f of probeFiles) {
    try {
      const p = path.join(workspaceRoot, f);
      const st = await fs.stat(p).catch(() => null);
      if (st && st.isFile()) {
        info.configFiles.push(f);
      }
    } catch {
      // Ignore file access errors
    }
  }

  return info;
}
