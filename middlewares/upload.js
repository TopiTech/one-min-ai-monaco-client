import multer from 'multer';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import fs from 'fs';
import { serverConfig } from '../config/server.js';
import { UnsupportedMediaTypeError, PayloadTooLargeError, BadRequestError } from '../utils/errors.js';

const ALLOWED_MIME_TYPES = [
  'image/',
  'video/',
  'audio/',
  'application/pdf',
  'text/',
  'application/json',
  'application/xml',
  'application/msword',
  'application/vnd.openxmlformats-officedocument',
];

// S-1: Switched from multer.memoryStorage() to diskStorage to avoid OOM
// when several large uploads arrive concurrently. Each file lands in
// os.tmpdir() with a random suffix and is unlinked after the upstream
// request finishes (success or failure).
export const UPLOAD_TMP_DIR = path.join(os.tmpdir(), 'one-min-ai-uploads');
fs.mkdirSync(UPLOAD_TMP_DIR, { recursive: true });

export const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOAD_TMP_DIR),
    filename: (_req, file, cb) => {
      const suffix = crypto.randomBytes(8).toString('hex');
      cb(null, `${Date.now()}-${suffix}-${file.fieldname}`);
    },
  }),
  limits: { fileSize: serverConfig.maxFileSize },
  fileFilter: (_req, file, cb) => {
    const allowed = ALLOWED_MIME_TYPES.some((t) => file.mimetype.startsWith(t));
    if (!allowed) {
      const err = new UnsupportedMediaTypeError(
        `Unsupported file type: ${file.mimetype}. Allowed types: ${ALLOWED_MIME_TYPES.join(', ')}`,
      );
      return cb(err, false);
    }
    cb(null, true);
  },
});

/**
 * Map multer/multer-like errors to proper HTTP status codes.
 */
export function mapMulterError(err) {
  if (!err) return err;
  const code = err.code;
  if (code === 'LIMIT_FILE_SIZE') {
    const e = new PayloadTooLargeError(err.message || 'File too large', code);
    e.field = err.field;
    return e;
  }
  const badRequestCodes = [
    'LIMIT_UNEXPECTED_FILE',
    'LIMIT_FIELD_COUNT',
    'LIMIT_FIELD_KEY',
    'LIMIT_FIELD_VALUE',
    'LIMIT_PART_COUNT',
    'LIMIT_FILE_COUNT',
  ];

  if (badRequestCodes.includes(code)) {
    return new BadRequestError(err.message || 'Invalid multipart payload', code);
  }
  return err;
}
