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

  test('assetUrl returns empty string for empty path', async () => {
    const { assetUrl } = await loadApiModule();
    expect(assetUrl('')).toBe('');
    expect(assetUrl(null)).toBe('');
  });

  test('assetUrl proxies http/https paths and encodes key for local paths', async () => {
    const { assetUrl } = await loadApiModule();
    expect(assetUrl('http://example.com/pic.png')).toBe('/api/assets/proxy?url=http%3A%2F%2Fexample.com%2Fpic.png');
    expect(assetUrl('https://example.com/pic.png')).toBe('/api/assets/proxy?url=https%3A%2F%2Fexample.com%2Fpic.png');
    expect(assetUrl('folder/file.png')).toBe('/api/assets/proxy?key=folder%2Ffile.png');
  });

  test('extractImages extracts image URLs from various response shapes', async () => {
    const { extractImages } = await loadApiModule();

    expect(extractImages({
      aiRecord: { aiRecordDetail: { resultObject: 'url1' } }
    })).toEqual(['url1']);

    expect(extractImages({
      aiRecord: { output: ['url2'] }
    })).toEqual(['url2']);

    expect(extractImages({
      aiRecord: { resultObject: { images: ['url3'] } }
    })).toEqual(['url3']);

    expect(extractImages({
      aiRecord: { resultObject: { output: ['url4'] } }
    })).toEqual(['url4']);

    expect(extractImages({
      aiRecord: { resultObject: { urls: ['url5'] } }
    })).toEqual(['url5']);

    expect(extractImages({ resultObject: ['url6'] })).toEqual(['url6']);

    expect(extractImages({ result: 'url7' })).toEqual(['url7']);

    expect(extractImages({ images: ['url8'] })).toEqual(['url8']);

    expect(extractImages({
      images: [
        { url: 'url9' },
        { path: 'path10' },
        { key: 'key11' },
        { location: 'loc12' },
        { other: 'ignored' }
      ]
    })).toEqual(['url9', 'path10', 'key11', 'loc12']);

    expect(extractImages(null)).toEqual([]);
    expect(extractImages({})).toEqual([]);
  });

  test('handles missing or multiple CSRF cookies in document.cookie', async () => {
    global.fetch.mockImplementation(() => Promise.resolve(jsonResponse({ ok: true })));

    const { api: apiNoCookie } = await loadApiModule({ cookie: 'other_cookie=123' });
    await apiNoCookie('/api/test');
    expect(global.fetch).toHaveBeenCalledWith('/api/test', expect.objectContaining({
      headers: expect.not.objectContaining({ 'x-local-bff-token': expect.any(String) })
    }));

    const { api: apiMultiCookie } = await loadApiModule({ cookie: '__bff_csrf=csrf-token; __bff_csrf=other-token' });
    await apiMultiCookie('/api/test');
    expect(global.fetch).toHaveBeenCalledWith('/api/test', expect.objectContaining({
      headers: expect.not.objectContaining({ 'x-local-bff-token': expect.any(String) })
    }));
  });

  test('throws formatted error on server non-ok response with JSON error', async () => {
    global.fetch.mockResolvedValue(jsonResponse({ error: 'BFF Custom Error' }, { status: 400 }));
    const { api } = await loadApiModule({ cookie: '' });

    await expect(api('/api/bad')).rejects.toThrow('BFF Custom Error');
  });

  test('throws formatted error on server non-ok response with JSON message', async () => {
    global.fetch.mockResolvedValue(jsonResponse({ message: 'BFF Msg Error' }, { status: 400 }));
    const { api } = await loadApiModule({ cookie: '' });

    await expect(api('/api/bad')).rejects.toThrow('BFF Msg Error');
  });

  test('throws fallback HTTP status error on server non-ok response with plain text', async () => {
    global.fetch.mockResolvedValue(new Response('Internal Server Error Text', {
      status: 500,
      headers: { 'content-type': 'text/plain' }
    }));
    const { api } = await loadApiModule({ cookie: '' });

    await expect(api('/api/bad')).rejects.toThrow('Internal Server Error Text');
  });

  test('returns message string if server returns non-JSON text starting with other than { or [', async () => {
    global.fetch.mockResolvedValue(new Response('Plain text response', {
      status: 200,
      headers: { 'content-type': 'text/plain' }
    }));
    const { api } = await loadApiModule({ cookie: '' });

    await expect(api('/api/text')).resolves.toEqual({ message: 'Plain text response' });
  });

  test('returns message string if server returns invalid JSON text starting with {', async () => {
    global.fetch.mockResolvedValue(new Response('{invalid-json', {
      status: 200,
      headers: { 'content-type': 'application/json' }
    }));
    const { api } = await loadApiModule({ cookie: '' });

    await expect(api('/api/bad-json')).resolves.toEqual({ message: '{invalid-json' });
  });

  test('returns empty object if server returns empty response body', async () => {
    global.fetch.mockResolvedValue(new Response('', {
      status: 200,
      headers: { 'content-type': 'application/json' }
    }));
    const { api } = await loadApiModule({ cookie: '' });

    await expect(api('/api/empty')).resolves.toEqual({});
  });
});

