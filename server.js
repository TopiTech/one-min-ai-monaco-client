import "dotenv/config";
import express from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import multer from "multer";
import path from "path";
import { fileURLToPath } from "url";
import { callOneMin } from "./utils/api-client.js";
import { serverConfig } from "./config/server.js";
import logger from "./utils/logger.js";

import aiRoutes from "./routes/ai.js";
import fsRoutes from "./routes/fs.js";
import agentRoutes from "./routes/agent.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const ALLOWED_MIME_TYPES = [
  "image/",
  "application/pdf",
  "text/",
  "application/json",
  "application/xml",
  "application/msword",
  "application/vnd.openxmlformats-officedocument",
];

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: serverConfig.maxFileSize },
  fileFilter: (_req, file, cb) => {
    const allowed = ALLOWED_MIME_TYPES.some((t) => file.mimetype.startsWith(t));
    if (!allowed) {
      const err = new Error(
        `Unsupported file type: ${file.mimetype}. Allowed types: ${ALLOWED_MIME_TYPES.join(", ")}`,
      );
      err.status = 415;
      return cb(err, false);
    }
    cb(null, true);
  },
});

// Security middleware: Helmet
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "https://cdn.jsdelivr.net", "'unsafe-inline'", "blob:"],
        styleSrc: [
          "'self'",
          "'unsafe-inline'",
          "https://cdn.jsdelivr.net",
          "https://fonts.googleapis.com",
        ],
        imgSrc: ["'self'", "data:", "https:", "blob:"],
        connectSrc: ["'self'", "https://cdn.jsdelivr.net"],
        fontSrc: ["'self'", "data:", "https://cdn.jsdelivr.net", "https://fonts.gstatic.com"],
        objectSrc: ["'none'"],
        mediaSrc: ["'self'"],
        frameSrc: ["'none'"],
        workerSrc: ["'self'", "blob:"],
      },
    },
    crossOriginEmbedderPolicy: false, // Required for Monaco web workers
  }),
);

// Rate limiting
const generalLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 180, // 180 requests per minute
  message: { error: "Too many requests, please try again later." },
  standardHeaders: true,
  legacyHeaders: false,
});

const uploadLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 100, // 100 upload requests per minute
  message: { error: "Too many upload requests, please try again later." },
  standardHeaders: true,
  legacyHeaders: false,
});

app.use(generalLimiter);

// Request logging middleware
app.use(logger.requestLogger());

app.use(express.json({ limit: serverConfig.maxJsonBodySize }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    service: "one-min-ai-monaco-client",
    hasApiKey: Boolean(process.env.ONE_MIN_AI_API_KEY),
  });
});

// Assets upload endpoint (with stricter rate limit)
app.post("/api/assets/upload", uploadLimiter, upload.single("asset"), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: "asset file is required" });

    logger.info("Processing asset upload", {
      filename: req.file.originalname,
      size: req.file.size,
      mimetype: req.file.mimetype,
    });

    const formData = new FormData();
    const blob = new Blob([req.file.buffer], {
      type: req.file.mimetype || "application/octet-stream",
    });

    formData.append("asset", blob, req.file.originalname || "upload.bin");

    const data = await callOneMin("/api/assets", { method: "POST", body: formData });

    logger.info("Asset upload successful", { filename: req.file.originalname });
    res.json(data);
  } catch (err) {
    logger.error("Asset upload failed", { error: err.message });
    next(err);
  }
});

// Use Routers
app.use("/api", aiRoutes);
app.use("/api/fs", fsRoutes);
app.use("/api/agent", agentRoutes);

// Error handling middleware
app.use((err, req, res, _next) => {
  logger.error("Unhandled error", {
    error: err.message,
    status: err.status,
    method: req.method,
    url: req.originalUrl,
    stack: err.stack,
  });

  const status = err.status || 500;
  let errorMessage = err.message || "Internal Server Error";

  if (err.payload) {
    if (typeof err.payload === "object") {
      errorMessage = err.payload.error || err.payload.message || errorMessage;
    } else if (typeof err.payload === "string") {
      errorMessage = err.payload;
    }
  }

  const isDev = process.env.NODE_ENV === "development";
  res.status(status).json({
    error: errorMessage,
    details: isDev ? err.payload || null : null,
  });
});

app.listen(serverConfig.port, "127.0.0.1", () => {
  logger.info(`1min.ai Monaco client running: http://127.0.0.1:${serverConfig.port}`);
  logger.info("Server configuration", {
    port: serverConfig.port,
    maxFileSize: serverConfig.maxFileSize,
    apiTimeout: serverConfig.apiTimeout,
    apiRetryAttempts: serverConfig.apiRetryAttempts,
  });
});
