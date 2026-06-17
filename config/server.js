/**
 * Server configuration with environment variable defaults.
 * All configurable values are centralized here.
 */

export const serverConfig = {
    // Server settings
    port: Number(process.env.PORT || 3000),

    // File upload limits
    maxFileSize: Number(process.env.MAX_FILE_SIZE || 25 * 1024 * 1024), // 25MB default
    maxJsonBodySize: process.env.MAX_JSON_BODY_SIZE || '2mb',

    // API settings
    apiTimeout: Number(process.env.API_TIMEOUT || 60000), // 60 seconds
    apiRetryAttempts: Number(process.env.API_RETRY_ATTEMPTS || 3),
    apiRetryDelay: Number(process.env.API_RETRY_DELAY || 2000), // 2 seconds

    // Default models
    defaultChatModel: process.env.DEFAULT_CHAT_MODEL || 'gpt-4o-mini',
    defaultCodeModel: process.env.DEFAULT_CODE_MODEL || 'qwen3-coder-plus',
    defaultImageModel: process.env.DEFAULT_IMAGE_MODEL || 'gpt-image-2',
    defaultImageEditorModel: process.env.DEFAULT_IMAGE_EDITOR_MODEL || 'gpt-image-2',

    // API base URL override (1min.ai production by default; useful for
    // local mock servers or staging environments).
    apiBaseUrl: process.env.ONE_MIN_AI_API_BASE_URL || 'https://api.1min.ai',

    // Agent settings
    enableCommandExecution: String(process.env.ENABLE_COMMAND_EXECUTION || 'false').toLowerCase() === 'true',
    commandTimeoutMs: Math.max(1000, parseInt(process.env.COMMAND_TIMEOUT_MS || "30000", 10) || 30000),
    agentAutoApprove: String(process.env.AGENT_AUTO_APPROVE || 'false').toLowerCase() === 'true',
    // Drives enumeration is intentionally separate from ENABLE_COMMAND_EXECUTION:
    // /api/fs/drives uses shell tools (powershell/wmic) only for local directory
    // listing and is safe in any environment, while ENABLE_COMMAND_EXECUTION gates
    // arbitrary agent command execution which is the high-risk surface.
    enableDrivesShellLookup: String(process.env.ENABLE_DRIVES_SHELL_LOOKUP || 'true').toLowerCase() === 'true',

    // Logging
    logLevel: process.env.LOG_LEVEL || 'info',
    logFile: process.env.LOG_FILE || 'logs/app.log',
};
