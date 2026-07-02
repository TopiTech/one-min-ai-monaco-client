/**
 * Validates file buffers using magic numbers (file signatures)
 * to prevent MIME type spoofing.
 */

/**
 * Validates that the buffer matches the expected file signature.
 * @param {Buffer} buffer The file buffer in memory.
 * @param {string} declaredMimeType The MIME type declared by the client.
 * @returns {boolean} True if the buffer matches the signature, false otherwise.
 */
export function validateBufferMimeType(buffer, declaredMimeType) {
  if (!buffer || !Buffer.isBuffer(buffer)) {
    return false;
  }

  if (buffer.length === 0) {
    // Empty buffers are signature-valid for any declared type (no bytes to contradict it).
    // Empty files are a legitimate use case (e.g. creating a new empty source file).
    return Boolean(declaredMimeType);
  }

  const hex = buffer.toString('hex', 0, 8).toUpperCase();

  // S-4 Fix: Regardless of the declared MIME type, block dangerous binary executable signatures
  // (MZ for PE/COFF, ELF) to prevent executing malicious binaries disguised as allowed formats.
  const isPE = hex.startsWith('4D5A'); // MZ header (Windows executable)
  const isELF = hex.startsWith('7F454C46'); // ELF header (Linux executable)
  if (isPE || isELF) {
    return false;
  }

  const mime = String(declaredMimeType).toLowerCase();

  // Text types: Validate the buffer decodes as UTF-8 (or 7-bit ASCII)
  // and contains no null bytes. This prevents uploading polyglot binaries
  // (e.g. PDF/PE) disguised as text.
  if (
    mime.startsWith('text/') ||
    mime === 'application/json' ||
    mime === 'application/xml' ||
    mime === 'application/javascript'
  ) {
    if (buffer.includes(0x00)) return false;
    try {
      const decoded = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
      // Reject control characters that are not whitespace (\t \n \r \f \v).
      // eslint-disable-next-line no-control-regex
      if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(decoded)) return false;
      return true;
    } catch {
      return false;
    }
  }

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (mime === 'image/png') {
    return hex.startsWith('89504E470D0A1A0A');
  }

  // JPEG / JPG: FF D8 FF
  if (mime === 'image/jpeg' || mime === 'image/jpg') {
    return hex.startsWith('FFD8FF');
  }

  // GIF: GIF87a (47 49 46 38 37 61) or GIF89a (47 49 46 38 39 61)
  if (mime === 'image/gif') {
    return hex.startsWith('474946383761') || hex.startsWith('474946383961');
  }

  // WEBP: RIFF (52 49 46 46) ... WEBP (57 45 42 50) at offset 8
  if (mime === 'image/webp') {
    return hex.startsWith('52494646') && buffer.toString('utf8', 8, 12) === 'WEBP';
  }

  // ICO: 00 00 01 00
  if (mime === 'image/x-icon' || mime === 'image/vnd.microsoft.icon') {
    return hex.startsWith('00000100');
  }

  // PDF: %PDF (25 50 44 46)
  if (mime === 'application/pdf') {
    return hex.startsWith('25504446');
  }

  // ZIP: PK\x03\x04 (50 4B 03 04)
  if (mime === 'application/zip' || mime === 'application/x-zip-compressed') {
    return hex.startsWith('504B0304');
  }

  // MP4: offset 4 ftyp (66 74 79 70)
  if (mime === 'video/mp4') {
    if (buffer.length < 8) return false;
    return buffer.toString('hex', 4, 8).toUpperCase() === '66747970';
  }

  // MP3: ID3 (49 44 33) or MPEG frame sync (FF FB / FF F3)
  if (mime === 'audio/mpeg' || mime === 'audio/mp3') {
    return hex.startsWith('494433') || hex.startsWith('FFF');
  }

  // WAV: RIFF (52 49 46 46) ... WAVE (57 41 56 45) at offset 8
  if (mime === 'audio/wav' || mime === 'audio/x-wav') {
    return hex.startsWith('52494646') && buffer.toString('utf8', 8, 12) === 'WAVE';
  }

  // Fallback for other allowed mime prefixes (video/, audio/, image/, etc.)
  // If we don't have a specific magic byte check, at least prevent null byte injection
  // for text-like formats, and allow others but flag if they contain common executable headers.
  if (mime.startsWith('image/') || mime.startsWith('video/') || mime.startsWith('audio/')) {
    // Check if it is a PE binary (MZ header: 4D 5A)
    const isPE = hex.startsWith('4D5A');
    // ELF header (7F 45 4C 46)
    const isELF = hex.startsWith('7F454C46');
    return !isPE && !isELF;
  }

  return true;
}

/**
 * Heuristic content-based binary detection for `/api/fs/read`. Unlike the
 * extension-based BINARY_EXTENSIONS list, this catches files renamed to a
 * text-like extension (.txt, .md, .json) but containing actual binary data.
 * Returns true if the buffer is likely binary and should not be served to the
 * text editor.
 */
export function detectBinaryContent(buffer) {
  if (!buffer || buffer.length === 0) return false;

  const headHex = buffer.toString('hex', 0, Math.min(buffer.length, 16)).toUpperCase();
  const headAscii = buffer.toString('latin1', 0, Math.min(buffer.length, 16));

  const hasKnownBinarySignature =
    headHex.startsWith('89504E470D0A1A0A') || // PNG
    headHex.startsWith('FFD8FF') || // JPEG
    headHex.startsWith('474946383761') || // GIF87a
    headHex.startsWith('474946383961') || // GIF89a
    (headHex.startsWith('52494646') && buffer.toString('latin1', 8, 12) === 'WEBP') || // WEBP
    headHex.startsWith('00000100') || // ICO
    headHex.startsWith('25504446') || // PDF
    headHex.startsWith('504B0304') || // ZIP/docx/xlsx/jar
    (buffer.length >= 8 && buffer.toString('latin1', 4, 8) === 'ftyp') || // MP4/MOV family
    headHex.startsWith('494433') || // MP3 ID3
    headHex.startsWith('FFFB') ||
    headHex.startsWith('FFF3') || // MP3 frame sync variants
    (headHex.startsWith('52494646') && buffer.toString('latin1', 8, 12) === 'WAVE') || // WAV
    headHex.startsWith('4D5A') || // PE executable
    headHex.startsWith('7F454C46') || // ELF executable
    headAscii.startsWith('%PDF-');

  if (hasKnownBinarySignature) return true;

  // Fallback heuristic: presence of NUL byte in the first 8KB is a strong
  // indicator of binary content (text files virtually never contain NUL).
  const probe = buffer.subarray(0, Math.min(buffer.length, 8192));
  return probe.includes(0x00);
}

const MIME_TO_EXTENSION = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/x-icon': '.ico',
  'image/vnd.microsoft.icon': '.ico',
  'application/pdf': '.pdf',
  'application/zip': '.zip',
  'application/x-zip-compressed': '.zip',
  'video/mp4': '.mp4',
  'audio/mpeg': '.mp3',
  'audio/mp3': '.mp3',
  'audio/wav': '.wav',
  'audio/x-wav': '.wav',
  'application/json': '.json',
  'application/xml': '.xml',
  'text/html': '.html',
  'text/plain': '.txt',
  'text/css': '.css',
  'text/javascript': '.js',
  'application/javascript': '.js',
  'text/markdown': '.md',
};

/**
 * Maps standard MIME types to their typical file extensions.
 * @param {string} declaredMimeType
 * @returns {string} The matching extension starting with a dot, or '.bin' fallback.
 */
export function getExtensionFromMimeType(declaredMimeType) {
  if (!declaredMimeType) return '.bin';
  const mime = String(declaredMimeType).toLowerCase();
  if (MIME_TO_EXTENSION[mime]) {
    return MIME_TO_EXTENSION[mime];
  }
  if (mime.startsWith('text/')) {
    const sub = mime.substring(5);
    if (/^[a-z0-9-]+$/.test(sub)) {
      return sub === 'plain' ? '.txt' : `.${sub}`;
    }
  }
  return '.bin';
}
