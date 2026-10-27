import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { GenerationError } from "./generation.js";

export function dailyTokenLimit(raw = process.env.GENERATION_MAX_DAILY_TOKENS) {
  if (raw === undefined || raw.trim() === "") return 60_000;
  if (!/^\d+$/.test(raw.trim()) || !Number.isSafeInteger(Number(raw))) {
    throw new Error(
      "GENERATION_MAX_DAILY_TOKENS must be a nonnegative integer.",
    );
  }
  return Number(raw);
}

export function observedTokens(usage) {
  if (
    !usage ||
    ![usage.input_tokens, usage.output_tokens].every(
      (n) => Number.isSafeInteger(n) && n >= 0,
    )
  )
    return null;
  const total = usage.input_tokens + usage.output_tokens;
  if (
    !Number.isSafeInteger(total) ||
    (usage.total_tokens !== undefined && usage.total_tokens !== total)
  )
    return null;
  // Cached input and reasoning are already part of input/output: never add them again.
  return { input: usage.input_tokens, output: usage.output_tokens, total };
}

// One server process, matching the studio's existing single-request gate.
// Persist the uncertainty marker before dispatch, so crashes cannot silently reset usage.
export function createDailyBudget({
  limit = dailyTokenLimit(),
  file = process.env.GENERATION_USAGE_FILE ||
    resolve(".data/generation-usage.json"),
  now = () => new Date(),
  log = console.info,
} = {}) {
  if (!Number.isSafeInteger(limit) || limit < 0)
    throw new Error(
      "GENERATION_MAX_DAILY_TOKENS must be a nonnegative integer.",
    );
  let state;
  function save() {
    try {
      mkdirSync(dirname(file), { recursive: true });
      const temporary = `${file}.${process.pid}.tmp`;
      writeFileSync(temporary, JSON.stringify(state) + "\n", { mode: 0o600 });
      renameSync(temporary, file);
    } catch {
      throw new GenerationError(
        503,
        "The studio could not save its token budget. Generation is paused.",
      );
    }
  }
  function begin() {
    if (!limit) return;
    const date = now().toISOString().slice(0, 10);
    try {
      state = JSON.parse(readFileSync(file, "utf8"));
      if (
        state.version !== 1 ||
        !/^\d{4}-\d{2}-\d{2}$/.test(state.date) ||
        new Date(state.date + "T00:00:00Z").toISOString().slice(0, 10) !==
          state.date ||
        !Number.isSafeInteger(state.totalTokens) ||
        state.totalTokens < 0 ||
        typeof state.uncertain !== "boolean"
      )
        throw new Error();
    } catch (error) {
      if (error.code !== "ENOENT")
        throw new GenerationError(
          503,
          "The studio could not read its token budget. Generation is paused.",
        );
      state = { version: 1, date, totalTokens: 0, uncertain: false };
    }
    if (state.date !== date)
      state = { version: 1, date, totalTokens: 0, uncertain: false };
    if (state.uncertain)
      throw new GenerationError(
        503,
        "A previous image request has unconfirmed token usage. Generation is paused until the next UTC day.",
      );
    if (state.totalTokens >= limit)
      throw new GenerationError(
        429,
        "This studio reached its daily token budget. Come back after midnight UTC.",
      );
    state.uncertain = true;
    save();
  }
  function record(raw) {
    const usage = observedTokens(raw);
    if (limit && usage) {
      state.totalTokens = Math.min(
        Number.MAX_SAFE_INTEGER,
        state.totalTokens + usage.total,
      );
      state.uncertain = false;
      save();
    }
    log(
      `Pumpkin AI usage (observed): input_tokens=${usage?.input ?? "unknown"} output_tokens=${usage?.output ?? "unknown"} total_tokens=${usage?.total ?? "unknown"} daily_total_tokens=${limit ? state.totalTokens : "untracked"} usage_complete=${Boolean(usage)}`,
    );
  }
  return { begin, record };
}
