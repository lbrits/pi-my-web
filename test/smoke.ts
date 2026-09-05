/**
 * Smoke test for pi-my-web (run: node test/smoke.ts from the repo root).
 * Exercises search, HTML fetch (remote), PDF + image fetch (local HTTP server
 * so those branches don't depend on remote availability), the size cap, and
 * wall detection. Exits non-zero if any check fails.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { searchAll, applyDomainFilter } from "../src/search.ts";
import { fetchAll, formatFetchResults } from "../src/fetcher.ts";
import { detectWall } from "../src/walls.ts";
import {
  buildOverview,
  detectSource,
  extractOutline,
  fetchSourceMeta,
  findLede,
  findPages,
  findSummarySection,
  isSummaryHeading,
  pdfKeywordAbstract,
} from "../src/overview.ts";
import type { FetchOutcome } from "../src/types.ts";

let failures = 0;
function check(name: string, ok: boolean, extra?: string) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? ` — ${extra}` : ""}`);
  if (!ok) failures++;
}

const cfg = loadConfig();
console.log(`config: ${cfg.search.backends.length} backend(s): ${cfg.search.backends.map((b) => `${b.name}(${b.baseUrl})`).join(", ")}`);

// --- search ---
{
  const [o] = await searchAll(cfg, { queries: ["searxng search engine json format documentation"], numResults: 5 });
  check("search: query returns results", o.ok && o.results.length > 0, o.ok ? `backend=${o.backend} n=${o.results.length}` : o.error);
  if (o.ok) {
    console.log(o.results.slice(0, 3).map((r) => `      ${r.url}`).join("\n"));
    const filtered = applyDomainFilter(o.results, ["-example.org"]);
    check("search: domainFilter exclude works", filtered.every((r) => !r.url.includes("example.org")));
  }
  const t = await searchAll(cfg, { queries: ["some query"], timeRange: "week" });
  check("search: timeRange param accepted", t[0].ok !== undefined);
}

// Local server for PDF + image fixtures (remote PDF/image URLs 404/429 too
// often to be a reliable test dependency).
const home = homedir();
const pdfFixture = join(home, "2022 Subaru Forester Touring Cvt used for sale at $28,499 (HM5280).pdf");
const pngFixture = join(home, "avatar.png");
const localFiles: Record<string, { path: string; type: string }> = {};
try {
  if ((await stat(pdfFixture)).size < 10 * 1024 * 1024) localFiles["/car.pdf"] = { path: pdfFixture, type: "application/pdf" };
} catch { /* skip pdf fixture */ }
const onePxPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);
let png = onePxPng;
try {
  const a = await readFile(pngFixture);
  if (a.length < 2 * 1024 * 1024) png = a;
} catch { /* keep 1px */ }
localFiles["/test.png"] = { path: "-", type: "image/png" };

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const f = localFiles[req.url ?? ""];
  if (!f) { res.writeHead(404); res.end("nope"); return; }
  const body = f.path === "-" ? png : await readFile(f.path);
  res.writeHead(200, { "content-type": f.type, "content-length": String(body.length) });
  res.end(body);
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const lport = (server.address() as any).port;

// --- fetch: HTML (remote) ---
{
  const [o] = await fetchAll(cfg.fetch, ["https://en.wikipedia.org/wiki/Markdown"], {});
  check("fetch html: ok", o.ok === true, `status=${o.status} kind=${o.kind} title=${o.title ?? "?"} chars=${o.content?.length}`);
  check("fetch html: has markdown headings", /^#{1,3} /m.test(o.content ?? ""), "");
  check("fetch html: offload path set", typeof o.offload === "string", o.offload);
  // Phase D: the adapter pass in fetchAll should attach wikipedia metadata
  check("fetch html: wikipedia adapter meta", o.meta?.source === "Wikipedia (en)" && (o.meta?.abstract?.length ?? 0) > 50, o.meta?.source ?? "(no meta)");
  // long page + overview mode → map (budgeted), not a 15k window
  const fmt = formatFetchResults([o], 5000, "overview");
  check("fetch html: overview mode → map", /full text:/.test(fmt) && !fmt.includes((o.content ?? "").slice(20000, 20100)), `fmt=${fmt.length} chars`);
}

// --- fetch: PDF ---
if (localFiles["/car.pdf"]) {
  const [o] = await fetchAll(cfg.fetch, [`http://127.0.0.1:${lport}/car.pdf`], {});
  check("fetch pdf: ok", o.ok === true && (o.content?.length ?? 0) > 500, `status=${o.status} kind=${o.kind} chars=${o.content?.length} reason=${o.reason ?? ""}`);
  check("fetch pdf: text extracted", /Subaru|Forester/i.test(o.content ?? ""));
  check("fetch pdf: page markers", /\[\[page 1\]\]/.test(o.content ?? ""));
} else {
  console.log("SKIP  fetch pdf (no local pdf fixture)");
}

// --- fetch: image ---
{
  const [o] = await fetchAll(cfg.fetch, [`http://127.0.0.1:${lport}/test.png`], {});
  check("fetch image: ok", o.ok === true && o.kind === "image", `status=${o.status} kind=${o.kind} mime=${o.image?.mimeType}`);
  check("fetch image: base64 payload", (o.image?.data.length ?? 0) > 100, `bytes~${Math.round(((o.image?.data.length ?? 0) * 3) / 4)}`);
}

// --- fetch: 404 shape ---
{
  const [o] = await fetchAll(cfg.fetch, [`http://127.0.0.1:${lport}/missing`], {});
  check("fetch 404: structured error", o.ok === false && o.status === 404 && o.blocked !== true, `status=${o.status} reason=${o.reason}`);
}

// --- fetch: size cap (34MB dishwasher manual, if present) ---
{
  const big = join(home, "dishwasher_manual_LDFN4542W.pdf");
  let isBig = false;
  try { isBig = (await stat(big)).size > 10 * 1024 * 1024; } catch { /* skip */ }
  if (isBig) {
    localFiles["/big.pdf"] = { path: big, type: "application/pdf" };
    const [o] = await fetchAll(cfg.fetch, [`http://127.0.0.1:${lport}/big.pdf`], {});
    check("fetch size cap: >10MB rejected", o.ok === false && /exceeds/.test(o.reason ?? ""), o.reason);
  }
}
server.close();

// --- walls (synthetic) ---
{
  check("wall: 403 blocked", detectWall({ status: 403, text: "denied" }).blocked === true);
  check("wall: 404 not a wall", detectWall({ status: 404, text: "not found" }).blocked === false);
  check("wall: challenge text blocked", detectWall({ status: 200, text: "<html><title>Just a moment...</title><body>Checking your browser</body></html>" }).blocked === true);
  check("wall: long normal page not a wall", detectWall({ status: 200, text: "x".repeat(5000) }).blocked === false);
}

// --- overview (Phase D, offline units) ---
{
  const md = [
    "# Test Doc", "",
    "Intro line here.", "",
    "## Einleitung", "",
    "A lead paragraph that is definitely longer than eighty characters so the lede extractor can pick it up for sure.", "",
    "## Zusammenfassung", "",
    "Zusammengefasst: dies ist die Zusammenfassung des Dokuments und es ist lang genug.", "",
    "## Ergebnisse", "",
    "blabla", "",
    "```", "# not a heading (inside fence)", "```",
  ].join("\n");
  const { headings, totalLines } = extractOutline(md);
  check("outline: 4 headings (fence-aware)", headings.length === 4, `n=${headings.length} lines=${totalLines}`);
  const zu = headings.find((h) => h.text === "Zusammenfassung");
  check("outline: line numbers", zu !== undefined && md.split("\n")[zu.line - 1].includes("Zusammenfassung"), zu && `L${zu.line}`);
  check("summary kw: Zusammenfassung", isSummaryHeading("Zusammenfassung") === true);
  check("summary kw: 摘要", isSummaryHeading("摘要") === true);
  check("summary kw: 'Summary of results'", isSummaryHeading("Summary of results") === true);
  check("summary kw: 'Ergebnisse' is not", isSummaryHeading("Ergebnisse") === false);
  check("summary kw: 'Introduction' is not", isSummaryHeading("Introduction") === false);
  const s = findSummarySection(md, headings);
  check("summary section: extracted", s !== null && /Zusammengefasst/.test(s.text), s?.text.slice(0, 60));
  check("lede: first substantial line", findLede(md) !== null && /eighty characters/.test(findLede(md) ?? ""));

  const pdf = [
    "[[page 1]]", "",
    "Title of the paper, some authors.", "",
    "Abstract", "",
    "This is the abstract text of the paper which is certainly longer than sixty characters overall for the test.", "",
    "[[page 2]]", "",
    "Introduction of the paper body continues here on the second page.",
  ].join("\n");
  const pages = findPages(pdf);
  check("pdf markers: 2 pages", pages.length === 2 && pages[1].line > pages[0].line, JSON.stringify(pages));
  const pabs = pdfKeywordAbstract(pdf);
  check("pdf keyword: Abstract found", pabs !== null && /abstract text/.test(pabs ?? ""), pabs?.slice(0, 60));

  check("detect: arxiv pdf id", detectSource("https://arxiv.org/pdf/2503.08444v2")?.id === "2503.08444v2");
  check("detect: arxiv abs old-style", detectSource("https://arxiv.org/abs/math/0201001")?.id === "math/0201001");
  check("detect: arxiv no-suffix", detectSource("https://arxiv.org/pdf/2503.08444")?.id === "2503.08444");
  check("detect: pubmed pmid", detectSource("https://pubmed.ncbi.nlm.nih.gov/22745249/")?.id === "22745249");
  check("detect: wikipedia title", detectSource("https://en.wikipedia.org/wiki/Markdown")?.id === "Markdown");
  check("detect: wikipedia m.→en", detectSource("https://m.wikipedia.org/wiki/Markdown")?.lang === "en");
  check("detect: wikipedia talk: skipped", detectSource("https://en.wikipedia.org/wiki/Talk:Markdown") === null);
  check("detect: plain site null", detectSource("https://example.com/x") === null);

  const long: FetchOutcome = {
    url: "https://x.test/long", ok: true, kind: "markdown", title: "Long Doc",
    content: ["# Long Doc", "",
      "Lead paragraph that is definitely longer than eighty characters so it can serve as the lede of this document.", "",
      ...Array.from({ length: 40 }, (_, i) => `## Section ${i}\n\n` + "lorem ipsum dolor sit amet ".repeat(10) + "\n")].join("\n"),
    offload: "/tmp/pi-my-web/long.md",
  };
  const ov = buildOverview(long, 15000);
  check("buildOverview: map produced", ov !== null && /outline \(/.test(ov) && /full text:/.test(ov) && ov.includes("/tmp/pi-my-web/long.md"), ov?.slice(0, 120));
  check("buildOverview: no body dump", ov !== null && ov.length < 15000 && !ov.includes("lorem ipsum dolor sit amet ".repeat(5)), `len=${ov?.length}`);
  const wall: FetchOutcome = {
    url: "https://x.test/wall", ok: true, kind: "text",
    content: "just a wall of text with no headings at all, ".repeat(200),
    offload: "/tmp/pi-my-web/wall.md",
  };
  const ovw = buildOverview(wall, 15000);
  check("buildOverview: wall → lede only", ovw !== null && !/outline/.test(ovw) && /lede:/.test(ovw), ovw?.slice(0, 100));
  check("buildOverview: nothing structural → null", buildOverview({ url: "u", ok: true, kind: "text", content: "abc" }, 15000) === null);
  check("format: mode=raw keeps window", formatFetchResults([long], 2000, "raw").includes("lorem ipsum dolor sit amet ".repeat(5)));
  check("format: mode=overview uses map", (() => {
    const f = formatFetchResults([long], 2000, "overview");
    return /outline \(/.test(f) && !f.includes("lorem ipsum dolor sit amet ".repeat(5));
  })());
}

// --- overview: live source adapters (network) ---
{
  const ma = detectSource("https://arxiv.org/abs/2503.08444");
  const metaA = ma ? await fetchSourceMeta(ma, cfg.fetch) : undefined;
  check("adapter arxiv: title", !!metaA?.title && /feynman|diagram/i.test(metaA.title), metaA?.title);
  check("adapter arxiv: abstract", (metaA?.abstract?.length ?? 0) > 100, metaA?.abstract?.slice(0, 80));
  const mw = detectSource("https://en.wikipedia.org/wiki/Markdown");
  const metaW = mw ? await fetchSourceMeta(mw, cfg.fetch) : undefined;
  check("adapter wikipedia: extract", (metaW?.abstract?.length ?? 0) > 50, metaW?.abstract?.slice(0, 80));
  const mp = detectSource("https://pubmed.ncbi.nlm.nih.gov/22745249/");
  const metaP = mp ? await fetchSourceMeta(mp, cfg.fetch) : undefined;
  check("adapter pubmed: efetch", (metaP?.abstract?.length ?? 0) > 100, metaP?.abstract?.slice(0, 80));
}

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
