/**
 * Phase D — type-aware overview ("bird's-eye view") for web_fetch.
 *
 * When fetched content is longer than maxChars, the formatter replaces the
 * old first-N-chars window with a navigable map. Extraction is structural
 * and model-free (design principle 2): no LLM, just parsing.
 *
 * Layers (first hit wins for the abstract/summary slot):
 *   1. source adapters (arXiv / PubMed / Wikipedia) — authoritative metadata
 *   2. multilingual keyword match on markdown headings ("## Zusammenfassung")
 *   3. keyword scan of PDF text (first ~6k chars)
 *   4. lede (first substantial line)
 *   5. structural outline: markdown headings / PDF [[page N]] markers,
 *      with 1-based line numbers so `read offset=<line>` jumps straight in.
 *
 * Everything here is best-effort: any failure degrades to "less overview",
 * never to a broken fetch.
 */
import { download } from "./http.ts";
import type { FetchConfig, FetchOutcome } from "./types.ts";

// ---------------------------------------------------------------- types

export interface SourceMatch {
  source: "arxiv" | "pubmed" | "wikipedia";
  /** arXiv id / PMID / wiki title */
  id: string;
  /** wikipedia language code (normalized: m→en) */
  lang?: string;
}

export interface SourceMeta {
  /** display string, e.g. "arXiv 2503.08444v2", "PubMed 22745249" */
  source: string;
  title?: string;
  abstract?: string;
  authors?: string;
  doi?: string;
  /** free-form extras: journal reference, comments, subjects, wiki description */
  extra?: string;
}

export interface Heading {
  level: number;
  text: string;
  /** 1-based line number in the markdown (for `read offset=`) */
  line: number;
  /** char offset of the line start */
  start: number;
  /** char offset just past the line (end of heading line) */
  end: number;
}

// ---------------------------------------------------------------- URL detection

export function detectSource(url: string): SourceMatch | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();

  if (host === "arxiv.org" || host.endsWith(".arxiv.org")) {
    const m = u.pathname.match(/^\/(?:abs|pdf)\/(.+?)(?:\.pdf)?$/);
    if (m) {
      let id: string;
      try {
        id = decodeURIComponent(m[1]);
      } catch {
        id = m[1];
      }
      return { source: "arxiv", id };
    }
    return null;
  }

  if (host === "pubmed.ncbi.nlm.nih.gov") {
    const m = u.pathname.match(/^\/(\d{6,15})(?:\/|$)/);
    if (m) return { source: "pubmed", id: m[1] };
    return null;
  }

  const wm = host.match(/^([a-z][a-z0-9-]*)\.wikipedia\.org$/);
  if (wm) {
    let title: string | null = null;
    const wp = u.pathname.match(/^\/wiki\/([^?#]+)/);
    if (wp) {
      title = decodeURIComponent(wp[1].replace(/_/g, " "));
    } else if (u.pathname === "/w/index.php" || u.pathname === "/index.php") {
      const t = u.searchParams.get("title") ?? u.searchParams.get("search");
      if (t) title = decodeURIComponent(t.replace(/_/g, " "));
    }
    const nonArticle =
      /^(wikipedia|talk|file|files|category|categories|special|portal|help|template|user|media|education|sandbox|book)[:-]/i;
    if (title && !nonArticle.test(title) && title.length <= 200) {
      return {
        source: "wikipedia",
        id: title,
        lang: wm[1] === "m" ? "en" : wm[1],
      };
    }
  }

  return null;
}

// ---------------------------------------------------------------- source adapters

const squash = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * Fetch authoritative metadata for a detected source. Best-effort:
 * returns undefined on any failure (never throws to the caller's surprise,
 * but does let real errors surface as rejects the caller can catch).
 */
export async function fetchSourceMeta(
  m: SourceMatch,
  cfg: FetchConfig,
): Promise<SourceMeta | undefined> {
  const opts = {
    userAgent: cfg.userAgent,
    timeoutMs: Math.min(cfg.timeoutMs, 15000),
    maxBytes: 5 * 1024 * 1024,
  };

  if (m.source === "arxiv") {
    const res = await download(`https://arxiv.org/abs/${m.id}`, opts);
    if (res.status !== 200) return undefined;
    return parseArxivAbs(new TextDecoder("utf-8").decode(res.body), m.id);
  }

  if (m.source === "pubmed") {
    const url =
      `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi` +
      `?db=pubmed&id=${m.id}&rettype=abstract&retmode=text`;
    const res = await download(url, opts);
    if (res.status !== 200) return undefined;
    const text = squash(new TextDecoder("utf-8").decode(res.body));
    return text.length > 30
      ? { source: `PubMed ${m.id}`, abstract: text.slice(0, 4000) }
      : undefined;
  }

  if (m.source === "wikipedia") {
    const res = await download(
      `https://${m.lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(m.id)}`,
      opts,
    );
    if (res.status !== 200) return undefined;
    try {
      const j = JSON.parse(new TextDecoder("utf-8").decode(res.body));
      if (j && typeof j.extract === "string" && j.extract.length > 0) {
        return {
          source: `Wikipedia (${m.lang})`,
          title: typeof j.title === "string" ? j.title : undefined,
          extra: typeof j.description === "string" && j.description ? j.description : undefined,
          abstract: j.extract.slice(0, 3000),
        };
      }
    } catch {
      /* non-JSON body */
    }
    return undefined;
  }

  return undefined;
}

/** Parse an arXiv /abs/ HTML page (linkedom) into structured metadata. */
export async function parseArxivAbs(html: string, id: string): Promise<SourceMeta | undefined> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const linkedom: any = await import("linkedom");
  const parsed: any = linkedom.parseHTML(html);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const doc: any = parsed?.document ?? (Array.isArray(parsed) ? parsed[1] : parsed);
  if (!doc?.querySelector) return undefined;

  const meta = (n: string) =>
    squash(String(doc.querySelector(`meta[name="${n}"]`)?.getAttribute("content") ?? ""));
  const title = meta("citation_title") || squash(doc.querySelector("h1.title")?.textContent ?? "");

  let abstract = "";
  const absEl: any = doc.querySelector("blockquote.abstract");
  if (absEl) {
    for (const d of Array.from(absEl.querySelectorAll("span.descriptor"))) d.remove?.();
    abstract = squash(absEl.textContent ?? "");
  }
  const authors = Array.from(doc.querySelectorAll("meta[name=citation_author]"))
    .map((el: any) => squash(String(el.getAttribute("content") ?? "")))
    .filter(Boolean)
    .join(", ");
  const doi = String(doc.querySelector('a[data-type="doi"]')?.getAttribute("href") ?? "") || meta("citation_doi");

  const extras: string[] = [];
  for (const td of Array.from(doc.querySelectorAll("td.tablecell"))) {
    const t = squash(td.textContent ?? "");
    const em = t.match(/^(Comments|Journal reference|Related DOI|Translation)\s*:\s*(.+)$/i);
    if (em && em[2]) extras.push(`${em[1]}: ${em[2]}`);
  }
  const subjects = squash(doc.querySelector("td.subjects")?.textContent ?? "");
  if (subjects) extras.push(`subjects: ${subjects}`);

  if (!title && !abstract) return undefined;
  return {
    source: `arXiv ${id}`,
    title,
    abstract: abstract.slice(0, 4000) || undefined,
    authors: authors || undefined,
    doi: doi || undefined,
    extra: extras.join(" | ") || undefined,
  };
}

// ---------------------------------------------------------------- outline & structure

/**
 * Extract markdown headings with 1-based line numbers (fence-aware: `#`
 * lines inside ``` / ~~~ blocks are not headings).
 */
export function extractOutline(markdown: string): { headings: Heading[]; totalLines: number } {
  const headings: Heading[] = [];
  const lines = markdown.split("\n");
  let start = 0;
  let fenced = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^(```|~~~)/.test(line)) fenced = !fenced;
    if (!fenced) {
      const m = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
      if (m) {
        headings.push({
          level: m[1].length,
          text: m[2].trim(),
          line: i + 1,
          start,
          end: start + line.length,
        });
      }
    }
    start += line.length + 1;
  }
  return { headings, totalLines: lines.length };
}

/** PDF [[page N]] markers → { page, line } (line = 1-based). */
export function findPages(markdown: string): { page: number; line: number }[] {
  const out: { page: number; line: number }[] = [];
  let line = 0;
  for (const l of markdown.split("\n")) {
    line++;
    const m = l.match(/^\[\[page (\d+)\]\]/);
    if (m) out.push({ page: Number(m[1]), line });
  }
  return out;
}

// ---------------------------------------------------------------- multilingual summary keywords

const SUMMARY_KEYWORDS = [
  // en
  "abstract", "summary", "overview", "executive summary", "key points",
  "key takeaways", "synopsis", "tldr", "tl;dr",
  // de
  "zusammenfassung", "zusammenfassend", "überblick", "übersicht", "abstrakt",
  // fr
  "résumé", "résumé d'article", "synthèse", "abrégé",
  // es
  "resumen", "resumen ejecutivo", "síntesis",
  // it
  "riassunto", "sintesi", "sommario",
  // pt
  "resumo", "resumo executivo",
  // nl / nordic
  "samenvatting", "sammanfattning", "opsummering", "resumé", "sammendrag",
  "tiivistelmä", "tiivistus", "abstrakti",
  // slavic / czech / slovak
  "streszczenie", "podsumowanie", "abstrakt", "shrnutí", "zhrnutie",
  "аннотация", "реюме", "краткое содержание", "краткая аннотация", "анотація",
  // other eu
  "összefoglaló", "összefoglalás", "rezumat", "sinteză", "абстракт",
  "кратко описание", "σύνοψη", "özet",
  // ja
  "概要", "要旨", "あらすじ", "まとめ", "サマリー", "抄",
  // zh
  "摘要", "简介", "内容提要",
  // ko
  "개요", "요약", "초록",
  // hi
  "सार", "सारांश",
];

export function normHeading(t: string): string {
  return t
    .toLowerCase()
    .trim()
    .replace(/[:\u2013\u2014]\s*$/, "")
    .replace(/\s+/g, " ");
}

/** Is this heading text a summary/abstract section (multilingual)? */
export function isSummaryHeading(t: string): boolean {
  const n = normHeading(t);
  if (!n) return false;
  for (const k of SUMMARY_KEYWORDS) {
    if (n === k) return true;
    if (n.startsWith(k + " ") || n.startsWith(k + ":") || n.startsWith(k + "-") ||
        n.startsWith(k + "\u2014") || n.startsWith(k + "\u2013")) {
      return true;
    }
  }
  return false;
}

/**
 * Find the first summary-keyword heading and return its section text
 * (up to the next same-or-higher heading, squashed, ≤4k chars).
 */
export function findSummarySection(
  markdown: string,
  headings: Heading[],
): { heading: Heading; text: string } | null {
  for (const h of headings) {
    if (!isSummaryHeading(h.text)) continue;
    const next = headings.find((x) => x.line > h.line && x.level <= h.level);
    const raw = markdown.slice(h.end, next ? next.start : markdown.length);
    const text = squash(raw).slice(0, 4000);
    if (text.length >= 20) return { heading: h, text };
  }
  return null;
}

const isAsciiLetter = (c: string) => c >= "a" && c <= "z";

/**
 * PDF text scan: earliest summary-keyword hit in the first ~6k chars
 * (word-boundary for ASCII keywords, substring for CJK/Cyrillic/etc.).
 * Returns the squashed ~2k chars starting at the hit, or null.
 */
export function pdfKeywordAbstract(markdown: string, maxChars = 2000): string | null {
  const head = markdown.slice(0, 6000);
  const low = head.toLowerCase();
  let hit: number | null = null;
  for (const k of SUMMARY_KEYWORDS) {
    const kl = k.toLowerCase();
    const ascii = /^[\x20-\x7e]*$/.test(kl);
    let idx = low.indexOf(kl);
    while (idx !== -1) {
      const before = idx > 0 ? low[idx - 1] : " ";
      const after = idx + kl.length < low.length ? low[idx + kl.length] : " ";
      const boundaryOk = !ascii || (!isAsciiLetter(before) && !isAsciiLetter(after));
      if (boundaryOk) {
        if (hit === null || idx < hit) hit = idx;
        break;
      }
      idx = low.indexOf(kl, idx + 1);
    }
  }
  if (hit === null) return null;
  const text = squash(markdown.slice(hit, hit + maxChars));
  return text.length >= 60 ? text : null;
}

/** First substantial line (≥80 chars, not heading/list/table/marker), ≤maxChars. */
export function findLede(markdown: string, maxChars = 1200): string | null {
  for (const line of markdown.split("\n")) {
    const t = line.trim();
    if (t.length < 80) continue;
    if (/^#{1,6}\s/.test(t)) continue;
    if (/^[|>*+-]\s?/.test(t)) continue;
    if (t.startsWith("[[page")) continue;
    const s = squash(t);
    if (s.length >= 80) return s.slice(0, maxChars);
  }
  return null;
}

// ---------------------------------------------------------------- overview builder

/**
 * Build the overview block for a long fetched document, or null if there's
 * nothing structural to show (caller falls back to the raw window).
 */
export function buildOverview(o: FetchOutcome, maxChars: number): string | null {
  const content = o.content ?? "";
  if (content.length === 0) return null;

  const { headings, totalLines } = extractOutline(content);
  const pages = findPages(content);
  const summary =
    o.meta?.abstract || findSummarySection(content, headings)?.text || pdfKeywordAbstract(content);
  const lede = summary ? null : findLede(content);

  const hasStructure =
    headings.length >= 2 || pages.length >= 2 || !!o.meta || !!summary;
  if (!hasStructure && !lede) return null;

  const L: string[] = [];
  if (o.meta) {
    const bits: string[] = [];
    if (o.meta.title) bits.push(`title: ${o.meta.title}`);
    if (o.meta.authors) bits.push(`authors: ${o.meta.authors}`);
    if (o.meta.extra) bits.push(o.meta.extra);
    if (o.meta.doi) bits.push(`doi: ${o.meta.doi}`);
    if (bits.length) L.push(bits.join(" | "));
  } else if (o.title) {
    L.push(`title: ${o.title}`);
  }
  if (summary) L.push(`abstract/summary:\n  ${summary}`);
  if (lede) L.push(`lede: ${lede}`);
  if (headings.length >= 2) {
    const rows = headings.slice(0, 50).map((h) => {
      const indent = "  ".repeat(Math.min(h.level - 1, 3));
      return `${indent}L${h.line}  ${h.text.slice(0, 90)}`;
    });
    L.push(
      `outline (${headings.length} sections; jump with read offset=<line>):\n` +
        rows.join("\n") +
        (headings.length > 50 ? `\n  … +${headings.length - 50} more` : ""),
    );
  }
  if (pages.length >= 2) {
    const shown = pages.slice(0, 30).map((p) => `p${p.page}→L${p.line}`).join(", ");
    L.push(`pages (${pages.length}): ${shown}${pages.length > 30 ? `, … +${pages.length - 30} more` : ""}`);
  }
  const stat = `[full text: ${content.length.toLocaleString("en-US")} chars, ${totalLines.toLocaleString("en-US")} lines`;
  L.push(
    o.offload
      ? `${stat} → ${o.offload} — page through it with the read tool (offset = line)]`
      : `${stat} — offload unavailable; re-fetch with mode:'raw' for an inline window]`,
  );

  let out = L.join("\n");
  if (out.length > maxChars) out = out.slice(0, maxChars) + "\n[overview truncated]";
  return out;
}
