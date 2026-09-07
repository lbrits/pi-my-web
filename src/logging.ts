/**
 * Request/error logging + session-start health report.
 *
 * Two JSONL files under ~/.pi/agent/pi-my-web/ (config: `logging.dir`):
 *   requests.jsonl — one line per URL/query outcome (every tool call)
 *   errors.jsonl   — failures only, with a `kind` classification
 *
 * `healthBlock()` renders recent errors.jsonl groups as a compact text block;
 * the extension injects it into the system prompt via before_agent_start so
 * the model (and the user) sees tool trouble even if they never read logs.
 *
 * All functions are best-effort: a logging failure must never break a tool
 * call or the agent loop, so everything is try/caught silently.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { LoggingConfig } from "./types.ts";

export type LogKind =
  | "bot-wall"
  | "timeout"
  | "not-found"
  | "http-error"
  | "network"
  | "backend-down"
  | "usage"
  | "exception";

/** Normalized view of one tool outcome, enough to log it. */
export interface OutcomeInfo {
  url?: string;
  query?: string;
  ok: boolean;
  status?: number;
  blocked?: boolean;
  reason?: string;
  stage?: string | number;
  ms?: number;
  /** caller-classified kind (e.g. "usage"); overrides inference for failures */
  kind?: LogKind;
}

export function logDir(dir: string | null): string {
  return dir ?? join(homedir(), ".pi", "agent", "pi-my-web");
}

function requestsPath(cfg: LoggingConfig): string {
  return join(logDir(cfg.dir), "requests.jsonl");
}

function errorsPath(cfg: LoggingConfig): string {
  return join(logDir(cfg.dir), "errors.jsonl");
}

let lastPrune = 0;

/** Prune both logs to retentionDays, at most once a day per process. */
function maybePrune(cfg: LoggingConfig): void {
  const now = Date.now();
  if (now - lastPrune < 24 * 3600 * 1000) return;
  lastPrune = now;
  const cutoff = now - cfg.retentionDays * 86400 * 1000;
  for (const name of ["requests.jsonl", "errors.jsonl"]) {
    const p = join(logDir(cfg.dir), name);
    if (!existsSync(p)) continue;
    const keep = readFileSync(p, "utf8")
      .split("\n")
      .filter((line) => {
        if (!line.trim()) return false;
        try {
          return new Date(JSON.parse(line).t).getTime() >= cutoff;
        } catch {
          return false;
        }
      });
    try {
      writeFileSync(p, keep.join("\n") + (keep.length ? "\n" : ""));
    } catch {
      /* best effort */
    }
  }
}

function appendLine(cfg: LoggingConfig, file: "requests.jsonl" | "errors.jsonl", entry: unknown): void {
  const dir = logDir(cfg.dir);
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, file), JSON.stringify(entry) + "\n");
}

function targetOf(o: OutcomeInfo): string {
  return o.url ?? o.query ?? "";
}

/**
 * Classify a failed outcome into a LogKind when the caller didn't supply one.
 * Order matters: wall > not-found > timeout > status-based > transport.
 */
export function classifyFailure(tool: string, o: OutcomeInfo): LogKind {
  if (o.blocked || /wall|challenge|captcha/i.test(o.reason ?? "")) return "bot-wall";
  if (o.status === 404) return "not-found";
  if (/time[d ]?out|abort/i.test(o.reason ?? "")) return "timeout";
  if (typeof o.status === "number") return "http-error";
  return tool === "web_search" ? "backend-down" : "network";
}

/**
 * Record one outcome. Writes to requests.jsonl (if `logging.requests`) and,
 * for failures, to errors.jsonl (if `logging.errors`). Never throws.
 */
export function recordOutcome(cfg: LoggingConfig, tool: string, o: OutcomeInfo): void {
  try {
    if (!cfg.requests && !cfg.errors) return;
    maybePrune(cfg);
    const t = new Date().toISOString();
    if (cfg.requests) {
      appendLine(cfg, "requests.jsonl", {
        t,
        tool,
        target: targetOf(o),
        ok: o.ok,
        status: o.status,
        blocked: o.blocked,
        stage: o.stage,
        ms: o.ms,
      });
    }
    if (!o.ok && cfg.errors) {
      const kind = o.kind ?? classifyFailure(tool, o);
      appendLine(cfg, "errors.jsonl", {
        t,
        tool,
        target: targetOf(o),
        kind,
        status: o.status,
        detail: (o.reason ?? "").slice(0, 500) || undefined,
      });
    }
  } catch {
    /* logging must never break the tool */
  }
}

/** Record an explicitly classified failure (usage errors, exceptions). */
export function recordError(
  cfg: LoggingConfig,
  tool: string,
  target: string,
  kind: LogKind,
  detail: string,
): void {
  try {
    if (!cfg.errors) return;
    maybePrune(cfg);
    appendLine(cfg, "errors.jsonl", {
      t: new Date().toISOString(),
      tool,
      target,
      kind,
      detail: detail.slice(0, 500),
    });
  } catch {
    /* best effort */
  }
}

export interface HealthGroup {
  tool: string;
  kind: LogKind;
  count: number;
  last: string;
  sample: string;
}

function readEntries(cfg: LoggingConfig): Record<string, unknown>[] {
  const p = errorsPath(cfg);
  if (!existsSync(p)) return [];
  const out: Record<string, unknown>[] = [];
  for (const line of readFileSync(p, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* skip corrupt line */
    }
  }
  return out;
}

/** Group errors within healthWindowDays by (tool, kind), newest group first. */
export function recentErrorGroups(cfg: LoggingConfig): HealthGroup[] {
  const cutoff = Date.now() - cfg.healthWindowDays * 86400 * 1000;
  const groups = new Map<string, HealthGroup>();
  for (const e of readEntries(cfg)) {
    const t = new Date(String(e.t)).getTime();
    if (Number.isNaN(t) || t < cutoff) continue;
    const key = `${e.tool}|${e.kind}`;
    const g = groups.get(key);
    const sample =
      [e.target, e.detail ? String(e.detail).slice(0, 80) : null].filter(Boolean).join(" — ");
    if (g) {
      g.count++;
      if (String(e.t) > g.last) {
        g.last = String(e.t);
        g.sample = sample;
      }
    } else {
      groups.set(key, {
        tool: String(e.tool),
        kind: String(e.kind) as LogKind,
        count: 1,
        last: String(e.t),
        sample,
      });
    }
  }
  return [...groups.values()].sort((a, b) => b.last.localeCompare(a.last));
}

/**
 * Compact health block for system-prompt injection, or undefined when there is
 * nothing to report. The leading marker line doubles as the dedupe token the
 * before_agent_start handler checks for.
 */
export function healthBlock(cfg: LoggingConfig): string | undefined {
  if (!cfg.healthReport) return undefined;
  try {
    // 404s stay in errors.jsonl but don't nag: a missing page is a content
    // miss, not a broken tool.
    const groups = recentErrorGroups(cfg).filter((g) => g.kind !== "not-found");
    if (groups.length === 0) return undefined;
    const lines = groups
      .slice(0, 6)
      .map(
        (g) =>
          `- ${g.tool}: ${g.count}× ${g.kind} (latest ${g.last.slice(5, 16).replace("T", " ")}${
            g.sample ? `, e.g. ${g.sample.slice(0, 90)}` : ""
          })`,
      );
    return (
      "pi-my-web health — recent web tool failures (last " +
      `${cfg.healthWindowDays} days; full log ${errorsPath(cfg)}):` +
      "\n" +
      lines.join("\n")
    );
  } catch {
    return undefined;
  }
}
