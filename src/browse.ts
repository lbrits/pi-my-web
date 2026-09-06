import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { BrowseConfig, FetchConfig, FetchOutcome, PiMyWebConfig } from "./types.ts";
import { detectWall } from "./walls.ts";
import { htmlToMarkdown } from "./pipeline.ts";
import { offloadContent } from "./offload.ts";
import { detectSource, fetchSourceMeta } from "./overview.ts";

/**
 * Phase B — web_browse: a wall-breaker that renders the URL in a real
 * Firefox (Playwright's own Juggler-patched build; stock/LibreWolf Firefox
 * can't be driven — Playwright relies on patches baked into its binary) with
 * a persistent per-user profile (cookies survive → many walls clear on
 * retry after the first manual clear).
 *
 * Two stages:
 *   1. headless navigation with the saved profile;
 *   2. if a 2xx challenge page is still present and visiblePollMs > 0:
 *      relaunch with a VISIBLE window and poll (2 s) up to visiblePollMs
 *      for the user to clear the challenge, then re-read the page.
 *
 * Result shape mirrors web_fetch (FetchOutcome); offload + source-adapter
 * post-processing are the same as fetchAll.
 */

export interface BrowseOutcome extends FetchOutcome {
  /** 1 = headless was enough; 2 = visible-window challenge wait */
  stage?: 1 | 2;
  challengeCleared?: boolean;
}

const LAUNCH_OPTS = (bc: BrowseConfig, headless: boolean) => ({
  headless,
  locale: "en-US",
  viewport: { width: bc.viewportWidth, height: bc.viewportHeight },
});

function profileDirOf(bc: BrowseConfig): string {
  return bc.profileDir ?? join(homedir(), ".pi", "agent", "pi-my-web-browse");
}

async function gotoAndRead(page: any, url: string, timeoutMs: number) {
  const response = await page.goto(url, { timeout: timeoutMs, waitUntil: "load" });
  // best-effort: let the network settle (analytics, lazy widgets); pages with
  // persistent connections just time out here, which is fine
  await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
  const html = await page.content();
  return { status: response?.status() ?? 0, html, finalUrl: page.url() };
}

async function finish(
  out: BrowseOutcome,
  r: { status: number; html: string; finalUrl: string },
  raw: boolean,
) {
  out.status = r.status;
  out.finalUrl = r.finalUrl;
  out.contentType = "text/html";
  out.bytes = Buffer.byteLength(r.html);
  const wall = detectWall({ status: r.status, text: r.html });
  if (wall.blocked) {
    out.blocked = true;
    out.kind = "blocked";
    out.reason = `bot wall (real browser): ${wall.reason}`;
    out.content = r.html.slice(0, 300);
    return;
  }
  try {
    const md = raw
      ? { title: "", markdown: r.html, kind: "text" as const }
      : await htmlToMarkdown(r.html);
    out.ok = md.markdown.trim().length > 0;
    out.kind = md.kind;
    out.title = md.title;
    out.content = md.markdown;
    if (!out.ok) out.reason = "extracted content was empty";
  } catch (err) {
    out.ok = r.html.length > 0;
    out.kind = "text";
    out.content = r.html;
    out.reason = `markdown extraction failed: ${
      err instanceof Error ? err.message : String(err)
    } — raw HTML below`;
  }
}

export async function browseOne(
  url: string,
  bc: BrowseConfig,
  fc: FetchConfig,
  opts: { raw?: boolean; signal?: AbortSignal } = {},
): Promise<BrowseOutcome> {
  void fc; // reserved for symmetry with fetchOne; the pipeline needs no fetch cfg here
  const out: BrowseOutcome = { url, ok: false, kind: "error" };
  const dir = profileDirOf(bc);
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    /* best effort */
  }

  const pw: any = await import("playwright-core");
  let ctx: any = null;
  let userClosed = false;
  const onAbort = () => {
    void ctx?.close().catch(() => {});
  };
  opts.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    // ---- stage 1: headless, with the saved profile ----
    ctx = await pw.firefox.launchPersistentContext(dir, LAUNCH_OPTS(bc, true));
    ctx.on("close", () => {
      userClosed = true;
    });
    let page = ctx.pages()[0] ?? (await ctx.newPage());
    let r = await gotoAndRead(page, url, bc.timeoutMs);
    out.stage = 1;

    const wall1 = detectWall({ status: r.status, text: r.html });
    if (!wall1.blocked) {
      await finish(out, r, opts.raw === true);
      return out;
    }
    await ctx.close().catch(() => {});
    ctx = null;
    userClosed = false;

    // 4xx/5xx: a visible window won't help; report and stop
    if (r.status < 200 || r.status >= 400) {
      out.blocked = [401, 403, 407, 429, 503].includes(r.status);
      out.kind = "blocked";
      out.status = r.status;
      out.reason = out.blocked
        ? `HTTP ${r.status} (real browser — hard wall, not a solvable challenge)`
        : `HTTP ${r.status} (real browser)`;
      out.content = r.html.slice(0, 300);
      return out;
    }
    if (bc.visiblePollMs <= 0) {
      out.blocked = true;
      out.kind = "blocked";
      out.status = r.status;
      out.reason = `bot wall (real browser, headless): ${wall1.reason} — no visible fallback (visiblePollMs=0)`;
      out.content = r.html.slice(0, 300);
      return out;
    }

    // ---- stage 2: visible window, wait for the user to clear it ----
    // (profile lock: stage 1's context is fully closed before this launch)
    ctx = await pw.firefox.launchPersistentContext(dir, LAUNCH_OPTS(bc, false));
    ctx.on("close", () => {
      userClosed = true;
    });
    page = ctx.pages()[0] ?? (await ctx.newPage());
    r = await gotoAndRead(page, url, bc.timeoutMs);
    out.stage = 2;

    const deadline = Date.now() + bc.visiblePollMs;
    while (Date.now() < deadline && !userClosed) {
      if (!detectWall({ status: r.status, text: r.html }).blocked) break;
      await new Promise((res) => setTimeout(res, 2000));
      if (userClosed) break;
      try {
        // re-read the current DOM: the user may have solved the challenge and
        // the page navigated, or is still mid-action
        r = { status: r.status, html: await page.content(), finalUrl: page.url() };
      } catch {
        break; // page destroyed
      }
    }
    out.challengeCleared = !userClosed && !detectWall({ status: r.status, text: r.html }).blocked;
    if (!out.challengeCleared) {
      out.blocked = true;
      out.kind = "blocked";
      out.status = r.status;
      out.reason = userClosed
        ? "visible window was closed before the challenge was cleared — retry when ready"
        : `challenge not cleared within ${Math.round(bc.visiblePollMs / 1000)} s (visible window) — ` +
          "retry; cookies from this attempt are kept in the profile";
      out.content = r.html.slice(0, 300);
      return out;
    }
    await finish(out, r, opts.raw === true);
    return out;
  } catch (err) {
    out.reason = `browse failed: ${err instanceof Error ? err.message : String(err)}`;
    return out;
  } finally {
    opts.signal?.removeEventListener("abort", onAbort);
    await ctx?.close().catch(() => {});
  }
}

/** browseOne + the same offload/source-adapter post-processing as fetchAll. */
export async function browse(
  cfg: PiMyWebConfig,
  url: string,
  opts: { raw?: boolean; signal?: AbortSignal } = {},
): Promise<BrowseOutcome> {
  const o = await browseOne(url, cfg.browse, cfg.fetch, opts);
  if (o.ok && o.content && o.content.length >= cfg.fetch.offloadMinChars) {
    try {
      o.offload = offloadContent(cfg.fetch.offloadDir ?? "/tmp/pi-my-web", url, o.content);
    } catch {
      /* offload is best-effort */
    }
  }
  if (o.ok && o.content) {
    const m = detectSource(o.finalUrl ?? url);
    if (m) {
      try {
        o.meta = await fetchSourceMeta(m, cfg.fetch);
      } catch {
        /* adapter is best-effort */
      }
    }
  }
  return o;
}
