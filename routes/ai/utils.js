import { serverConfig } from '../../config/server.js';
import { z } from 'zod';

export function getDefaultModel(type) {
  if (type === 'CODE_GENERATOR') return serverConfig.defaultCodeModel;
  if (type === 'IMAGE_GENERATOR') return serverConfig.defaultImageModel;
  if (type === 'IMAGE_EDITOR') return serverConfig.defaultImageEditorModel;
  return serverConfig.defaultChatModel;
}

export const outputCompressionSchema = z
  .preprocess(
    (val) => {
      if (val === undefined || val === '' || (typeof val === 'string' && val.trim() === '')) {
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
