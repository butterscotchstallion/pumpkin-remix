import { test } from "node:test";
import assert from "node:assert/strict";
import { PNG } from "pngjs";
import {
  buildPrompt,
  generateImage,
  validateRequest,
  styles,
  characters,
} from "../server/generation.js";
import { createApp } from "../server/app.js";

function sketch(blank = false) {
  const image = new PNG({ width: 1024, height: 1024 });
  image.data.fill(255);
  if (!blank)
    for (let y = 200; y < 240; y++)
      for (let x = 200; x < 240; x++) {
        const offset = (1024 * y + x) * 4;
        image.data[offset] = 180;
        image.data[offset + 1] = 94;
        image.data[offset + 2] = 48;
      }
  return "data:image/png;base64," + PNG.sync.write(image).toString("base64");
}
const source = sketch();
const body = {
  sketch: source,
  style: "claymation",
  character: "knight",
  keepWeirdness: true,
};
const imageResult = { data: [{ b64_json: source.split(",")[1] }] };
async function serve(t, options = {}) {
  const server = createApp({ apiKey: "server-secret-test-key", ...options });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url,
    post: (payload = body, headers = {}) =>
      fetch(url + "/api/transform", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(payload),
      }),
  };
}

test("every style and role produces specific instructions; weirdness changes preservation", () => {
  for (const style of Object.keys(styles))
    for (const character of Object.keys(characters)) {
      const prompt = buildPrompt({ ...body, style, character });
      assert.ok(prompt.includes(styles[style]));
      assert.ok(prompt.includes(characters[character]));
      assert.match(prompt, /relative eye sizes/);
      assert.match(prompt, /exact framing/);
    }
  const relaxed = buildPrompt({ ...body, keepWeirdness: false });
  assert.match(relaxed, /Gently refine/);
  assert.doesNotMatch(relaxed, /KEEP MY WEIRDNESS/);
});
test("reject malformed, blank, oversized and invalid-dimension input", () => {
  assert.equal(validateRequest(body), body);
  for (const change of [
    { style: "__proto__" },
    { character: "other" },
    { keepWeirdness: "true" },
    { sketch: "data:image/png;base64,AAAA" },
    { sketch: sketch(true) },
    { sketch: "data:image/png;base64," + "A".repeat(1_400_001) },
  ]) {
    assert.throws(
      () => validateRequest({ ...body, ...change }),
      (e) => e.status === 400,
    );
  }
  const bomb = Buffer.from(source.split(",")[1], "base64");
  bomb.writeUInt32BE(100000, 16);
  assert.throws(
    () =>
      validateRequest({
        ...body,
        sketch: "data:image/png;base64," + bomb.toString("base64"),
      }),
    /1024/,
  );
});
test("HTTP integration sends the actual reference and server-only credentials to image edits", async (t) => {
  let calls = 0;
  const app = await serve(t, {
    fetchImpl: async (url, options) => {
      calls++;
      assert.equal(url, "https://api.openai.com/v1/images/edits");
      assert.equal(
        options.headers.Authorization,
        "Bearer server-secret-test-key",
      );
      const sent = JSON.parse(options.body);
      assert.equal(sent.images[0].image_url, source);
      assert.equal(sent.model, "gpt-image-2");
      assert.equal(sent.output_format, "png");
      assert.equal(sent.size, "1024x1024");
      assert.match(sent.prompt, /tiny pumpkin knight/);
      assert.ok(!("input_fidelity" in sent));
      return Response.json(imageResult);
    },
  });
  const config = await fetch(app.url + "/api/config");
  assert.deepEqual(await config.json(), { configured: true });
  const response = await app.post();
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.image, source);
  assert.ok(!JSON.stringify(data).includes("server-secret"));
  assert.equal(calls, 1);
});
test("missing key reports setup without making a provider call", async (t) => {
  const app = await serve(t, {
    apiKey: "",
    fetchImpl: () => {
      throw new Error("Must not call provider");
    },
  });
  assert.deepEqual(await (await fetch(app.url + "/api/config")).json(), {
    configured: false,
  });
  const response = await app.post();
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /server API key/);
});
test("bad HTTP input never invokes the provider", async (t) => {
  const app = await serve(t, {
    fetchImpl: () => {
      throw new Error("Must not call provider");
    },
  });
  assert.equal((await app.post({ ...body, style: "bad" })).status, 400);
  assert.equal(
    (await app.post(body, { Origin: "https://unrelated.example" })).status,
    403,
  );
  assert.equal(
    (await app.post(body, { "Content-Type": "text/plain" })).status,
    415,
  );
  const malformed = await fetch(app.url + "/api/transform", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{",
  });
  assert.equal(malformed.status, 400);
  const oversized = await app.post({ ...body, sketch: "A".repeat(1_600_000) });
  assert.equal(oversized.status, 413);
});
test("provider errors are actionable and do not leak upstream secrets", async () => {
  for (const [upstream, expected] of [
    [400, 422],
    [401, 503],
    [403, 503],
    [429, 429],
    [500, 502],
  ]) {
    await assert.rejects(
      () =>
        generateImage(body, {
          apiKey: "key",
          fetchImpl: async () =>
            Response.json({ error: "secret-detail" }, { status: upstream }),
        }),
      (e) => e.status === expected && !e.message.includes("secret-detail"),
    );
  }
  await assert.rejects(
    () =>
      generateImage(body, {
        apiKey: "key",
        fetchImpl: async () => Response.json({ data: [] }),
      }),
    /no usable image/,
  );
});
test("reject overlapping work and release capacity after success", async (t) => {
  let finish;
  const entered = Promise.withResolvers();
  const app = await serve(t, {
    fetchImpl: () => {
      entered.resolve();
      return new Promise((r) => (finish = () => r(Response.json(imageResult))));
    },
  });
  const pending = app.post();
  await entered.promise;
  assert.equal((await app.post()).status, 429);
  finish();
  assert.equal((await pending).status, 200);
});
test("timeouts abort upstream and return a retryable failure", async (t) => {
  let aborted = false;
  const app = await serve(t, {
    timeoutMs: 20,
    fetchImpl: (_url, { signal }) =>
      new Promise((_, reject) =>
        signal.addEventListener(
          "abort",
          () => {
            aborted = true;
            reject(new DOMException("Aborted", "AbortError"));
          },
          { once: true },
        ),
      ),
  });
  const response = await app.post();
  assert.equal(response.status, 504);
  assert.equal(aborted, true);
  assert.match((await response.json()).error, /too long/);
});
test("client cancellation aborts the provider request", async (t) => {
  const entered = Promise.withResolvers(),
    aborted = Promise.withResolvers();
  const app = await serve(t, {
    fetchImpl: (_url, { signal }) => {
      entered.resolve();
      return new Promise((_, reject) =>
        signal.addEventListener(
          "abort",
          () => {
            aborted.resolve();
            reject(new DOMException("Aborted", "AbortError"));
          },
          { once: true },
        ),
      );
    },
  });
  const controller = new AbortController();
  const pending = fetch(app.url + "/api/transform", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: controller.signal,
  });
  await entered.promise;
  controller.abort();
  await assert.rejects(pending, /abort/i);
  await aborted.promise;
});
test("production serves the app and assets without exposing source or configuration", async (t) => {
  const app = await serve(t);
  const index = await fetch(app.url + "/");
  assert.equal(index.status, 200);
  assert.match(await index.text(), /Pumpkin, Remixed/);
  const image = await fetch(app.url + "/pumpkin-clay.png");
  assert.equal(image.headers.get("Content-Type"), "image/png");
  for (const path of [
    "/.env",
    "/server/generation.js",
    "/missing.png",
    "/%2e%2e%2fpackage.json",
  ])
    assert.equal((await fetch(app.url + path)).status, 404);
});

test("hourly budget prevents additional provider calls once exhausted", async (t) => {
  let calls = 0;
  const app = await serve(t, {
    maxGenerationsPerHour: 1,
    fetchImpl: async () => {
      calls++;
      return Response.json(imageResult);
    },
  });
  assert.equal((await app.post()).status, 200);
  const limited = await app.post();
  assert.equal(limited.status, 429);
  assert.match((await limited.json()).error, /hourly image limit/);
  assert.equal(calls, 1);
});
