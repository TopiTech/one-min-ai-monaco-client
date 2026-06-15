/**
 * Unit tests for api-client utility
 * Run with: node --experimental-vm-modules node_modules/.bin/jest
 */

import { extractText, normalizeAssetResponse } from '../utils/api-client.js';

// Mock environment variable
process.env.ONE_MIN_AI_API_KEY = 'test-api-key';

describe('api-client', () => {
    describe('extractText', () => {
        test('should extract text from aiRecord.aiRecordDetail.resultObject', () => {
            const data = {
                aiRecord: {
                    aiRecordDetail: {
                        resultObject: 'Hello, world!',
                    },
                },
            };
            expect(extractText(data)).toBe('Hello, world!');
        });

        test('should extract text from aiRecord.aiRecordDetail.result', () => {
            const data = {
                aiRecord: {
                    aiRecordDetail: {
                        result: 'Test result',
                    },
                },
            };
            expect(extractText(data)).toBe('Test result');
        });

        test('should extract text from result field', () => {
            const data = { result: 'Simple result' };
            expect(extractText(data)).toBe('Simple result');
        });

        test('should extract text from message field', () => {
            const data = { message: 'Message text' };
            expect(extractText(data)).toBe('Message text');
        });

        test('should extract text from text field', () => {
            const data = { text: 'Text content' };
            expect(extractText(data)).toBe('Text content');
        });

        test('should extract text from content field', () => {
            const data = { content: 'Content here' };
            expect(extractText(data)).toBe('Content here');
        });

        test('should handle array result', () => {
            const data = {
                aiRecord: {
                    aiRecordDetail: {
                        resultObject: ['Line 1', 'Line 2', 'Line 3'],
                    },
                },
            };
            expect(extractText(data)).toBe('Line 1\nLine 2\nLine 3');
        });

        test('should handle object result by JSON stringifying', () => {
            const data = {
                aiRecord: {
                    aiRecordDetail: {
                        resultObject: { key: 'value' },
                    },
                },
            };
            expect(extractText(data)).toBe(JSON.stringify({ key: 'value' }, null, 2));
        });

        test('should return JSON stringified data when no candidates match', () => {
            const data = { unknown: 'structure' };
            expect(extractText(data)).toBe(JSON.stringify(data, null, 2));
        });

        test('should handle null and undefined gracefully', () => {
            expect(extractText(null)).toBe('null');
            // extractText(undefined) returns undefined because JSON.stringify(undefined) returns undefined
            expect(extractText(undefined)).toBeUndefined();
        });

        test('should handle empty object', () => {
            expect(extractText({})).toBe('{}');
        });
    });

    describe('normalizeAssetResponse', () => {
        test('should normalize asset key and build asset URL', () => {
            const data = {
                asset: {
                    key: 'uploads/example.png',
                },
            };

            expect(normalizeAssetResponse(data)).toEqual({
                key: 'uploads/example.png',
                url: 'https://asset.1min.ai/uploads/example.png',
                raw: data,
            });
        });

        test('should preserve absolute asset URLs', () => {
            const data = {
                fileContent: {
                    path: 'https://asset.1min.ai/uploads/example.png',
                },
            };

            expect(normalizeAssetResponse(data)).toEqual({
                key: 'https://asset.1min.ai/uploads/example.png',
                url: 'https://asset.1min.ai/uploads/example.png',
                raw: data,
            });
        });
    });
});
