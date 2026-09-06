import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config.ts";
import { searchAll, formatSearchResults } from "./search.ts";
import { fetchAll, formatFetchResults } from "./fetcher.ts";
import { browse } from "./browse.ts";

const timeRangeEnum = Type.Union([
  Type.Literal("day"),
  Type.Literal("week"),
  Type.Literal("month"),
  Type.Literal("year"),
]);

const fetchModeEnum = Type.Union([Type.Literal("overview"), Type.Literal("raw")]);

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description:
      "Search the web (SearXNG; backends from config). Prefer 1-4 parallel varied queries. " +
      "Returns titles/URLs/snippets — use web_fetch to read a page.",
    promptSnippet: "Search the web (SearXNG)",
    parameters: Type.Object({
      query: Type.Optional(Type.String({ description: "A single search query." })),
      queries: Type.Optional(
        Type.Array(Type.String(), {
          minItems: 1,
          maxItems: 4,
          description: "Multiple queries run in parallel. For research, prefer 2-4 varied angles.",
        }),
      ),
      numResults: Type.Optional(
        Type.Integer({ minimum: 1, maximum: 20, description: "Results per query (default 5)." }),
      ),
      timeRange: Type.Optional(timeRangeEnum, { description: "Recency filter." }),
      domainFilter: Type.Optional(
        Type.Array(Type.String(), {
          description: "Restrict to these domains/hosts; prefix '-' to exclude a domain.",
        }),
      ),
    }),
    async execute(
      _toolCallId: string,
      params: any,
      signal: AbortSignal | undefined,
      _onUpdate?: unknown,
      _ctx?: unknown,
    ) {
      try {
        const queries: string[] | undefined =
          params.queries ?? (params.query ? [params.query] : undefined);
        if (!queries || queries.length === 0) {
          return {
            content: [{ type: "text" as const, text: "web_search: provide `query` or `queries`." }],
            details: { error: "missing query" },
          };
        }
        const cfg = loadConfig();
        const outcomes = await searchAll(cfg, {
          queries,
          numResults: params.numResults ?? 5,
          timeRange: params.timeRange,
          domainFilter: params.domainFilter,
          signal,
        });
        return {
          content: [{ type: "text" as const, text: formatSearchResults(outcomes) }],
          details: {
            queries: outcomes.map((o) => ({
              query: o.query,
              ok: o.ok,
              backend: o.backend,
              results: o.results.length,
            })),
          },
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `web_search error: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          details: { error: String(err) },
        };
      }
    },
  });

  pi.registerTool({
    name: "web_fetch",
    label: "Web Fetch",
    description:
      "Fetch URL(s) as readable content (HTML→markdown, PDFs, images as attachments). Long content returns a type-aware " +
      "overview (metadata/abstract for arXiv/PubMed/Wikipedia, section outline with line numbers) with full text offloaded " +
      "to a temp file — page it with the read tool (offset = line number). mode:'raw' = first-N-chars window. " +
      "Bot-walled sites return a blocked result.",
    promptSnippet: "Fetch URL(s) as markdown (HTML/PDF/images)",
    parameters: Type.Object({
      url: Type.Optional(Type.String({ description: "URL to fetch." })),
      urls: Type.Optional(
        Type.Array(Type.String(), {
          minItems: 1,
          maxItems: 5,
          description: "Multiple URLs fetched in parallel (max 5).",
        }),
      ),
      raw: Type.Optional(
        Type.Boolean({ description: "Skip readability extraction; return the raw body as text." }),
      ),
      maxChars: Type.Optional(
        Type.Integer({
          minimum: 500,
          maximum: 100000,
          description: "Inline character cap (default 15000).",
        }),
      ),
      mode: Type.Optional(
        fetchModeEnum,
        {
          description:
            "'overview' (default, type-aware bird's-eye view + offloaded full text) or 'raw' (first-N-chars window).",
        },
      ),
    }),
    async execute(
      _toolCallId: string,
      params: any,
      signal: AbortSignal | undefined,
      _onUpdate?: unknown,
      _ctx?: unknown,
    ) {
      try {
        const urls: string[] | undefined = params.urls ?? (params.url ? [params.url] : undefined);
        if (!urls || urls.length === 0) {
          return {
            content: [{ type: "text" as const, text: "web_fetch: provide `url` or `urls`." }],
            details: { error: "missing url" },
          };
        }
        const cfg = loadConfig();
        const outcomes = await fetchAll(cfg.fetch, urls, { raw: params.raw, signal });
        const mode: "overview" | "raw" = params.mode === "raw" ? "raw" : "overview";
        const text = formatFetchResults(outcomes, params.maxChars ?? cfg.fetch.maxInlineChars, mode);
        return {
          content: [
            { type: "text" as const, text },
            ...outcomes
              .filter((o) => o.image)
              .map((o) => ({
                type: "image" as const,
                data: o.image!.data,
                mimeType: o.image!.mimeType,
              })),
          ],
          details: {
            results: outcomes.map((o) => ({
              url: o.url,
              ok: o.ok,
              status: o.status,
              blocked: o.blocked,
              kind: o.kind,
              offload: o.offload,
              chars: o.content?.length,
            })),
          },
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `web_fetch error: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          details: { error: String(err) },
        };
      }
    },
  });

  pi.registerTool({
    name: "web_browse",
    label: "Web Browse",
    description:
      "Browse a URL in a real Firefox (Playwright, persistent profile). Use when web_fetch returns " +
      "BLOCKED (bot wall / JS-required). If a challenge persists, a visible window opens and waits " +
      "up to 2 min for the user to clear it. Same result shape as web_fetch.",
    promptSnippet: "Browse URL in real Firefox (wall-breaker)",
    parameters: Type.Object({
      url: Type.String({ description: "URL to browse in a real browser." }),
      raw: Type.Optional(
        Type.Boolean({ description: "Skip readability extraction; return rendered HTML as text." }),
      ),
      maxChars: Type.Optional(
        Type.Integer({ minimum: 500, maximum: 100000, description: "Inline character cap (default 15000)." }),
      ),
      mode: Type.Optional(
        fetchModeEnum,
        { description: "'overview' (default) or 'raw' (first-N-chars window)." },
      ),
    }),
    async execute(
      _toolCallId: string,
      params: any,
      signal: AbortSignal | undefined,
      _onUpdate?: unknown,
      _ctx?: unknown,
    ) {
      try {
        if (!params.url) {
          return {
            content: [{ type: "text" as const, text: "web_browse: provide `url`." }],
            details: { error: "missing url" },
          };
        }
        const cfg = loadConfig();
        const o = await browse(cfg, params.url, { raw: params.raw === true, signal });
        const mode: "overview" | "raw" = params.mode === "raw" ? "raw" : "overview";
        const text = formatFetchResults([o], params.maxChars ?? cfg.fetch.maxInlineChars, mode);
        return {
          content: [{ type: "text" as const, text }],
          details: {
            url: o.url,
            ok: o.ok,
            status: o.status,
            blocked: o.blocked,
            kind: o.kind,
            stage: o.stage,
            challengeCleared: o.challengeCleared,
            offload: o.offload,
            chars: o.content?.length,
          },
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `web_browse error: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          details: { error: String(err) },
        };
      }
    },
  });
}
