import { jest } from '@jest/globals';
import fs from 'fs/promises';

/**
 * Regression tests for i18n usage in the agent timeline.
 *
 * Bug: agent-timeline.js hardcoded the Japanese strings "切詰" and
 * "... [出力が N 文字を超過したため切り詰められました]" even though the
 * i18n catalogue already provided output_truncated / output_exceeded.
 * English users saw Japanese text, and the catalogue keys were dead.
 */

const TIMELINE_URL = new URL('../public/js/agent-timeline.js', import.meta.url);

async function loadTimelineModule() {
  jest.resetModules();

  const elements = [];
  const makeEl = () => {
    const el = {
      children: [],
      className: '',
      id: '',
      type: '',
      textContent: '',
      removed: false,
      appendChild(child) {
        this.children.push(child);
        return child;
      },
      querySelector: () => null,
      setAttribute: jest.fn(),
      getAttribute: () => null,
      addEventListener: jest.fn(),
      classList: {
        add: jest.fn(),
        toggle: jest.fn(),
        contains: () => false,
      },
      remove() {
        this.removed = true;
      },
      focus: jest.fn(),
    };
    elements.push(el);
    return el;
  };

  global.document = {
    readyState: 'complete',
    createElement: makeEl,
    createTextNode: (text) => ({ text }),
    createElementNS: makeEl,
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: jest.fn(),
    documentElement: { lang: '' },
  };

  global.window = {
    dispatchEvent: jest.fn(),
  };

  global.localStorage = {
    getItem: () => null,
    setItem: jest.fn(),
  };

  // Minimal translation catalogue mirroring public/i18n/*.json
  const catalogue = {
    show_output: '▶ Show execution output',
    hide_output: '▼ Hide execution output',
    thought_expand: '▶ Expand thought process',
    thought_collapse: '▼ Collapse thought process',
    output_truncated: 'Truncated',
    output_exceeded: '... [Output exceeded by {count} characters and was truncated]',
    cmd_approval: 'Command Execution',
    cmd_approval_label: 'Command execution approval',
    cmd_approval_desc: 'The agent is about to execute the following command.',
    cmd_label: 'Command: ',
    cmd_dir_label: 'Execution directory: ',
    cmd_reject_reason: 'Enter reason if rejecting...',
    btn_approve: 'Approve',
    btn_reject: 'Reject',
    btn_approved: 'Approved',
    btn_rejected: 'Rejected',
    default_reject_reason: 'Rejected by user',
  };

  global.fetch = jest.fn(() =>
    Promise.resolve({ ok: true, json: () => Promise.resolve(catalogue) }),
  );

  const timeline = await import('../public/js/agent-timeline.js');
  const i18n = await import('../public/js/i18n.js');
  await i18n.initI18n();

  return { timeline, catalogue };
}

afterEach(() => {
  jest.restoreAllMocks();
  delete global.document;
  delete global.window;
  delete global.localStorage;
  delete global.fetch;
});

describe('agent-timeline i18n (truncation UI)', () => {
  test('i18n catalogue defines output_truncated and output_exceeded for both languages', async () => {
    const [en, ja] = await Promise.all([
      fs.readFile(new URL('../public/i18n/en.json', import.meta.url), 'utf-8'),
      fs.readFile(new URL('../public/i18n/ja.json', import.meta.url), 'utf-8'),
    ]);
    const enKeys = JSON.parse(en);
    const jaKeys = JSON.parse(ja);

    expect(typeof enKeys.output_truncated).toBe('string');
    expect(typeof enKeys.output_exceeded).toBe('string');
    expect(typeof jaKeys.output_truncated).toBe('string');
    expect(typeof jaKeys.output_exceeded).toBe('string');
    // {count} placeholder must exist in both catalogues
    expect(enKeys.output_exceeded).toContain('{count}');
    expect(jaKeys.output_exceeded).toContain('{count}');
  });

  test('truncated result badge and message come from i18n, not hardcoded Japanese', async () => {
    const { timeline } = await loadTimelineModule();
    const dom = { agentActivityLog: global.document.createElement('div') };
    dom.agentActivityLog.scrollTop = 0;
    dom.agentActivityLog.scrollHeight = 0;
    const { addStep } = timeline.createAgentTimeline(dom);

    const longResult = 'x'.repeat(10001);
    addStep('result', 'Result', 'body', longResult);

    // The badge span must show the translated "Truncated" text
    const allElements = [];
    const walk = (el) => {
      allElements.push(el);
      (el.children || []).forEach(walk);
    };
    walk(dom.agentActivityLog);

    const badge = allElements.find(
      (el) => el.className === 'result-truncated-badge',
    );
    expect(badge).toBeDefined();
    expect(badge.textContent).toBe('Truncated');

    const pre = allElements.find((el) => typeof el.id === 'string' && el.id.startsWith('result-step-'));
    expect(pre).toBeDefined();
    expect(pre.textContent).toContain('Output exceeded by');
    expect(pre.textContent).not.toMatch(/出力が/);
  });

  test('source no longer contains the hardcoded truncation strings', async () => {
    const src = await fs.readFile(TIMELINE_URL, 'utf-8');
    expect(src).not.toContain('切詰');
    expect(src).not.toContain('切り詰められました');
    expect(src).toMatch(/t\('output_truncated'\)/);
    expect(src).toMatch(/t\('output_exceeded'/);
  });
});
