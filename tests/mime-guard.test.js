import {
  validateBufferMimeType,
  detectBinaryContent,
  getExtensionFromMimeType,
} from '../utils/mime-guard.js';

describe('mime-guard utility', () => {
  describe('validateBufferMimeType', () => {
    test('returns false for invalid or non-buffer inputs', () => {
      expect(validateBufferMimeType(null, 'text/plain')).toBe(false);
      expect(validateBufferMimeType('not a buffer', 'text/plain')).toBe(false);
    });

    test('returns true for empty buffer if declaredMimeType is present, false if not', () => {
      const emptyBuf = Buffer.alloc(0);
      expect(validateBufferMimeType(emptyBuf, 'text/plain')).toBe(true);
      expect(validateBufferMimeType(emptyBuf, '')).toBe(false);
    });

    test('blocks executable files (MZ / ELF headers) regardless of declared mime type', () => {
      const mzBuf = Buffer.from('MZ\x00\x00\x00\x00\x00\x00'); // '4D5A'
      expect(validateBufferMimeType(mzBuf, 'text/plain')).toBe(false);
      expect(validateBufferMimeType(mzBuf, 'image/png')).toBe(false);

      const elfBuf = Buffer.from('\x7FELF\x00\x00\x00\x00'); // '7F454C46'
      expect(validateBufferMimeType(elfBuf, 'text/plain')).toBe(false);
      expect(validateBufferMimeType(elfBuf, 'image/png')).toBe(false);
    });

    test('validates text-like mime types (UTF-8, no control characters)', () => {
      const validText = Buffer.from('Hello world\nThis is text\t.', 'utf-8');
      expect(validateBufferMimeType(validText, 'text/plain')).toBe(true);
      expect(validateBufferMimeType(validText, 'application/json')).toBe(true);
      expect(validateBufferMimeType(validText, 'application/xml')).toBe(true);
      expect(validateBufferMimeType(validText, 'application/javascript')).toBe(true);

      const hasNull = Buffer.from('Hello\x00world', 'utf-8');
      expect(validateBufferMimeType(hasNull, 'text/plain')).toBe(false);

      const hasControl = Buffer.from('Hello\x07world', 'utf-8'); // \x07 is control char
      expect(validateBufferMimeType(hasControl, 'text/plain')).toBe(false);

      const invalidUtf8 = Buffer.from([0x68, 0x69, 0xc3, 0x28]);
      expect(validateBufferMimeType(invalidUtf8, 'text/plain')).toBe(false);
    });

    test('validates image/png signature', () => {
      const validPng = Buffer.from('89504E470D0A1A0A', 'hex');
      expect(validateBufferMimeType(validPng, 'image/png')).toBe(true);

      const invalidPng = Buffer.from('89504E4700000000', 'hex');
      expect(validateBufferMimeType(invalidPng, 'image/png')).toBe(false);
    });

    test('validates image/jpeg and image/jpg signature', () => {
      const validJpg = Buffer.from('FFD8FF0000000000', 'hex');
      expect(validateBufferMimeType(validJpg, 'image/jpeg')).toBe(true);
      expect(validateBufferMimeType(validJpg, 'image/jpg')).toBe(true);

      const invalidJpg = Buffer.from('FFD8000000000000', 'hex');
      expect(validateBufferMimeType(invalidJpg, 'image/jpeg')).toBe(false);
    });

    test('validates image/gif signature', () => {
      const validGif87 = Buffer.from('4749463837610000', 'hex');
      const validGif89 = Buffer.from('4749463839610000', 'hex');
      expect(validateBufferMimeType(validGif87, 'image/gif')).toBe(true);
      expect(validateBufferMimeType(validGif89, 'image/gif')).toBe(true);

      const invalidGif = Buffer.from('4749463838610000', 'hex');
      expect(validateBufferMimeType(invalidGif, 'image/gif')).toBe(false);
    });

    test('validates image/webp signature', () => {
      const validWebp = Buffer.alloc(12);
      validWebp.write('RIFF', 0, 4, 'ascii');
      validWebp.write('WEBP', 8, 4, 'ascii');
      expect(validateBufferMimeType(validWebp, 'image/webp')).toBe(true);

      const invalidWebp1 = Buffer.alloc(12);
      invalidWebp1.write('RIFX', 0, 4, 'ascii');
      invalidWebp1.write('WEBP', 8, 4, 'ascii');
      expect(validateBufferMimeType(invalidWebp1, 'image/webp')).toBe(false);

      const invalidWebp2 = Buffer.alloc(12);
      invalidWebp2.write('RIFF', 0, 4, 'ascii');
      invalidWebp2.write('WEBC', 8, 4, 'ascii');
      expect(validateBufferMimeType(invalidWebp2, 'image/webp')).toBe(false);
    });

    test('validates image/x-icon and image/vnd.microsoft.icon signature', () => {
      const validIco = Buffer.from('0000010000000000', 'hex');
      expect(validateBufferMimeType(validIco, 'image/x-icon')).toBe(true);
      expect(validateBufferMimeType(validIco, 'image/vnd.microsoft.icon')).toBe(true);

      const invalidIco = Buffer.from('0000020000000000', 'hex');
      expect(validateBufferMimeType(invalidIco, 'image/x-icon')).toBe(false);
    });

    test('validates application/pdf signature', () => {
      const validPdf = Buffer.from('2550444600000000', 'hex');
      expect(validateBufferMimeType(validPdf, 'application/pdf')).toBe(true);

      const invalidPdf = Buffer.from('2550000000000000', 'hex');
      expect(validateBufferMimeType(invalidPdf, 'application/pdf')).toBe(false);
    });

    test('validates application/zip and application/x-zip-compressed signature', () => {
      const validZip = Buffer.from('504B030400000000', 'hex');
      expect(validateBufferMimeType(validZip, 'application/zip')).toBe(true);
      expect(validateBufferMimeType(validZip, 'application/x-zip-compressed')).toBe(true);

      const invalidZip = Buffer.from('504B030500000000', 'hex');
      expect(validateBufferMimeType(invalidZip, 'application/zip')).toBe(false);
    });

    test('validates video/mp4 signature', () => {
      const shortBuf = Buffer.from('123456', 'hex');
      expect(validateBufferMimeType(shortBuf, 'video/mp4')).toBe(false);

      const validMp4 = Buffer.alloc(8);
      validMp4.write('ftyp', 4, 4, 'ascii');
      expect(validateBufferMimeType(validMp4, 'video/mp4')).toBe(true);

      const invalidMp4 = Buffer.alloc(8);
      invalidMp4.write('ftyx', 4, 4, 'ascii');
      expect(validateBufferMimeType(invalidMp4, 'video/mp4')).toBe(false);
    });

    test('validates audio/mpeg and audio/mp3 signature', () => {
      const id3Mp3 = Buffer.from('4944330000000000', 'hex');
      expect(validateBufferMimeType(id3Mp3, 'audio/mpeg')).toBe(true);
      expect(validateBufferMimeType(id3Mp3, 'audio/mp3')).toBe(true);

      const syncMp3 = Buffer.from('FFF0000000000000', 'hex');
      expect(validateBufferMimeType(syncMp3, 'audio/mpeg')).toBe(true);

      const invalidMp3 = Buffer.from('0000000000000000', 'hex');
      expect(validateBufferMimeType(invalidMp3, 'audio/mpeg')).toBe(false);
    });

    test('validates audio/wav and audio/x-wav signature', () => {
      const validWav = Buffer.alloc(12);
      validWav.write('RIFF', 0, 4, 'ascii');
      validWav.write('WAVE', 8, 4, 'ascii');
      expect(validateBufferMimeType(validWav, 'audio/wav')).toBe(true);
      expect(validateBufferMimeType(validWav, 'audio/x-wav')).toBe(true);

      const invalidWav = Buffer.alloc(12);
      invalidWav.write('RIFF', 0, 4, 'ascii');
      invalidWav.write('WAVX', 8, 4, 'ascii');
      expect(validateBufferMimeType(invalidWav, 'audio/wav')).toBe(false);
    });

    test('validates generic image/, video/, and audio/ types', () => {
      const safeBuf = Buffer.from([0x01, 0x02, 0x03]);
      expect(validateBufferMimeType(safeBuf, 'image/generic')).toBe(true);
      expect(validateBufferMimeType(safeBuf, 'video/generic')).toBe(true);
      expect(validateBufferMimeType(safeBuf, 'audio/generic')).toBe(true);

      const mzBuf = Buffer.from('MZ\x00\x00');
      expect(validateBufferMimeType(mzBuf, 'image/generic')).toBe(false);

      const elfBuf = Buffer.from('\x7FELF');
      expect(validateBufferMimeType(elfBuf, 'image/generic')).toBe(false);
    });

    test('returns true as fallback for other/unknown types', () => {
      const someBuf = Buffer.from('some data');
      expect(validateBufferMimeType(someBuf, 'application/octet-stream')).toBe(true);
    });
  });

  describe('detectBinaryContent', () => {
    test('returns false for empty or null buffers', () => {
      expect(detectBinaryContent(null)).toBe(false);
      expect(detectBinaryContent(Buffer.alloc(0))).toBe(false);
    });

    test('detects known binary signatures', () => {
      // PNG
      expect(detectBinaryContent(Buffer.from('89504E470D0A1A0A', 'hex'))).toBe(true);
      // JPEG
      expect(detectBinaryContent(Buffer.from('FFD8FF0000000000', 'hex'))).toBe(true);
      // GIF
      expect(detectBinaryContent(Buffer.from('474946383761', 'hex'))).toBe(true);
      // WEBP
      const webp = Buffer.alloc(12);
      webp.write('RIFF', 0, 4, 'latin1');
      webp.write('WEBP', 8, 4, 'latin1');
      expect(detectBinaryContent(webp)).toBe(true);
      // PDF
      expect(detectBinaryContent(Buffer.from('25504446', 'hex'))).toBe(true);
      expect(detectBinaryContent(Buffer.from('%PDF-1.4'))).toBe(true);
      // ZIP
      expect(detectBinaryContent(Buffer.from('504B0304', 'hex'))).toBe(true);
      // MP4
      const mp4 = Buffer.alloc(8);
      mp4.write('ftyp', 4, 4, 'latin1');
      expect(detectBinaryContent(mp4)).toBe(true);
      // MP3
      expect(detectBinaryContent(Buffer.from('494433', 'hex'))).toBe(true);
      expect(detectBinaryContent(Buffer.from('FFFB0000', 'hex'))).toBe(true);
      expect(detectBinaryContent(Buffer.from('FFF30000', 'hex'))).toBe(true);
      // WAV
      const wav = Buffer.alloc(12);
      wav.write('RIFF', 0, 4, 'latin1');
      wav.write('WAVE', 8, 4, 'latin1');
      expect(detectBinaryContent(wav)).toBe(true);
      // Executables
      expect(detectBinaryContent(Buffer.from('4D5A', 'hex'))).toBe(true);
      expect(detectBinaryContent(Buffer.from('7F454C46', 'hex'))).toBe(true);
    });

    test('returns true if buffer contains null byte in first 8KB', () => {
      const cleanText = Buffer.from('a'.repeat(9000));
      expect(detectBinaryContent(cleanText)).toBe(false);

      const binaryText = Buffer.from('a'.repeat(4000) + '\x00' + 'b'.repeat(4000));
      expect(detectBinaryContent(binaryText)).toBe(true);
    });
  });

  describe('getExtensionFromMimeType', () => {
    test('returns .bin if empty/falsy mime type', () => {
      expect(getExtensionFromMimeType(null)).toBe('.bin');
      expect(getExtensionFromMimeType('')).toBe('.bin');
    });

    test('resolves mapped mime types', () => {
      expect(getExtensionFromMimeType('image/png')).toBe('.png');
      expect(getExtensionFromMimeType('image/jpeg')).toBe('.jpg');
      expect(getExtensionFromMimeType('application/pdf')).toBe('.pdf');
      expect(getExtensionFromMimeType('application/zip')).toBe('.zip');
      expect(getExtensionFromMimeType('text/html')).toBe('.html');
      expect(getExtensionFromMimeType('text/plain')).toBe('.txt');
    });

    test('extracts dynamic text/ extension', () => {
      expect(getExtensionFromMimeType('text/xml')).toBe('.xml');
      expect(getExtensionFromMimeType('text/x-python')).toBe('.x-python');
      expect(getExtensionFromMimeType('text/plain')).toBe('.txt');
      // Should fallback if invalid characters in sub
      expect(getExtensionFromMimeType('text/foo$bar')).toBe('.bin');
    });

    test('returns .bin for unknown mime types', () => {
      expect(getExtensionFromMimeType('application/unknown')).toBe('.bin');
    });
  });
});
