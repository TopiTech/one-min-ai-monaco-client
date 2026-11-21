import { serverConfig } from '../../config/server.js';
import { z } from 'zod';

export function getDefaultModel(type) {
  if (type === 'CODE_GENERATOR') return serverConfig.defaultCodeModel;
  if (type === 'IMAGE_GENERATOR') return serverConfig.defaultImageModel;
  if (type === 'IMAGE_EDITOR') return serverConfig.defaultImageEditorModel;
  return serverConfig.defaultChatModel;
}

/**
 * Strictly parses optional numeric inputs for Zod schemas without coercing
 * `null`, whitespace-only strings, or booleans into `0` or `1`.
 *
 * @template {z.ZodTypeAny} T
 * @param {T} schema
 */
export function optionalNumberInput(schema) {
  return z.preprocess((val) => {
    if (val === undefined || val === null || val === '') return undefined;
    if (typeof val === 'string') {
      const trimmed = val.trim();
      return trimmed === '' ? undefined : Number(trimmed);
    }
    if (typeof val === 'number') return val;
    return val;
  }, schema);
}

/**
 * Parses boolean flags while honoring an explicit default when null/undefined.
 *
 * @param {boolean} [defaultValue=false]
 */
export function booleanFlagInput(defaultValue = false) {
  return z.preprocess(
    (val) => (val === undefined || val === null ? defaultValue : val === 'true' || val === true),
    z.boolean().default(defaultValue),
  );
}

/**
 * Binds an AbortController to `res` close before headers finish so upstream
 * calls abort promptly on client disconnect, with a cleanup callback for finally.
 *
 * @param {import('express').Response} res
 */
export function bindRequestAbortSignal(res) {
  const controller = new AbortController();
  const onClose = () => {
    if (!res.writableEnded) {
      controller.abort();
    }
  };
  res.on('close', onClose);
  const cleanup = () => res.off?.('close', onClose);
  return { controller, cleanup };
}

export const outputCompressionSchema = z
  .preprocess(
    (val) => {
      if (val === undefined || val === null || val === '' || (typeof val === 'string' && val.trim() === '')) {
        return undefined;
      }
      return val;
    },
    z
      .any()
      .superRefine((val, ctx) => {
        if (val === undefined) return;
        const n = Number(val);
        if (isNaN(n) || !Number.isFinite(n)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'output_compression must be a finite number',
          });
          return;
        }
        if (!Number.isInteger(n) || n < 0 || n > 100) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'output_compression must be an integer between 0 and 100',
          });
        }
      })
      .transform((val) => {
        if (val === undefined) return undefined;
        return Number(val);
      }),
  )
  .optional();
