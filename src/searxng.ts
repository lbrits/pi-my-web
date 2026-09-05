import type { SearchResult } from "./types.ts";

export interface SearxngQueryOpts {
  query: string;
  timeRange?: string; // "day" | "week" | "month" | "year"
}

/**
 * The one adapter for now: SearXNG with the JSON format enabled.
 * Returns the full result list (typically ~30); the caller filters/slices.
 */
export async function searchSearxngJson(
  baseUrl: string,
  opts: SearxngQueryOpts,
  env: { timeoutMs: number; userAgent: string; signal?: AbortSignal },
): Promise<SearchResult[]> {
  const endpoint = new URL("/search", baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  endpoint.searchParams.set("q", opts.query);
  endpoint.searchParams.set("format", "json");
  if (opts.timeRange) endpoint.searchParams.set("time_range", opts.timeRange);

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error(`timeout after ${env.timeoutMs}ms`)),
    env.timeoutMs,
  );
  const onOuter = () => controller.abort();
  env.signal?.addEventListener("abort", onOuter, { once: true });
  try {
    const res = await fetch(endpoint, {
      signal: controller.signal,
      headers: { accept: "application/json", "user-agent": env.userAgent },
    });
    if (!res.ok) {
      throw new Error(`SearXNG HTTP ${res.status} ${res.statusText}`.trim());
    }
    const data = (await res.json()) as { results?: Array<Record<string, unknown>> };
    if (!Array.isArray(data.results)) {
      throw new Error("SearXNG response has no results[] (is format=json enabled?)");
    }
    return data.results
      .map((r) => ({
        title: String(r.title ?? ""),
        url: String(r.url ?? ""),
        snippet: String(r.content ?? "").replace(/\s+/g, " ").trim().slice(0, 500),
        engine: r.engine ? String(r.engine) : undefined,
      }))
      .filter((r) => r.url);
  } finally {
    clearTimeout(timer);
    env.signal?.removeEventListener("abort", onOuter);
  }
}
