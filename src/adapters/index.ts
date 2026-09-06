/**
 * Site adapters — site-specific fetch behavior, one little file per site.
 *
 * An adapter can detect that a fetched page is an *interstitial* wrapping the
 * real content (e.g. a Sci-Hub paper page that wraps the actual PDF) and
 * redirect the fetch at the real content, so the model never has to dig the
 * document link out of raw HTML.
 *
 * Guarantees enforced by the fetcher (fetchOne), not by adapters:
 *   - at most one follow-hop per request (no chains / no loops),
 *   - only HTML responses are considered,
 *   - skipped entirely in raw mode (the user asked for that exact page),
 *   - if the hop fails, the interstitial page itself is reported as usual.
 *
 * To add an adapter: create `src/adapters/<site>.ts` exporting a SiteAdapter,
 * then register it in ADAPTERS below.
 */
import { scihub } from "./scihub.ts";

export interface SiteAdapter {
  name: string;
  /** True when the adapter applies to this URL (host-based). */
  matches(url: string): boolean;
  /**
   * Given the fetched HTML body and its URL, return the real content's URL
   * if this page is an interstitial, else null.
   */
  followUrl(html: string, pageUrl: string): string | null | Promise<string | null>;
}

export const ADAPTERS: SiteAdapter[] = [scihub];
