import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config.ts";
import { searchAll, formatSearchResults } from "./search.ts";
import { fetchAll, formatFetchResults } from "./fetcher.ts";

const timeRangeEnum = Type.Union([
  Type.Literal("day"),
  Type.Literal("week"),
  Type.Literal("month"),
  Type.Literal("year"),
]);

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description:
      "Search the web (SearXNG; backends from config are tried in order with automatic fallback). " +
      "Give 1-4 queries (parallel); per-query numResults (default 5); optional timeRange (day/week/month/year) " +
      "and domainFilter (prefix '-' to exclude a domain). Returns titles, URLs and snippets — use web_fetch to read a page.",
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
      "Fetch one or more URLs as readable content: HTML via readability→markdown, PDFs via pdfjs, plain text passed through, " +
      "images returned as image attachments. Content longer than the inline cap (~15k chars) is truncated inline and offloaded " +
      "to a temp file — page through it with the read tool. Bot-walled sites return a structured blocked result.",
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
          description: "Inline character cap (default 15000). Longer content is offloaded to a file.",
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
        const urls: string[] | undefined = params.urls ?? (params.url ? [params.url] : undefined);
        if (!urls || urls.length === 0) {
          return {
            content: [{ type: "text" as const, text: "web_fetch: provide `url` or `urls`." }],
            details: { error: "missing url" },
          };
        }
        const cfg = loadConfig();
        const outcomes = await fetchAll(cfg.fetch, urls, { raw: params.raw, signal });
        const text = formatFetchResults(outcomes, params.maxChars ?? cfg.fetch.maxInlineChars);
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
}
