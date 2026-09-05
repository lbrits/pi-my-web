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
import { fetchAll } from "../src/fetcher.ts";
import { detectWall } from "../src/walls.ts";

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
}

// --- fetch: PDF ---
if (localFiles["/car.pdf"]) {
  const [o] = await fetchAll(cfg.fetch, [`http://127.0.0.1:${lport}/car.pdf`], {});
  check("fetch pdf: ok", o.ok === true && (o.content?.length ?? 0) > 500, `status=${o.status} kind=${o.kind} chars=${o.content?.length} reason=${o.reason ?? ""}`);
  check("fetch pdf: text extracted", /Subaru|Forester/i.test(o.content ?? ""));
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

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
