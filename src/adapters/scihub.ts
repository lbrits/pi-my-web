import type { SiteAdapter } from "./index.ts";

/**
 * Sci-Hub adapter.
 *
 * Sci-Hub paper pages are interstitials: they wrap the actual document in an
 * `<object type="application/pdf">` embed plus a `citation_pdf_url` meta tag.
 * Instead of making the model dig the /storage/.../paper.pdf link out of
 * ~25 KB of raw HTML, follow it automatically and return the document.
 *
 * Trigger: hostname contains "sci-hub" or "scihub". We deliberately do not
 * match an exact host — the canonical domain rotates between mirrors
 * (sci-hub.ru, sci-hub.se, scihub.su, ...), so host-substring is the only
 * stable trigger.
 */

export function isScihubHost(url: string): boolean {
  try {
    const h = new URL(url).hostname.toLowerCase();
    return h.includes("sci-hub") || h.includes("scihub");
  } catch {
    return false;
  }
}

/** Looks like a document, not another app page. */
const DOC_EXT = /\.(pdf|epub|djvu|djv|txt|html?)$/i;

/**
 * Find the wrapped document's URL on a Sci-Hub paper page, or null if the
 * page has no document link (e.g. "not found" / captcha pages).
 */
export async function scihubFollowUrl(html: string, pageUrl: string): Promise<string | null> {
  let link = "";
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const linkedom: any = await import("linkedom");
    const parsed: any = linkedom.parseHTML(html);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const doc: any = parsed?.document ?? (Array.isArray(parsed) ? parsed[1] : parsed);
    if (doc?.querySelector) {
      link =
        doc.querySelector('meta[name="citation_pdf_url"]')?.getAttribute("content") ??
        doc.querySelector('object[type="application/pdf"]')?.getAttribute("data") ??
        doc.querySelector(".download a")?.getAttribute("href") ??
        "";
    }
  } catch {
    return null;
  }
  if (!link) return null;

  let resolved: URL;
  let page: URL;
  try {
    resolved = new URL(link, pageUrl);
    page = new URL(pageUrl);
  } catch {
    return null;
  }
  // Safety: same host, and it looks like a document.
  if (resolved.hostname !== page.hostname) return null;
  if (!DOC_EXT.test(resolved.pathname)) return null;
  resolved.hash = ""; // PDF viewers use #navpanes etc.; keep the URL clean
  return resolved.toString();
}

export const scihub: SiteAdapter = {
  name: "scihub",
  matches: isScihubHost,
  followUrl: scihubFollowUrl,
};
