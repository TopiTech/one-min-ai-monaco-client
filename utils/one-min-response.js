const PRIMARY_TEXT_CANDIDATES = [
  (data) => data?.aiRecord?.aiRecordDetail?.resultObject,
  (data) => data?.aiRecord?.aiRecordDetail?.result,
  (data) => data?.aiRecord?.resultObject,
  (data) => data?.aiRecord?.output,
  (data) => data?.aiRecord?.result,
  (data) => data?.aiRecordDetail?.resultObject,
  (data) => data?.aiRecordDetail?.result,
  (data) => data?.resultObject,
];

const DIRECT_TEXT_CANDIDATES = [
  (data) => (typeof data === 'string' ? data : undefined),
  (data) => data?.content,
  (data) => data?.text,
  (data) => data?.delta?.content,
  (data) => data?.choices?.[0]?.delta?.content,
  (data) => data?.choices?.[0]?.message?.content,
  (data) => data?.message?.content,
  (data) => data?.result,
  (data) => data?.answer,
  (data) => data?.output,
  (data) => data?.completion,
  (data) => data?.response,
  (data) => data?.message,
];

const STRUCTURED_TEXT_CANDIDATES = [
  (data) => data?.aiRecord?.aiRecordDetail?.resultObject,
  (data) => data?.aiRecord?.output,
  (data) => data?.aiRecord?.resultObject,
  (data) => data?.resultObject,
];

function isEmptyPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0;
}

function isSearchMetadataObject(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  const t = String(obj.type || '').toLowerCase();
  if (
    t === 'web_search' ||
    t === 'search_results' ||
    t === 'grounding' ||
    t === 'crawling' ||
    t === 'crawl' ||
    t === 'browse'
  ) {
    return true;
  }
  if (
    'searchResults' in obj ||
    'search_results' in obj ||
    'groundingMetadata' in obj ||
    'webSearchObject' in obj ||
    'crawling' in obj ||
    'crawlResults' in obj
  ) {
    return true;
  }
  if ('sources' in obj && Array.isArray(obj.sources) && !('thought' in obj) && !('content' in obj))
    return true;
  if ('citations' in obj && Array.isArray(obj.citations) && !('thought' in obj) && !('content' in obj))
    return true;
  return false;
}

function isCrawlStatusString(str) {
  if (typeof str !== 'string') return false;
  return /^(?:⚙\s*|[•\-*]\s*)?(?:Crawling(?:\s+site)?|Crawled(?:\s+site)?|Browsing(?:\s+page|\s+site)?|Searching(?:\s+the\s+web|\s+for)?|Navigating\s+to|Fetching(?:\s+URL)?)[^\n]*$/i.test(
    str.trim(),
  );
}

function normalizeTextValue(value, seen = new WeakSet(), { stringifyObjects = false } = {}) {
  if (value === undefined) return undefined;
  if (value === null) return 'null';
  if (typeof value === 'string') {
    return value || undefined;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (Array.isArray(value)) {
    const nonSearch = value.filter((item) => !isSearchMetadataObject(item) && !isCrawlStatusString(item));
    const target = nonSearch.length > 0 ? nonSearch : value;
    const parts = target.map((item) => normalizeTextValue(item, seen, { stringifyObjects })).filter(Boolean);
    return parts.length > 0 ? parts.join('\n') : undefined;
  }
  if (typeof value === 'object') {
    if (isEmptyPlainObject(value)) return undefined;
    if (seen.has(value)) return undefined;
    seen.add(value);
    const nested = findTextCandidate(value, seen);
    if (nested) return nested;
    if (!stringifyObjects) return undefined;
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function findTextCandidate(data, seen = new WeakSet()) {
  for (const getter of PRIMARY_TEXT_CANDIDATES) {
    const text = normalizeTextValue(getter(data), seen, { stringifyObjects: true });
    if (text) return text;
  }

  for (const getter of DIRECT_TEXT_CANDIDATES) {
    const text = normalizeTextValue(getter(data), seen);
    if (text) return text;
  }

  for (const getter of STRUCTURED_TEXT_CANDIDATES) {
    const text = normalizeTextValue(getter(data), seen);
    if (text) return text;
  }

  return undefined;
}

export function extractTextFromOneMinResponse(data) {
  const candidate = findTextCandidate(data);
  if (candidate !== undefined) return candidate;
  return JSON.stringify(data, null, 2);
}
