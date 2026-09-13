import vm from 'node:vm';
import fs from 'node:fs/promises';
import path from 'node:path';

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

  // JavaScript Validation (ES module or script parsing via vm.Script)
  if (['javascript', 'js', 'mjs', 'cjs', 'node'].includes(lang)) {
    try {
      // Check as ES Module syntax if it has import/export statements
      const hasEsModule = /^\s*(import|export)\b/m.test(code);
      if (hasEsModule) {
        // Wrap in dynamic import or module constructor check
        // vm.Script accepts ES6 if wrapped inside an async function or module context
        new vm.Script(`(async () => {\n${code.replace(/^\s*import\b.*$/gm, '// $&').replace(/^\s*export\b\s*(?:default\s*)?/gm, '')}\n})()`, {
          filename: 'syntax_check.js',
        });
      } else {
        new vm.Script(code, { filename: 'syntax_check.js' });
      }
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
 * Check balanced pairs of braces, brackets, and parentheses.
 */
function checkBracketsBalance(code) {
  const stack = [];
  const pairs = { '}': '{', ']': '[', ')': '(' };
  let inString = false;
  let quote = '';
  let escape = false;

  const lines = code.split(/\r?\n/);
  for (let l = 0; l < lines.length; l++) {
    const line = lines[l];
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === '\\') {
        escape = true;
        continue;
      }
      if (inString) {
        if (ch === quote) inString = false;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') {
        inString = true;
        quote = ch;
        continue;
      }
      if (ch === '/' && line[i + 1] === '/') {
        break; // skip rest of single-line comment
      }

      if (ch === '{' || ch === '[' || ch === '(') {
        stack.push({ ch, line: l + 1, col: i + 1 });
      } else if (ch === '}' || ch === ']' || ch === ')') {
        const expected = pairs[ch];
        const last = stack.pop();
        if (!last || last.ch !== expected) {
          return `Unmatched closing '${ch}' at line ${l + 1}, column ${i + 1}`;
        }
      }
    }
  }

  if (stack.length > 0) {
    const unclosed = stack.pop();
    return `Unclosed '${unclosed.ch}' opened at line ${unclosed.line}, column ${unclosed.col}`;
  }

  return null;
}

/**
 * Extract outline symbols (functions, classes, exports, interfaces) from code.
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

  for (let i = 0; i < lines.length; i++) {
    const lineNum = i + 1;
    const line = lines[i];
    const trimmed = line.trim();

    // Skip empty or pure comment lines
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('#') || trimmed.startsWith('/*')) {
      continue;
    }

    if (['javascript', 'js', 'typescript', 'ts', 'jsx', 'tsx'].includes(lang)) {
      // 1. Function declarations: function foo(...)
      const fnMatch = line.match(/(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s*([A-Za-z0-9_$]+)?\s*\(([^)]*)\)/);
      if (fnMatch) {
        symbols.push({
          name: fnMatch[1] || '(anonymous function)',
          type: 'function',
          line: lineNum,
          signature: `function ${fnMatch[1] || ''}(${fnMatch[2] || ''})`,
        });
        continue;
      }

      // 2. Class declarations: class Foo ...
      const classMatch = line.match(/(?:export\s+(?:default\s+)?)?class\s+([A-Za-z0-9_$]+)(?:\s+extends\s+([A-Za-z0-9_$]+))?/);
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
        /(?:export\s+)?(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*(?:async\s*)?(?:\(([^)]*)\)|[A-Za-z0-9_$]+)\s*=>/,
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
