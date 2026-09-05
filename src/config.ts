import { existsSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { PiMyWebConfig } from "./types.ts";

export const CONFIG_PATH: string =
  process.env.PI_MY_WEB_CONFIG ?? join(homedir(), ".pi", "agent", "pi-my-web.json");

const DEFAULT_CONFIG: PiMyWebConfig = {
  search: {
    backends: [
      { name: "searxng-local", adapter: "searxng-json", baseUrl: "http://192.168.8.231:9009" },
    ],
    timeoutMs: 20000,
    healthCooldownMs: 5 * 60 * 1000,
  },
  fetch: {
    userAgent:
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    timeoutMs: 30000,
    maxResponseBytes: 10 * 1024 * 1024,
    maxInlineChars: 15000,
    maxPdfPages: 100,
    offloadMinChars: 2000,
    offloadDir: join(tmpdir(), "pi-my-web"),
  },
};

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function merge<T>(base: T, override: unknown): T {
  if (!isObj(base) || !isObj(override)) {
    return (override === undefined ? base : (override as T)) as T;
  }
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(override)) {
    out[k] = k in base && isObj((base as Record<string, unknown>)[k])
      ? merge((base as Record<string, unknown>)[k] as never, v)
      : v;
  }
  return out as T;
}

/**
 * Load config: built-in defaults, deep-merged with the per-user config file
 * (~/.pi/agent/pi-my-web.json, or $PI_MY_WEB_CONFIG). Read fresh on every call
 * so config edits apply without a /reload. Throws a descriptive error on a
 * malformed config file (fail loud).
 */
export function loadConfig(): PiMyWebConfig {
  let user: unknown = {};
  if (existsSync(CONFIG_PATH)) {
    try {
      user = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    } catch (err) {
      throw new Error(
        `pi-my-web: cannot parse config ${CONFIG_PATH}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return merge(DEFAULT_CONFIG, user);
}
