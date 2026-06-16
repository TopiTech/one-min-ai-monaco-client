#!/usr/bin/env node
// Simple smoke test runner.
const http = require("http");

function fetch(path, opts = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: Number(process.env.PORT || 3100),
        path,
        method: opts.method || "GET",
        headers: opts.headers || {},
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () =>
          resolve({ status: res.statusCode, headers: res.headers, body: data }),
        );
      },
    );
    req.on("error", reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

(async () => {
  const log = (label, obj) => {
    console.log(`\n=== ${label} ===`);
    console.log(`status: ${obj.status}`);
    console.log(
      `body (first 300): ${obj.body ? obj.body.slice(0, 300) : "(empty)"}`,
    );
  };

  const health = await fetch("/api/health");
  log("GET /api/health", health);
  if (health.status !== 200) process.exit(1);

  const index = await fetch("/");
  log("GET /", index);
  const match = index.body.match(/data-bff-token="([^"]+)"/);
  if (!match) {
    console.error("FAIL: data-bff-token not found in index.html");
    process.exit(1);
  }
  const token = match[1];
  console.log(`token (first 10): ${token.slice(0, 10)}...`);

  // With token, no origin -> should be 403
  const noOrigin = await fetch("/api/fs/config", {
    headers: { "x-local-bff-token": token },
  });
  log("GET /api/fs/config (token only, no origin)", noOrigin);
  if (noOrigin.status !== 403) {
    console.error("FAIL: expected 403 without origin/cookie");
    process.exit(1);
  }

  // With token + cookie + same origin -> 200
  const ok = await fetch("/api/fs/config", {
    headers: {
      "x-local-bff-token": token,
      cookie: `__bff_session=${token}`,
      origin: `http://127.0.0.1:${process.env.PORT || 3100}`,
      host: `127.0.0.1:${process.env.PORT || 3100}`,
    },
  });
  log("GET /api/fs/config (token + cookie + origin)", ok);
  if (ok.status !== 200) {
    console.error("FAIL: expected 200 with full credentials");
    process.exit(1);
  }

  // Cross-origin -> 403
  const evil = await fetch("/api/fs/config", {
    headers: {
      "x-local-bff-token": token,
      cookie: `__bff_session=${token}`,
      origin: "https://evil.example",
      host: `127.0.0.1:${process.env.PORT || 3100}`,
    },
  });
  log("GET /api/fs/config (cross-origin)", evil);
  if (evil.status !== 403) {
    console.error("FAIL: expected 403 for cross-origin");
    process.exit(1);
  }

  // Protected path -> 403
  const envRead = await fetch(`/api/fs/read?path=.env`, {
    headers: {
      "x-local-bff-token": token,
      cookie: `__bff_session=${token}`,
      origin: `http://127.0.0.1:${process.env.PORT || 3100}`,
      host: `127.0.0.1:${process.env.PORT || 3100}`,
    },
  });
  log("GET /api/fs/read?path=.env", envRead);
  if (envRead.status !== 403) {
    console.error("FAIL: expected 403 for .env read");
    process.exit(1);
  }

  // Read server.js -> 200
  const srv = await fetch(`/api/fs/read?path=server.js`, {
    headers: {
      "x-local-bff-token": token,
      cookie: `__bff_session=${token}`,
      origin: `http://127.0.0.1:${process.env.PORT || 3100}`,
      host: `127.0.0.1:${process.env.PORT || 3100}`,
    },
  });
  log("GET /api/fs/read?path=server.js", srv);
  if (srv.status !== 200) {
    console.error("FAIL: expected 200 for server.js read");
    process.exit(1);
  }

  // Bad attachments -> 400
  const badAtt = await fetch("/api/chat", {
    method: "POST",
    headers: {
      "x-local-bff-token": token,
      cookie: `__bff_session=${token}`,
      origin: `http://127.0.0.1:${process.env.PORT || 3100}`,
      host: `127.0.0.1:${process.env.PORT || 3100}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ prompt: "hi", attachments: [] }),
  });
  log("POST /api/chat (bad attachments)", badAtt);
  if (badAtt.status !== 400) {
    console.error("FAIL: expected 400 for bad attachments");
    process.exit(1);
  }

  // Missing prompt -> 400
  const noPrompt = await fetch("/api/chat", {
    method: "POST",
    headers: {
      "x-local-bff-token": token,
      cookie: `__bff_session=${token}`,
      origin: `http://127.0.0.1:${process.env.PORT || 3100}`,
      host: `127.0.0.1:${process.env.PORT || 3100}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({}),
  });
  log("POST /api/chat (no prompt)", noPrompt);
  if (noPrompt.status !== 400) {
    console.error("FAIL: expected 400 for missing prompt");
    process.exit(1);
  }

  // gpt-image-only fields on flux -> 400
  const fluxQuality = await fetch("/api/images/generate", {
    method: "POST",
    headers: {
      "x-local-bff-token": token,
      cookie: `__bff_session=${token}`,
      origin: `http://127.0.0.1:${process.env.PORT || 3100}`,
      host: `127.0.0.1:${process.env.PORT || 3100}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      prompt: "a cat",
      model: "black-forest-labs/flux-schnell",
      quality: "high",
    }),
  });
  log("POST /api/images/generate (flux + quality=high)", fluxQuality);
  if (fluxQuality.status !== 400) {
    console.error("FAIL: expected 400 for gpt-image-only field on flux");
    process.exit(1);
  }

  console.log("\nAll smoke tests passed ✅");
})();
