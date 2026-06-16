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
    return false; // Empty files are handled separately but signature-wise invalid
  }

  const mime = String(declaredMimeType).toLowerCase();

  // Text types: Validate the buffer decodes as UTF-8 (or 7-bit ASCII)
  // and contains no null bytes. This prevents uploading polyglot binaries
  // (e.g. PDF/PE) disguised as text.
  if (
    mime.startsWith("text/") ||
    mime === "application/json" ||
    mime === "application/xml" ||
    mime === "application/javascript"
  ) {
    if (buffer.includes(0x00)) return false;
    try {
      const decoded = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
      // Reject control characters that are not whitespace (\t \n \r \f \v).
      // eslint-disable-next-line no-control-regex
      if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(decoded)) return false;
      return true;
    } catch {
      return false;
    }
  }

  const hex = buffer.toString("hex", 0, 8).toUpperCase();

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (mime === "image/png") {
    return hex.startsWith("89504E470D0A1A0A");
  }

  // JPEG / JPG: FF D8 FF
  if (mime === "image/jpeg" || mime === "image/jpg") {
    return hex.startsWith("FFD8FF");
  }

  // GIF: GIF87a (47 49 46 38 37 61) or GIF89a (47 49 46 38 39 61)
  if (mime === "image/gif") {
    return hex.startsWith("474946383761") || hex.startsWith("474946383961");
  }

  // WEBP: RIFF (52 49 46 46) ... WEBP (57 45 42 50) at offset 8
  if (mime === "image/webp") {
    return hex.startsWith("52494646") && buffer.toString("utf8", 8, 12) === "WEBP";
  }

  // ICO: 00 00 01 00
  if (mime === "image/x-icon" || mime === "image/vnd.microsoft.icon") {
    return hex.startsWith("00000100");
  }

  // PDF: %PDF (25 50 44 46)
  if (mime === "application/pdf") {
    return hex.startsWith("25504446");
  }

  // ZIP: PK\x03\x04 (50 4B 03 04)
  if (mime === "application/zip" || mime === "application/x-zip-compressed") {
    return hex.startsWith("504B0304");
  }

  // MP4: offset 4 ftyp (66 74 79 70)
  if (mime === "video/mp4") {
    if (buffer.length < 8) return false;
    return buffer.toString("hex", 4, 8).toUpperCase() === "66747970";
  }

  // MP3: ID3 (49 44 33) or MPEG frame sync (FF FB / FF F3)
  if (mime === "audio/mpeg" || mime === "audio/mp3") {
    return hex.startsWith("494433") || hex.startsWith("FFF");
  }

  // WAV: RIFF (52 49 46 46) ... WAVE (57 41 56 45) at offset 8
  if (mime === "audio/wav" || mime === "audio/x-wav") {
    return hex.startsWith("52494646") && buffer.toString("utf8", 8, 12) === "WAVE";
  }

  // Fallback for other allowed mime prefixes (video/, audio/, image/, etc.)
  // If we don't have a specific magic byte check, at least prevent null byte injection
  // for text-like formats, and allow others but flag if they contain common executable headers.
  if (mime.startsWith("image/") || mime.startsWith("video/") || mime.startsWith("audio/")) {
    // Check if it is a PE binary (MZ header: 4D 5A)
    const isPE = hex.startsWith("4D5A");
    // ELF header (7F 45 4C 46)
    const isELF = hex.startsWith("7F454C46");
    return !isPE && !isELF;
  }

  return true;
}
