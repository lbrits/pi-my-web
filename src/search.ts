import type { PiMyWebConfig, QueryOutcome, SearchConfig, SearchResult } from "./types.ts";
import { searchSearxngJson, type SearxngQueryOpts } from "./searxng.ts";

export interface SearchOptions {
  query: string;
  numResults: number;
  timeRange?: string;
  domainFilter?: string[];
  signal?: AbortSignal;
}

// Adapter registry. Adding a provider = add a function here (thin interface:
// baseUrl + query opts in, normalized SearchResult[] out). The tool schema
// stays provider-agnostic on purpose (no `provider` parameter).
const ADAPTERS: Record<string, (baseUrl: string, opts: SearxngQueryOpts, env: { timeoutMs: number; userAgent: string; signal?: AbortSignal }) => Promise<SearchResult[]>> = {
  "searxng-json": searchSearxngJson,
};

// In-memory health state per backend name (per pi process).
const health = new Map<string, { failedAt: number; error: string }>();

function isHealthy(cfg: SearchConfig, name: string): boolean {
  const h = health.get(name);
  return !h || Date.now() - h.failedAt > cfg.healthCooldownMs;
}

export function hostMatch(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

/**
 * Post-filter results by domain/host. Entries: "example.com" (include, matches
 * the host itself and subdomains); "-example.com" (exclude). A result must
 * match at least one include entry (if any) and no exclude entry.
 */
export function applyDomainFilter(results: SearchResult[], filter?: string[]): SearchResult[] {
  if (!filter || filter.length === 0) return results;
  const includes = filter.map((e) => e.trim().toLowerCase()).filter((e) => e && !e.startsWith("-"));
  const excludes = filter.map((e) => e.trim().toLowerCase()).filter((e) => e.startsWith("-")).map((e) => e.slice(1));
  return results.filter((r) => {
    let host: string;
    try {
      host = new URL(r.url).hostname.toLowerCase();
    } catch {
      return false;
    }
    for (const d of excludes) if (hostMatch(host, d)) return false;
    if (includes.length > 0) {
      if (!includes.some((d) => hostMatch(host, d))) return false;
    }
    return true;
  });
}

export async function runQuery(cfg: SearchConfig, opts: SearchOptions): Promise<QueryOutcome> {
  const errors: string[] = [];
  for (const be of cfg.backends) {
    if (!isHealthy(cfg, be.name)) {
      errors.push(`${be.name}: cooling down (${health.get(be.name)?.error})`);
      continue;
    }
    const adapter = ADAPTERS[be.adapter];
    if (!adapter) {
      errors.push(`${be.name}: unknown adapter '${be.adapter}'`);
      continue;
    }
    try {
      const raw = await adapter(be.baseUrl, { query: opts.query, timeRange: opts.timeRange }, {
        timeoutMs: cfg.timeoutMs,
        userAgent:
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        signal: opts.signal,
      });
      health.delete(be.name);
      const results = applyDomainFilter(raw, opts.domainFilter).slice(0, opts.numResults);
      return { query: opts.query, ok: true, backend: be.name, results };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      health.set(be.name, { failedAt: Date.now(), error: msg });
      errors.push(`${be.name}: ${msg}`);
    }
  }
  return {
    query: opts.query,
    ok: false,
    results: [],
    error: errors.length > 0 ? errors.join("; ") : "no search backends configured",
  };
}

export async function searchAll(
  cfg: PiMyWebConfig,
  opts: Omit<SearchOptions, "query"> & { queries: string[] },
): Promise<QueryOutcome[]> {
  return Promise.all(
    opts.queries.map((q) => runQuery(cfg.search, { ...opts, query: q, signal: opts.signal })),
  );
}

export function formatSearchResults(outcomes: QueryOutcome[]): string {
  return outcomes
    .map((o) => {
      const head = o.ok ? `## ${o.query}\n(backend: ${o.backend})` : `## ${o.query}\nERROR: ${o.error}`;
      if (o.results.length === 0) return `${head}\n(no results)`;
      const body = o.results
        .map((r, i) => {
          const snippet = r.snippet ? ` — ${r.snippet}` : "";
          return `${i + 1}. ${r.title || r.url}\n   ${r.url}${snippet}`;
        })
        .join("\n");
      return `${head}\n${body}`;
    })
    .join("\n\n");
}
