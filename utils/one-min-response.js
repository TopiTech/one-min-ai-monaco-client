const DIRECT_TEXT_CANDIDATES = [
  (data) => (typeof data === 'string' ? data : undefined),
  (data) => data?.content,
  (data) => data?.text,
  (data) => data?.delta?.content,
  (data) => data?.choices?.[0]?.delta?.content,
  (data) => data?.choices?.[0]?.message?.content,
  (data) => data?.message?.content,
  (data) => data?.aiRecord?.aiRecordDetail?.result,
  (data) => data?.aiRecord?.result,
  (data) => data?.result,
  (data) => data?.message,
];

const STRUCTURED_TEXT_CANDIDATES = [
  (data) => data?.aiRecord?.aiRecordDetail?.resultObject,
  (data) => data?.aiRecord?.output,
  (data) => data?.aiRecord?.resultObject,
  (data) => data?.resultObject,
];

function normalizeTextValue(value, seen = new WeakSet()) {
  if (value === undefined) return undefined;
  if (value === null) return 'null';
  if (typeof value === 'string') {
    return value || undefined;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (Array.isArray(value)) {
    const parts = value.map((item) => normalizeTextValue(item, seen)).filter(Boolean);
    return parts.length > 0 ? parts.join('\n') : undefined;
  }
  if (typeof value === 'object') {
    if (seen.has(value)) return undefined;
    seen.add(value);
    const nested = findTextCandidate(value, seen);
    if (nested) return nested;
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function findTextCandidate(data, seen = new WeakSet()) {
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
