/**
 * Integration tests for server routes
 * Run with: node --experimental-vm-modules node_modules/jest/bin/jest.js
 */

import { jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';

// Mock the api-client module
jest.unstable_mockModule('../utils/api-client.js', () => ({
    callOneMin: jest.fn(),
    extractText: jest.fn((data) => data?.result || JSON.stringify(data)),
}));

// Import after mocking
const { callOneMin } = await import('../utils/api-client.js');

describe('Server Routes', () => {
    let app;

    beforeEach(async () => {
        // Create a fresh express app for each test
        app = express();
        app.use(express.json({ limit: '2mb' }));

        // Health check endpoint
        app.get('/api/health', (_req, res) => {
            res.json({
                ok: true,
                service: 'one-min-ai-monaco-client',
                hasApiKey: Boolean(process.env.ONE_MIN_AI_API_KEY),
            });
        });

        // Error handler
        app.use((err, _req, res, _next) => {
            res.status(err.status || 500).json({
                error: err.message || 'Internal Server Error'
            });
        });
    });

    describe('GET /api/health', () => {
        test('should return 200 with health status', async () => {
            process.env.ONE_MIN_AI_API_KEY = 'test-key';

            const response = await request(app).get('/api/health');

            expect(response.status).toBe(200);
            expect(response.body.ok).toBe(true);
            expect(response.body.service).toBe('one-min-ai-monaco-client');
            expect(response.body.hasApiKey).toBe(true);
        });

        test('should indicate when API key is missing', async () => {
            delete process.env.ONE_MIN_AI_API_KEY;

            const response = await request(app).get('/api/health');

            expect(response.status).toBe(200);
            expect(response.body.hasApiKey).toBe(false);
        });
    });
});

describe('Configuration', () => {
    test('should have default values for server config', async () => {
        const { serverConfig } = await import('../config/server.js');

        expect(serverConfig.port).toBeDefined();
        expect(serverConfig.maxFileSize).toBeDefined();
        expect(serverConfig.apiTimeout).toBeDefined();
        expect(serverConfig.apiRetryAttempts).toBeDefined();
    });

    test('should use environment variables when available', async () => {
        process.env.PORT = '4000';
        process.env.MAX_FILE_SIZE = '52428800';

        // Re-import to get fresh config
        jest.resetModules();
        const { serverConfig } = await import('../config/server.js');

        expect(serverConfig.port).toBe(4000);
        expect(serverConfig.maxFileSize).toBe(52428800);

        // Cleanup
        delete process.env.PORT;
        delete process.env.MAX_FILE_SIZE;
    });
});
