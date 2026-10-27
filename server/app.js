import { createServer } from "node:http";
import { createDailyBudget, dailyTokenLimit } from "./budget.js";
import { readFile } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
import {
  GenerationError,
  generateImage,
  validateRequest,
} from "./generation.js";

function json(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(JSON.stringify(body));
}
export function createApp({
  apiKey = process.env.OPENAI_API_KEY,
  model = process.env.OPENAI_IMAGE_MODEL || "gpt-image-2",
  fetchImpl = fetch,
  middleware,
  publicDir = resolve("dist"),
  timeoutMs = 180_000,
  maxGenerationsPerHour = Number(process.env.MAX_GENERATIONS_PER_HOUR || 12),
  maxDailyTokens = dailyTokenLimit(),
  usageFile,
  usageLog = console.info,
} = {}) {
  if (!Number.isSafeInteger(maxGenerationsPerHour) || maxGenerationsPerHour < 1)
    throw new Error("MAX_GENERATIONS_PER_HOUR must be a positive integer.");
  const tokenBudget = createDailyBudget({
    limit: maxDailyTokens,
    file: usageFile,
    log: usageLog,
  });
  let inFlight = false;
  let windowStart = Date.now(),
    attempts = 0;
  return createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/api/config" && req.method === "GET")
      return json(res, 200, { configured: Boolean(apiKey) });
    if (url.pathname.startsWith("/api/")) {
      if (url.pathname !== "/api/transform")
        return json(res, 404, { error: "Unknown endpoint." });
      if (req.method !== "POST")
        return json(res, 405, { error: "Use POST to transform a sketch." });
      if (
        req.headers.origin &&
        req.headers.origin !== `http://${req.headers.host}` &&
        req.headers.origin !== `https://${req.headers.host}`
      )
        return json(res, 403, { error: "Use this app to submit a sketch." });
      if (!req.headers["content-type"]?.startsWith("application/json"))
        return json(res, 415, { error: "Send the sketch as JSON." });
      if (inFlight)
        return json(res, 429, {
          error:
            "Another pumpkin is being transformed. Please try again shortly.",
        });
      let controller,
        timer,
        usageResolved = false;
      try {
        let bytes = 0,
          chunks = [];
        for await (const chunk of req) {
          bytes += chunk.length;
          if (bytes > 1_500_000)
            throw new GenerationError(
              413,
              "This sketch is too large. Try a simpler drawing.",
            );
          chunks.push(chunk);
        }
        let body;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString());
        } catch {
          throw new GenerationError(
            400,
            "The request must contain valid JSON.",
          );
        }
        validateRequest(body);
        // Acquire after reading the body; two uploads may finish at the same time.
        if (inFlight)
          throw new GenerationError(
            429,
            "Another pumpkin is being transformed. Please try again shortly.",
          );
        if (!apiKey)
          throw new GenerationError(
            503,
            "Live generation needs a server API key. You can still draw and watch the demo.",
          );
        if (Date.now() - windowStart >= 3_600_000) {
          windowStart = Date.now();
          attempts = 0;
        }
        if (attempts >= maxGenerationsPerHour)
          throw new GenerationError(
            429,
            "This studio reached its hourly image limit. Please try again later.",
          );
        tokenBudget.begin();
        attempts++;
        inFlight = true;
        controller = new AbortController();
        timer = setTimeout(() => controller.abort(), timeoutMs);
        res.on("close", () => controller.abort());
        const result = await generateImage(body, {
          apiKey,
          model,
          fetchImpl,
          signal: controller.signal,
          onRejected: () => {
            tokenBudget.rejectRequest();
            usageResolved = true;
          },
          onUsage: (usage) => {
            usageResolved = true;
            tokenBudget.record(usage);
          },
        });
        if (!res.destroyed) json(res, 200, result);
      } catch (error) {
        if (!res.destroyed)
          json(
            res,
            error instanceof GenerationError
              ? error.status
              : controller?.signal.aborted
                ? 504
                : 502,
            {
              error:
                error instanceof GenerationError
                  ? error.message
                  : controller?.signal.aborted
                    ? "Generation took too long. Your sketch is safe; please try again."
                    : "Could not complete the transformation. Please try again.",
            },
          );
      } finally {
        if (controller && !usageResolved) tokenBudget.record(null);
        clearTimeout(timer);
        if (controller) inFlight = false;
      }
      return;
    }
    if (middleware)
      return middleware(req, res, () =>
        json(res, 404, { error: "Not found." }),
      );
    if (!["GET", "HEAD"].includes(req.method))
      return json(res, 405, { error: "Method not allowed." });
    try {
      let pathname;
      try {
        pathname = decodeURIComponent(url.pathname);
      } catch {
        return json(res, 400, { error: "Invalid path." });
      }
      if (pathname.split("/").some((part) => part.startsWith(".")))
        return json(res, 404, { error: "Not found." });
      let file =
        pathname === "/"
          ? resolve(publicDir, "index.html")
          : resolve(publicDir, "." + pathname);
      if (!file.startsWith(publicDir + sep))
        return json(res, 404, { error: "Not found." });
      // Only application routes receive the SPA shell; missing assets must stay 404s.
      if (!extname(file)) file = resolve(publicDir, "index.html");
      const data = await readFile(file);
      const mime =
        {
          ".html": "text/html; charset=utf-8",
          ".js": "text/javascript",
          ".css": "text/css",
          ".png": "image/png",
          ".svg": "image/svg+xml",
          ".woff2": "font/woff2",
        }[extname(file)] || "application/octet-stream";
      res.writeHead(200, {
        "Content-Type": mime,
        "X-Content-Type-Options": "nosniff",
      });
      res.end(req.method === "HEAD" ? undefined : data);
    } catch {
      json(res, 404, { error: "Not found." });
    }
  });
}
