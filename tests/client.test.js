import { test, after } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost",
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, "navigator", {
  value: dom.window.navigator,
  configurable: true,
});
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { renderHook, act, waitFor, cleanup } =
  await import("@testing-library/react");
const { useGeneration, signatureFor, matchingResult } =
  await import("../src/generation.js");
const originalFetch = globalThis.fetch;
after(() => {
  globalThis.fetch = originalFetch;
  dom.window.close();
});
const source = "data:image/png;base64,c2tldGNo";
const output = "data:image/png;base64,b3V0cHV0";
let flattened = false;
dom.window.HTMLCanvasElement.prototype.getContext = () => ({
  set fillStyle(value) {
    assert.equal(value, "#fcfaf5");
  },
  fillRect: () => {
    flattened = true;
  },
  drawImage: () => assert.equal(flattened, true),
});
dom.window.HTMLCanvasElement.prototype.toDataURL = function () {
  assert.equal(this.width, 1024);
  assert.equal(this.height, 1024);
  return source;
};
const initial = {
  paths: [
    {
      color: "#b85e30",
      size: 3,
      points: [
        [5, 5],
        [20, 30],
      ],
    },
  ],
  weird: true,
  character: "knight",
  canvas: { current: document.createElement("canvas") },
  style: 0,
};
function setup(handler, props = initial) {
  globalThis.fetch = async (url, options) =>
    url === "/api/config"
      ? Response.json({ configured: true })
      : handler(url, options);
  return renderHook((p) => useGeneration(p), { initialProps: props });
}
test("snapshot identity includes geometry, character and weirdness", () => {
  const signature = signatureFor(initial.paths, true, "knight");
  const results = { 0: { signature, image: output } };
  assert.ok(matchingResult(results, 0, signature));
  for (const other of [
    signatureFor([], true, "knight"),
    signatureFor(initial.paths, false, "knight"),
    signatureFor(initial.paths, true, "swamp"),
  ])
    assert.equal(matchingResult(results, 0, other), null);
  assert.equal(matchingResult(results, 1, signature), null);
});
test("generation exports the drawing and sends selected settings, then exposes the actual output", async () => {
  const hook = setup(async (url, options) => {
    assert.equal(url, "/api/transform");
    assert.deepEqual(JSON.parse(options.body), {
      sketch: source,
      style: "claymation",
      character: "knight",
      keepWeirdness: true,
    });
    assert.equal(options.headers.Authorization, undefined);
    return Response.json({ image: output });
  });
  await waitFor(() => assert.equal(hook.result.current.configured, true));
  await act(() => hook.result.current.transform());
  assert.equal(hook.result.current.selected.image, output);
  assert.equal(hook.result.current.selected.source, source);
  assert.equal(hook.result.current.busy, false);
  cleanup();
});
test("a late response cannot be paired with an edited sketch or different settings", async () => {
  let finish;
  const hook = setup(() => new Promise((r) => (finish = r)));
  await waitFor(() => assert.equal(hook.result.current.configured, true));
  let pending;
  act(() => {
    pending = hook.result.current.transform();
  });
  hook.rerender({
    ...initial,
    paths: [
      {
        ...initial.paths[0],
        points: [
          [100, 100],
          [200, 200],
        ],
      },
    ],
    weird: false,
  });
  await act(async () => {
    finish(Response.json({ image: output }));
    await pending;
  });
  assert.equal(hook.result.current.selected, null);
  hook.rerender(initial);
  assert.equal(hook.result.current.selected.image, output);
  hook.rerender({ ...initial, character: "explorer" });
  assert.equal(hook.result.current.selected, null);
  cleanup();
});
test("a failed retry keeps the previous generated image and the error can be retried", async () => {
  let count = 0;
  const hook = setup(async () =>
    ++count === 2
      ? Response.json({ error: "Try again shortly." }, { status: 429 })
      : Response.json({ image: output }),
  );
  await waitFor(() => assert.equal(hook.result.current.configured, true));
  await act(() => hook.result.current.transform());
  await act(() => hook.result.current.transform());
  assert.equal(hook.result.current.error, "Try again shortly.");
  assert.equal(hook.result.current.selected.image, output);
  assert.equal(hook.result.current.busy, false);
  await act(() => hook.result.current.transform());
  assert.equal(hook.result.current.error, "");
  cleanup();
});
test("gallery batch stops on failure, retains successes, and retries only missing styles", async () => {
  let calls = [];
  let fail = true;
  const hook = setup(async (_url, options) => {
    const style = JSON.parse(options.body).style;
    calls.push(style);
    return fail && style === "watercolor"
      ? Response.json({ error: "Busy" }, { status: 429 })
      : Response.json({ image: output });
  });
  await waitFor(() => assert.equal(hook.result.current.configured, true));
  await act(() => hook.result.current.transform(true));
  assert.deepEqual(calls, ["claymation", "watercolor"]);
  assert.equal(Object.keys(hook.result.current.results).length, 1);
  fail = false;
  calls = [];
  await act(() => hook.result.current.transform(true));
  assert.deepEqual(calls, ["watercolor", "cinematic", "crochet"]);
  assert.equal(Object.keys(hook.result.current.results).length, 4);
  cleanup();
});
test("cancel aborts generation and duplicate clicks do not create extra calls", async () => {
  let calls = 0;
  const hook = setup((_url, { signal }) => {
    calls++;
    return new Promise((_, reject) =>
      signal.addEventListener(
        "abort",
        () => reject(new DOMException("Aborted", "AbortError")),
        { once: true },
      ),
    );
  });
  await waitFor(() => assert.equal(hook.result.current.configured, true));
  let first;
  act(() => {
    first = hook.result.current.transform();
    hook.result.current.transform();
  });
  assert.equal(calls, 1);
  assert.equal(hook.result.current.busy, true);
  await act(async () => {
    hook.result.current.cancel();
    await first;
  });
  assert.equal(hook.result.current.busy, false);
  assert.equal(hook.result.current.error, "");
  assert.equal(hook.result.current.selected, null);
  cleanup();
});
test("an empty sketch never starts a paid request", async () => {
  let calls = 0;
  const hook = setup(
    () => {
      calls++;
      return Response.json({ image: output });
    },
    { ...initial, paths: [] },
  );
  await waitFor(() => assert.equal(hook.result.current.configured, true));
  await act(() => hook.result.current.transform());
  assert.equal(calls, 0);
  assert.match(hook.result.current.error, /scribble/);
  cleanup();
});
