import express from 'express';
import { jest } from '@jest/globals';
import aiRoutes from '../routes/ai.js';
import fsRoutes from '../routes/fs.js';
import agentRoutes from '../routes/agent.js';

/**
 * Creates and configures a clean Express application instance for route testing.
 * Includes JSON parsing middleware and mounts all API routers.
 */
export function createTestApp() {
  const app = express();
  app.use(express.json({ limit: '2mb' }));

  // Mount routers
  app.use('/api', aiRoutes);
  app.use('/api/fs', fsRoutes);
  app.use('/api/agent', agentRoutes);

  // Health check endpoint (matching server.js)
  app.get('/api/health', (_req, res) => {
    res.json({
      ok: true,
      service: 'one-min-ai-monaco-client',
      hasApiKey: Boolean(process.env.ONE_MIN_AI_API_KEY),
    });
  });

  // Error handling middleware
  app.use((err, req, res, _next) => {
    const status = err.status || 500;
    res.status(status).json({
      error: err.message || 'Internal Server Error',
      details: err.payload || null,
    });
  });

  return app;
}

/**
 * Common mock payloads for testing router inputs.
 */
export const testPayloads = {
  chat: {
    prompt: 'Hello AI',
    model: 'gpt-4o-mini',
    webSearch: false,
  },
  image: {
    prompt: 'a beautiful futuristic workspace',
    model: 'gpt-image-2',
    num_outputs: 1,
    aspect_ratio: '1:1',
  },
  imageEditor: {
    imageUrl: 'assets/some-key.png',
    prompt: 'change background to sunset',
    model: 'gpt-image-2',
    size: '1024x1024',
  },
  codeGenerate: {
    instruction: 'Create a sum function',
    fileName: 'math.js',
    language: 'javascript',
    code: '',
  },
  codeAutocomplete: {
    code: 'function add(a, b) {\n  return a + b;\n}\n\n// call add',
    line: 5,
    column: 1,
    fileName: 'math.js',
    language: 'javascript',
  },
};

/**
 * Standard simulated API response builders for 1min.ai.
 */
export const mockResponses = {
  chat: {
    result: 'Hello! I am an AI assistant.',
    aiRecord: {
      uuid: 'chat-uuid-123',
      aiRecordDetail: {
        resultObject: 'Hello! I am an AI assistant.',
      },
    },
  },
  image: {
    result: {
      images: ['https://api.1min.ai/assets/generated-1.png'],
    },
    aiRecord: {
      uuid: 'image-uuid-123',
      resultObject: {
        images: ['https://api.1min.ai/assets/generated-1.png'],
      },
    },
  },
  code: {
    result: '```javascript\nfunction sum(a, b) {\n  return a + b;\n}\n```',
    aiRecord: {
      uuid: 'code-uuid-123',
      aiRecordDetail: {
        resultObject: '```javascript\nfunction sum(a, b) {\n  return a + b;\n}\n```',
      },
    },
  },
};
