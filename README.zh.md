# 1min.ai Monaco Client

> 🌐 [日本語](README.md) | [English](README.en.md) | [中文](README.zh.md) | [한국어](README.ko.md) | [Español](README.es.md)

> [!WARNING]
> **本应用程序专为本地环境（localhost/127.0.0.1）的个人开发和单用户使用而设计。**
> `/api/fs/*`（文件系统操作）和代理命令执行功能不包含面向多用户的企业级保护机制，如基于角色的访问控制（RBAC）、详细审计日志或沙箱执行。**绝对不要部署到公共互联网服务器或共享的开发/预发布环境。**
>
> **【重要】AI代理OS命令执行安全警告**
>
> - 启用代理功能的OS命令执行（`ENABLE_COMMAND_EXECUTION=true`）时，AI可能触发任意代码（如安装或执行恶意软件包）。
> - 默认使用 **`AGENT_AUTO_APPROVE=false`** 运行，执行前必须由人工确认命令安全性。如设置 `AGENT_AUTO_APPROVE=true`，请在完全隔离的沙箱或Docker容器环境中使用。

基于 Monaco Editor + 自定义UI + 1min.ai API 构建的浏览器端AI客户端MVP。
使用 Express 服务器作为BFF中继，避免将 1min.ai API 密钥暴露给前端。

## 主要功能

- 普通聊天
- 模型选择器分类（旗舰、推理、快速轻量）
- 会话创建 / 通过 `conversationId` 恢复会话
- 通过 Web Search 切换扩展聊天
- 图像生成
- 图像文本编辑器
- 通过 Asset API 上传图像
- Monaco Editor 集成
- 代码解释 / 生成 / 重构辅助
- 内联聊天（带应用/丢弃预览）
- 高级AI编程代理（详细思考过程展示、审批流程）
- 项目文件浏览和保存
- API密钥不暴露给前端的服务器中继架构
- 健壮的文件路径安全防护（`fs-guard`）

## 环境要求

- Node.js 18+
- 1min.ai API Key
- Monaco Editor / marked / DOMPurify 在 `npm start` 时自动从 `node_modules` 复制到 `public/`，因此 `npm install` 后无需网络连接（Google Fonts 加载除外）

## 快速开始

```bash
cp .env.example .env
# 编辑 .env 中的 ONE_MIN_AI_API_KEY
npm install
npm start
```

或开发模式：

```bash
npm run dev
```

启动后打开：

```text
http://localhost:3000
```

## 环境变量

| 变量                         | 必需 | 默认值                | 说明                                                   |
| ---------------------------- | ---- | --------------------- | ------------------------------------------------------ |
| `ONE_MIN_AI_API_KEY`         | 是   | 无                    | 1min.ai API密钥。仅保存在 `.env` 中。                  |
| `PORT`                       | 否   | `3000`                | 本地Express服务器监听端口。                            |
| `NODE_ENV`                   | 否   | `development`         | 设为 `production` 隐藏堆栈跟踪并启用安全Cookie。       |
| `MAX_FILE_SIZE`              | 否   | `26214400`            | 资源上传大小限制（字节，默认25MB）。                   |
| `MAX_JSON_BODY_SIZE`         | 否   | `2mb`                 | JSON请求体大小上限。                                   |
| `DEFAULT_CHAT_MODEL`         | 否   | `gpt-4o-mini`         | 聊天和代码生成的默认模型。                             |
| `DEFAULT_CODE_MODEL`         | 否   | `qwen3-coder-plus`    | 代码生成的默认模型。                                   |
| `DEFAULT_IMAGE_MODEL`        | 否   | `gpt-image-2`         | 图像生成的默认模型。                                   |
| `DEFAULT_IMAGE_EDITOR_MODEL` | 否   | `gpt-image-2`         | 图像文本编辑器的默认模型。                             |
| `ONE_MIN_AI_API_BASE_URL`    | 否   | `https://api.1min.ai` | 1min.ai API基础URL。用于模拟服务器或预发布环境。       |
| `ASSET_PROXY_TIMEOUT_MS`     | 否   | `30000`               | 资源代理超时（毫秒）。                                 |
| `ASSET_PROXY_MAX_SIZE`       | 否   | `50mb`                | 代理资源最大响应大小（支持 `b`/`kb`/`mb`/`gb` 后缀）。 |
| `API_TIMEOUT`                | 否   | `60000`               | 1min.ai API请求超时（毫秒）。                          |
| `API_RETRY_ATTEMPTS`         | 否   | `3`                   | 1min.ai API错误时的最大重试次数。                      |
| `API_RETRY_DELAY`            | 否   | `2000`                | 重试基础延迟（毫秒）。                                 |
| `RATE_LIMIT_WINDOW_MS`       | 否   | `60000`               | 速率限制窗口（毫秒）。                                 |
| `RATE_LIMIT_MAX`             | 否   | `180`                 | 标准端点每窗口最大请求数。                             |
| `SESSION_TTL_MS`             | 否   | `1800000`             | 代理会话有效期（毫秒，默认30分钟）。                   |
| `ALLOWED_ROOTS`              | 否   | 当前项目根目录        | 可浏览/编辑的根路径列表，逗号分隔。                    |
| `ENABLE_COMMAND_EXECUTION`   | 否   | `false`               | 启用代理命令执行。                                     |
| `COMMAND_TIMEOUT_MS`         | 否   | `30000`               | 命令执行超时时间。                                     |
| `AGENT_AUTO_APPROVE`         | 否   | `false`               | 是否允许无审批执行。默认保持false。                    |
| `AGENT_MAX_LOOPS`            | 否   | `20`                  | 代理最大循环迭代次数（1-100）。                        |
| `AGENT_MAX_SESSIONS`         | 否   | `50`                  | 内存中保持的最大代理会话数。                           |
| `LOCAL_BFF_AUTH_TOKEN`       | 否   | 自动生成              | 本地BFF认证令牌。未设置则自动生成。                    |
| `LOG_LEVEL`                  | 否   | `info`                | 日志级别（`error`, `warn`, `info`, `debug`）。         |
| `LOG_TO_FILE`                | 否   | `false`               | 启用日志文件输出。                                     |
| `LOG_FILE`                   | 否   | `logs/app.log`        | 日志文件路径。                                         |

## 使用方法

### 聊天

1. 从左侧菜单打开「聊天」。
2. 选择模型。
3. 输入消息并发送。
4. 如需使用会话历史，点击「新建会话」并将返回的ID填入 `conversationId`。

### 图像生成 / 文本编辑

1. 从左侧菜单打开「图像生成/文本编辑」。
2. 图像生成：输入提示词、模型、宽高比、数量。
3. 图像文本编辑器：上传源图像，输入返回的asset key或现有图像URL。
4. 指定编辑提示词、模型、输出尺寸、质量、数量等，点击「编辑图像」。

### 编程辅助

1. 从左侧菜单打开「编程」。
2. 从文件树打开文件。
3. 在右侧AI编程面板输入指令，按「执行」。
4. 使用「将首个代码块应用到编辑器」将结果应用到编辑器。
5. `Ctrl+S` 保存，`Ctrl+I` 打开内联聊天。

## 注意事项

- 不要将 `.env` 提交到Git。如果意外提交，请立即在 1min.ai 重新生成API密钥。
- `/api/fs/*` 仅用于本地开发。公共环境请加强认证、CSRF防护、审计日志、执行沙箱和受保护路径策略。
- 这是MVP版本。生产环境请添加认证、速率限制、审计日志、沙箱执行、CSRF防护等。

## 许可证

MIT License
