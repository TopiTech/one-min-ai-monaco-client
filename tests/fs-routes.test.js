/**
 * Integration tests for /api/fs/* routes.
 *
 * Covers: list, read, write, create, delete, rename, config, roots,
 * workspace/select, drives — with protection checks.
 */
import { jest } from "@jest/globals";
import request from "supertest";
import fs from "fs/promises";
import path from "path";
import os from "os";

jest.unstable_mockModule("../utils/api-client.js", () => ({
  callOneMin: jest.fn(),
  extractText: jest.fn((d) => d?.result || JSON.stringify(d)),
  isFailedResponse: jest.fn(() => false),
  extractFailureMessage: jest.fn(() => "mocked failure"),
  normalizeAssetResponse: jest.fn((d) => ({
    key: d?.asset?.key || "",
    url: "",
    raw: d,
  })),
  parseResponsePayload: jest.fn(async (response) => {
    const text = await response.text();
    if (!text) return {};
    try { return JSON.parse(text); } catch { return { message: text }; }
  }),
}));

const { createApp } = await import("../server.js");

describe("FS Routes", () => {
  let app;
  let tmpDir;

  beforeEach(async () => {
    jest.clearAllMocks();
    process.env.NODE_ENV = "test";
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "fs-route-test-"));
    // Include tmpDir in ALLOWED_ROOTS so fs routes can access it
    process.env.ALLOWED_ROOTS = tmpDir;
    app = createApp({ requireLocalAuth: false, enableRateLimit: false });
  });

  afterEach(async () => {
    delete process.env.NODE_ENV;
    delete process.env.ALLOWED_ROOTS;
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  // ----------------------------------------------------------------
  // GET /api/fs/config
  // ----------------------------------------------------------------
  describe("GET /api/fs/config", () => {
    test("returns root and allowedRoots", async () => {
      const res = await request(app).get("/api/fs/config");
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("root");
      expect(res.body).toHaveProperty("allowedRoots");
      expect(Array.isArray(res.body.allowedRoots)).toBe(true);
    });
  });

  // ----------------------------------------------------------------
  // GET /api/fs/roots
  // ----------------------------------------------------------------
  describe("GET /api/fs/roots", () => {
    test("returns roots array", async () => {
      const res = await request(app).get("/api/fs/roots");
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.roots)).toBe(true);
      expect(res.body.roots.length).toBeGreaterThan(0);
    });
  });

  // ----------------------------------------------------------------
  // GET /api/fs/list
  // ----------------------------------------------------------------
  describe("GET /api/fs/list", () => {
    test("lists directory contents", async () => {
      const res = await request(app).get("/api/fs/list").query({ dir: tmpDir });
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("dir", tmpDir);
      expect(Array.isArray(res.body.items)).toBe(true);
    });

    test("defaults to root when no dir specified", async () => {
      const res = await request(app).get("/api/fs/list");
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("items");
    });
  });

  // ----------------------------------------------------------------
  // POST /api/fs/write + GET /api/fs/read round-trip
  // ----------------------------------------------------------------
  describe("POST /api/fs/write + GET /api/fs/read", () => {
    test("writes and reads back a file", async () => {
      const filePath = path.join(tmpDir, "roundtrip.txt");
      const content = "hello fs routes\n";

      const writeRes = await request(app).post("/api/fs/write").send({ path: filePath, content });
      expect(writeRes.status).toBe(200);
      expect(writeRes.body.ok).toBe(true);

      const readRes = await request(app).get("/api/fs/read").query({ path: filePath });
      expect(readRes.status).toBe(200);
      expect(readRes.body.content).toBe(content);
    });

    test("reads a specific slice of lines when startLine and/or endLine are provided", async () => {
      const filePath = path.join(tmpDir, "slicetrip.txt");
      const content = "line1\nline2\nline3\nline4\nline5";

      await request(app).post("/api/fs/write").send({ path: filePath, content });

      // startLine and endLine both set
      let readRes = await request(app).get("/api/fs/read").query({ path: filePath, startLine: 2, endLine: 4 });
      expect(readRes.status).toBe(200);
      expect(readRes.body.content).toBe("line2\nline3\nline4");

      // only startLine set
      readRes = await request(app).get("/api/fs/read").query({ path: filePath, startLine: 3 });
      expect(readRes.status).toBe(200);
      expect(readRes.body.content).toBe("line3\nline4\nline5");

      // only endLine set
      readRes = await request(app).get("/api/fs/read").query({ path: filePath, endLine: 2 });
      expect(readRes.status).toBe(200);
      expect(readRes.body.content).toBe("line1\nline2");
    });

    test("rejects invalid startLine and endLine values", async () => {
      const filePath = path.join(tmpDir, "slicetrip.txt");
      await request(app).post("/api/fs/write").send({ path: filePath, content: "a\nb" });

      // startLine > endLine
      let res = await request(app).get("/api/fs/read").query({ path: filePath, startLine: 3, endLine: 2 });
      expect(res.status).toBe(400);

      // startLine 0
      res = await request(app).get("/api/fs/read").query({ path: filePath, startLine: 0 });
      expect(res.status).toBe(400);

      // endLine negative
      res = await request(app).get("/api/fs/read").query({ path: filePath, endLine: -1 });
      expect(res.status).toBe(400);

      // float
      res = await request(app).get("/api/fs/read").query({ path: filePath, startLine: 1.5 });
      expect(res.status).toBe(400);
    });

    test("read rejects missing path", async () => {
      const res = await request(app).get("/api/fs/read");
      expect(res.status).toBe(400);
    });

    test("write rejects missing path", async () => {
      const res = await request(app).post("/api/fs/write").send({ content: "x" });
      expect(res.status).toBe(400);
    });

    test("write rejects missing content", async () => {
      const res = await request(app)
        .post("/api/fs/write")
        .send({ path: path.join(tmpDir, "x.txt") });
      expect(res.status).toBe(400);
    });
  });

  // ----------------------------------------------------------------
  // POST /api/fs/create
  // ----------------------------------------------------------------
  describe("POST /api/fs/create", () => {
    test("creates a file with content", async () => {
      const filePath = path.join(tmpDir, "created.txt");
      const res = await request(app)
        .post("/api/fs/create")
        .send({ path: filePath, type: "file", content: "created" });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);

      const content = await fs.readFile(filePath, "utf-8");
      expect(content).toBe("created");
    });

    test("creates a directory", async () => {
      const dirPath = path.join(tmpDir, "new-dir");
      const res = await request(app).post("/api/fs/create").send({ path: dirPath, type: "directory" });
      expect(res.status).toBe(200);
      expect(res.body.type).toBe("directory");

      const stat = await fs.stat(dirPath);
      expect(stat.isDirectory()).toBe(true);
    });
  });

  // ----------------------------------------------------------------
  // POST /api/fs/delete
  // ----------------------------------------------------------------
  describe("POST /api/fs/delete", () => {
    test("deletes a file", async () => {
      const filePath = path.join(tmpDir, "to-delete.txt");
      await fs.writeFile(filePath, "delete me");

      const res = await request(app).post("/api/fs/delete").send({ path: filePath });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);

      await expect(fs.access(filePath)).rejects.toThrow();
    });

    test("rejects missing path", async () => {
      const res = await request(app).post("/api/fs/delete").send({});
      expect(res.status).toBe(400);
    });
  });

  // ----------------------------------------------------------------
  // POST /api/fs/rename
  // ----------------------------------------------------------------
  describe("POST /api/fs/rename", () => {
    test("renames a file", async () => {
      const oldPath = path.join(tmpDir, "old.txt");
      const newPath = path.join(tmpDir, "new.txt");
      await fs.writeFile(oldPath, "rename me");

      const res = await request(app).post("/api/fs/rename").send({ oldPath, newPath });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);

      const content = await fs.readFile(newPath, "utf-8");
      expect(content).toBe("rename me");
      await expect(fs.access(oldPath)).rejects.toThrow();
    });

    test("rejects missing parameters", async () => {
      const res = await request(app).post("/api/fs/rename").send({ oldPath: "/a" });
      expect(res.status).toBe(400);
    });
  });

  // ----------------------------------------------------------------
  // Protection checks
  // ----------------------------------------------------------------
  describe("Protection checks", () => {
    test("read blocks protected .env path", async () => {
      const res = await request(app).get("/api/fs/read").query({ path: ".env" });
      expect(res.status).toBe(403);
    });

    test("write blocks protected server.js path", async () => {
      const res = await request(app).post("/api/fs/write").send({ path: "server.js", content: "bad" });
      expect(res.status).toBe(403);
    });

    test("delete blocks protected package.json path", async () => {
      const res = await request(app).post("/api/fs/delete").send({ path: "package.json" });
      expect(res.status).toBe(403);
    });

    test("rename blocks protected utils/ path", async () => {
      const res = await request(app)
        .post("/api/fs/rename")
        .send({ oldPath: "utils/api-client.js", newPath: path.join(tmpDir, "moved.js") });
      expect(res.status).toBe(403);
    });

    test("read blocks binary files", async () => {
      const binPath = path.join(tmpDir, "image.png");
      // Write a file with a PNG magic header
      await fs.writeFile(binPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]));
      const res = await request(app).get("/api/fs/read").query({ path: binPath });
      expect(res.status).toBe(400);
    });
  });
});
