import type { FetchConfig, FetchOutcome } from "./types.ts";
import { download } from "./http.ts";
import { detectWall } from "./walls.ts";
import { extract } from "./pipeline.ts";
import { ADAPTERS } from "./adapters/index.ts";
import { offloadContent } from "./offload.ts";
import { buildOverview, detectSource, fetchSourceMeta } from "./overview.ts";

const utf8 = new TextDecoder("utf-8", { fatal: false });

export async function fetchOne(
  url: string,
  cfg: FetchConfig,
  opts: { raw?: boolean; signal?: AbortSignal; _hopped?: boolean },
): Promise<FetchOutcome> {
  const out: FetchOutcome = { url, ok: false, kind: "error" };

  let res;
  try {
    res = await download(url, {
      userAgent: cfg.userAgent,
      timeoutMs: cfg.timeoutMs,
      maxBytes: cfg.maxResponseBytes,
      signal: opts.signal,
    });
  } catch (err) {
    out.reason = err instanceof Error ? err.message : String(err);
    return out;
  }
  out.status = res.status;
  out.finalUrl = res.finalUrl;
  out.contentType = res.contentType;
  out.bytes = res.body.byteLength;

  if (res.status < 200 || res.status >= 400) {
    out.blocked = [401, 403, 407, 429, 503].includes(res.status);
    out.kind = out.blocked ? "blocked" : "error";
    out.reason = out.blocked
      ? `HTTP ${res.status} (likely bot wall — retry with web_browse when available, or try another source)`
      : `HTTP ${res.status}`;
    out.content = utf8.decode(res.body).slice(0, 300);
    return out;
  }

  const text = utf8.decode(res.body);
  const wall = detectWall({ status: res.status, text });
  if (wall.blocked) {
    out.blocked = true;
    out.kind = "blocked";
    out.reason = `bot wall: ${wall.reason}`;
    out.content = text.slice(0, 300);
    return out;
  }

  // Site adapters: interstitial → real content (e.g. Sci-Hub paper page → PDF).
  // HTML responses only, non-raw mode, at most one hop per request. On a
  // failed hop we fall through and report the interstitial page as usual.
  if (!opts.raw && !opts._hopped) {
    const ct = (res.contentType ?? "").toLowerCase();
    const looksLikeHtml = ct.includes("html") || /<(!doctype html|html[\s>])/i.test(text.slice(0, 1000));
    if (looksLikeHtml) {
      for (const a of ADAPTERS) {
        if (!a.matches(url)) continue;
        const follow = await a.followUrl(text, url);
        if (follow && follow !== url) {
          const sub = await fetchOne(follow, cfg, { signal: opts.signal, _hopped: true });
          if (sub.ok) {
            sub.followedFrom = url;
            return sub;
          }
        }
        break; // first matching adapter wins
      }
    }
  }

  try {
    const ex = await extract(res, cfg, opts.raw === true);
    if (ex.image) {
      out.ok = true;
      out.kind = "image";
      out.image = ex.image;
      out.title = ex.title;
      return out;
    }
    out.ok = ex.markdown.trim().length > 0;
    out.kind = ex.kind;
    out.title = ex.title;
    out.content = ex.markdown;
    if (!out.ok) out.reason = "extracted content was empty";
  } catch (err) {
    out.reason = `extraction failed: ${err instanceof Error ? err.message : String(err)} — raw body below`;
    out.ok = text.length > 0;
    out.kind = "text";
    out.content = text;
  }
  return out;
}

export async function fetchAll(
  cfg: FetchConfig,
  urls: string[],
  opts: { raw?: boolean; signal?: AbortSignal },
): Promise<FetchOutcome[]> {
  const outcomes = await Promise.all(urls.map((u) => fetchOne(u, cfg, { raw: opts.raw, signal: opts.signal })));
  for (const o of outcomes) {
    if (o.ok && o.content && o.content.length >= cfg.offloadMinChars) {
      try {
        o.offload = offloadContent(cfg.offloadDir ?? "/tmp/pi-my-web", o.url, o.content);
      } catch {
        /* offload is best-effort */
      }
    }
  }
  // Phase D: authoritative source metadata (arXiv/PubMed/Wikipedia).
  // Extra GET per detected source, in parallel, best-effort.
  await Promise.all(
    outcomes.map(async (o) => {
      if (!o.ok || !o.content) return;
      const m = detectSource(o.finalUrl ?? o.url);
      if (!m) return;
      try {
        o.meta = await fetchSourceMeta(m, cfg);
      } catch {
        /* adapter is best-effort */
      }
    }),
  );
  return outcomes;
}

export function formatFetchResults(
  outcomes: FetchOutcome[],
  maxChars: number,
  mode: "overview" | "raw" = "overview",
): string {
  const sections = outcomes.map((o) => {
    const meta = [
      o.status !== undefined ? `status=${o.status}` : null,
      o.contentType ? `type=${o.contentType.split(";")[0].trim()}` : null,
      o.bytes !== undefined ? `${(o.bytes / 1024).toFixed(1)} KB` : null,
    ]
      .filter(Boolean)
      .join(" ");
    const lines: string[] = [`## ${o.url}`, meta ? `(${meta})` : ""];
    if (o.followedFrom) lines.push(`[auto-followed from: ${o.followedFrom}]`);

    if (o.blocked) {
      lines.push(`BLOCKED — ${o.reason}`);
      if (o.content) lines.push(o.content.slice(0, 300));
      return lines.filter((l) => l !== "").join("\n");
    }
    if (!o.ok) {
      lines.push(`ERROR: ${o.reason ?? "unknown"}`);
      if (o.content) lines.push(o.content.slice(0, 300));
      return lines.filter((l) => l !== "").join("\n");
    }
    if (o.kind === "image" && o.image) {
      const kb = Math.round((o.image.data.length * 3) / 4 / 1024);
      lines.push(`[image ${o.image.mimeType}, ~${kb} KB — returned as image attachment below]`);
      return lines.filter((l) => l !== "").join("\n");
    }

    const content = o.content ?? "";
    const head = o.title ? `title: ${o.title}\n\n` : "";
    if (mode === "overview" && content.length > maxChars) {
      const ov = buildOverview(o, maxChars);
      if (ov) {
        lines.push(ov);
        return lines.filter((l) => l !== "").join("\n");
      }
      // no structure found → fall through to the classic window
    }
    if (content.length > maxChars) {
      lines.push(head + content.slice(0, maxChars));
      if (o.offload) {
        lines.push(`\n[... truncated: ${content.length} chars total — full content: ${o.offload} (use the read tool to page through it)]`);
      }
    } else {
      lines.push(head + content);
    }
    if (o.offload && content.length <= maxChars) {
      lines.push(`\n[full content also saved at: ${o.offload}]`);
    }
    return lines.filter((l) => l !== "").join("\n");
  });
  return sections.join("\n\n");
}
