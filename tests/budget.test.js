import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import {
  createDailyBudget,
  dailyTokenLimit,
  observedTokens,
} from "../server/budget.js";

function fixture(t) {
  mkdirSync(".scratch", { recursive: true });
  const directory = mkdtempSync(resolve(".scratch/token-budget-"));
  t.after(() => rmSync(directory, { recursive: true }));
  let clock = new Date("2026-10-27T12:00:00Z");
  const messages = [];
  const options = {
    limit: 60_000,
    file: resolve(directory, "usage.json"),
    now: () => clock,
    log: (message) => messages.push(message),
  };
  return {
    options,
    messages,
    setDate: (date) => (clock = new Date(date)),
    read: () => JSON.parse(readFileSync(options.file, "utf8")),
  };
}

test("strict token limit config defaults to 60000 and permits explicit disabling", () => {
  for (const value of ["", "   "]) assert.equal(dailyTokenLimit(value), 60_000);
  assert.equal(dailyTokenLimit("60000"), 60_000);
  assert.equal(dailyTokenLimit("0"), 0);
  for (const value of [
    "-1",
    "NaN",
    "1e4",
    "Infinity",
    "1.5",
    "9007199254740992",
  ])
    assert.throws(() => dailyTokenLimit(value), /nonnegative integer/);
  for (const value of [-1, NaN, Infinity, 1.5])
    assert.throws(
      () => createDailyBudget({ limit: value }),
      /nonnegative integer/,
    );
});
test("reported input and output include cached input and reasoning without double counting", () => {
  assert.deepEqual(
    observedTokens({
      input_tokens: 40000,
      output_tokens: 20000,
      total_tokens: 60000,
      input_tokens_details: { cached_tokens: 20000 },
      output_tokens_details: { reasoning_tokens: 10000 },
    }),
    { input: 40000, output: 20000, total: 60000 },
  );
  for (const usage of [
    undefined,
    {},
    { input_tokens: "5", output_tokens: 1 },
    { input_tokens: -1, output_tokens: 5 },
    { input_tokens: 0.5, output_tokens: 1 },
    { input_tokens: 1, output_tokens: 1, total_tokens: 99 },
    { input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: 1 },
  ])
    assert.equal(observedTokens(usage), null);
});
test("daily total persists across instances and reaching the threshold stops another request", (t) => {
  const f = fixture(t);
  let budget = createDailyBudget(f.options);
  budget.begin();
  budget.record({ input_tokens: 20000, output_tokens: 10000 });
  assert.equal(f.read().totalTokens, 30000);
  assert.equal(f.read().uncertain, false);
  budget = createDailyBudget(f.options);
  budget.begin();
  budget.record({ input_tokens: 25000, output_tokens: 5000 });
  assert.equal(f.read().totalTokens, 60000);
  assert.throws(
    () => createDailyBudget(f.options).begin(),
    (e) => e.status === 429,
  );
  assert.match(
    f.messages.at(-1),
    /daily_total_tokens=60000 usage_complete=true/,
  );
});
test("an allowed image may overshoot, but there is no subsequent call", (t) => {
  const f = fixture(t);
  const budget = createDailyBudget(f.options);
  budget.begin();
  budget.record({ input_tokens: 50000, output_tokens: 20000 });
  assert.equal(f.read().totalTokens, 70000);
  assert.throws(() => budget.begin(), /daily token budget/);
});
test("budget resets at midnight UTC, not on restart", (t) => {
  const f = fixture(t);
  const budget = createDailyBudget(f.options);
  budget.begin();
  budget.record({ input_tokens: 60000, output_tokens: 1 });
  f.setDate("2026-10-27T23:59:59Z");
  assert.throws(() => budget.begin(), /daily token budget/);
  f.setDate("2026-10-28T00:00:00Z");
  budget.begin();
  budget.record({ input_tokens: 15, output_tokens: 5 });
  assert.deepEqual(f.read(), {
    version: 1,
    date: "2026-10-28",
    totalTokens: 20,
    uncertain: false,
  });
});
test("missing or malformed usage blocks continuation and is never counted as zero", (t) => {
  const f = fixture(t);
  const budget = createDailyBudget(f.options);
  budget.begin();
  budget.record({ input_tokens: 20 });
  assert.equal(f.read().uncertain, true);
  assert.match(f.messages[0], /total_tokens=unknown/);
  assert.throws(
    () => createDailyBudget(f.options).begin(),
    /unconfirmed token usage/,
  );
  f.setDate("2026-10-28T00:00:00Z");
  budget.begin();
  budget.record({ input_tokens: 10, output_tokens: 5 });
  assert.equal(f.read().uncertain, false);
});
test("crash, cancellation or provider failure retains the pending marker across restart", (t) => {
  const f = fixture(t);
  createDailyBudget(f.options).begin();
  assert.equal(f.read().uncertain, true);
  assert.throws(
    () => createDailyBudget(f.options).begin(),
    /unconfirmed token usage/,
  );
});
test("corrupt or unwritable storage fails closed before a provider call can start", (t) => {
  const f = fixture(t);
  writeFileSync(f.options.file, "not json");
  assert.throws(() => createDailyBudget(f.options).begin(), /could not read/);
  writeFileSync(
    f.options.file,
    JSON.stringify({
      version: 1,
      date: "2026-99-99",
      totalTokens: 0,
      uncertain: false,
    }),
  );
  assert.throws(() => createDailyBudget(f.options).begin(), /could not read/);
  // A regular file cannot be used as the parent of the usage ledger.
  assert.throws(
    () =>
      createDailyBudget({
        ...f.options,
        file: f.options.file + "/usage.json",
      }).begin(),
    /could not read/,
  );
  const writeFailure = resolve(f.options.file, "..", "write-failure.json");
  mkdirSync(`${writeFailure}.${process.pid}.tmp`);
  assert.throws(
    () => createDailyBudget({ ...f.options, file: writeFailure }).begin(),
    /could not save/,
  );
  const blocked = resolve(f.options.file, "..", "directory.json");
  mkdirSync(blocked);
  assert.throws(
    () => createDailyBudget({ ...f.options, file: blocked }).begin(),
    /could not read/,
  );
});
test("disabling the threshold requires no ledger and still logs observed usage", (t) => {
  const f = fixture(t);
  const budget = createDailyBudget({
    ...f.options,
    limit: 0,
    file: "/not-a-real-writable-directory/usage.json",
  });
  budget.begin();
  budget.record({ input_tokens: 3, output_tokens: 7 });
  budget.begin();
  assert.match(f.messages[0], /total_tokens=10 daily_total_tokens=untracked/);
});
