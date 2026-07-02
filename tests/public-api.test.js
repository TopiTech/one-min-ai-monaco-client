import { jest } from '@jest/globals';

function createStatusElement() {
  return {
    textContent: '',
    className: '',
  };
}

async function loadApiModule({ cookie = '__bff_csrf=csrf-token' } = {}) {
  jest.resetModules();
  const statusEl = createStatusElement();

  global.document = {
    cookie,
    getElementById: jest.fn((id) => (id === 'status' ? statusEl : null)),
  };
  global.window = {};

  const module = await import('../public/js/api.js');
  return { ...module, statusEl };
}

function jsonResponse(data, init = {}) {
  return new Response(JSON.stringify(data), {
    status: init.status || 200,
    headers: { 'content-type': 'application/json', ...(init.headers || {}) },
  });
}

describe('public api wrapper', () => {
  beforeEach(() => {
    jest.useRealTimers();
    global.fetch = jest.fn();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    delete global.fetch;
    delete global.document;
    delete global.window;
  });

  test('adds the local BFF CSRF header and updates status on success', async () => {
    global.fetch.mockResolvedValue(jsonResponse({ ok: true }));
    const { api, statusEl } = await loadApiModule();

    await expect(api('/api/health')).resolves.toEqual({ ok: true });

    expect(global.fetch).toHaveBeenCalledWith(
      '/api/health',
      expect.objectContaining({
        headers: expect.objectContaining({ 'x-local-bff-token': 'csrf-token' }),
        signal: expect.any(AbortSignal),
      }),
    );
    expect(statusEl.textContent).toBe('status_done');
    expect(statusEl.className).toBe('status ok');
  });

  test('does not pass api-only options such as raw or timeout to fetch', async () => {
    const response = jsonResponse({ ok: true });
    global.fetch.mockResolvedValue(response);
    const { api } = await loadApiModule({ cookie: '' });

    const result = await api('/api/stream', { raw: true, timeout: 1234, method: 'GET' });

    expect(result).toBe(response);
    const fetchOptions = global.fetch.mock.calls[0][1];
    expect(fetchOptions).toMatchObject({ method: 'GET' });
    expect(fetchOptions.raw).toBeUndefined();
    expect(fetchOptions.timeout).toBeUndefined();
  });

  test('keeps caller cancellation connected for returned raw streaming responses', async () => {
    let fetchSignal;
    const response = jsonResponse({ ok: true });
    global.fetch.mockImplementation((_path, options) => {
      fetchSignal = options.signal;
      return Promise.resolve(response);
    });
    const { api } = await loadApiModule({ cookie: '' });
    const controller = new AbortController();

    await expect(api('/api/stream', { raw: true, signal: controller.signal })).resolves.toBe(response);
    controller.abort('user cancelled');

    expect(fetchSignal.aborted).toBe(true);
  });

  test('rejects with a classified TimeoutError when fetch exceeds timeout', async () => {
    jest.useFakeTimers();
    global.fetch.mockImplementation(
      (_path, { signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
    );
    const { api, statusEl } = await loadApiModule({ cookie: '' });

    const promise = api('/api/slow', { timeout: 25 });
    const expectation = expect(promise).rejects.toMatchObject({
      name: 'TimeoutError',
      status: 408,
      code: 'REQUEST_TIMEOUT',
    });
    await jest.advanceTimersByTimeAsync(25);

    await expectation;
    expect(statusEl.textContent).toBe('status_error');
    expect(statusEl.className).toBe('status err');
  });

  test('preserves caller AbortError cancellation semantics', async () => {
    global.fetch.mockImplementation(
      (_path, { signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            const err = new Error('cancelled');
            err.name = 'AbortError';
            reject(err);
          });
        }),
    );
    const { api } = await loadApiModule({ cookie: '' });
    const controller = new AbortController();

    const promise = api('/api/cancel', { signal: controller.signal, timeout: 1000 });
    const expectation = expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();

    await expectation;
  });
});
