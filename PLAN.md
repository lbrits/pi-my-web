# pi-my-web — PLAN

Custom slim web-access extension for pi. Replaces the `npm:pi-web-access` package with
~900 lines of local code we control. Implements the 2026-09-05 decision "build custom
slim web kit, retire pi-web-access" (lionel daily log) and supersedes the "trim provider
enum via patch" sub-clause of the pi-lazy-tools verdict (that verdict otherwise stands).

## Status — 2026-09-05
- [x] **Phase A (core)**: `web_search` + `web_fetch` implemented, smoke test green
      (16/16 checks: search, HTML→markdown, PDF→text, image→attachment, size cap,
      404 shape, wall detection).
- [x] Deployment to lionel instance (symlink + smoke audit).
- [x] `npm:pi-web-access` tools disabled via `web-search.json` (rollback-safe).
- [x] GitHub repo `lbrits/pi-my-web` (private) + research mirror.
- [x] **Phase B (wall-breaker)**: `web_browse` — Playwright + real Firefox (2026-09-06).
      Deviation from original plan: LibreWolf/stock Firefox **cannot** be driven —
      Playwright's Firefox relies on the Juggler patch baked into its own build
      (docs: "Playwright doesn't work with the branded version of Firefox").
      Used `playwright-core` (zero runtime deps) + `npx playwright-core install
      firefox` (one-time 109.5 MB download per user, `~/.cache/ms-playwright/`).
- [x] **Phase C**: remove `npm:pi-web-access` from both `settings.json` (2026-09-05).
      Deviation: the npm module was NOT uninstalled — it stays in
      `~/.pi/agent/npm/node_modules` as a one-line rollback, and the
      `web-search.json` disables were kept as rollback documentation.
- [x] **Phase D (overview)**: type-aware bird's-eye view + source adapters
      (arXiv, PubMed, Wikipedia) + multilingual summary-section detection
      (2026-09-05).

## Design principles
1. **Backend-agnostic search**: no hardcoded provider anywhere in tool schemas or
   descriptions. Search endpoint(s) are a **list** in config (multiple providers
   possible later). One adapter today: `searxng-json` (SearXNG with `format=json`).
   Adding a provider = one function + one registry entry; the model never sees it.
2. **No summary/curator model.** The tool returns structured text; the main model
   (the agent) does the synthesis. Saves the curator window + a second LLM call.
3. **Content offload over context**: long fetches write full markdown to a temp
   file; the tool result carries the first ~15k chars + the path. The agent pages
   with the existing `read` tool. Kills the need for a `get_search_content` tool.
4. **Protocol honesty** (phase B): one real browser path (Firefox; CDP is
   Chromium-only, BiDi is Firefox's stable story). Not "agnostic".
5. **Fails loud, degrades soft**: config parse error = throw with a clear message;
   a dead backend = next backend tried; a walled site = structured `blocked`
   result (not a crash, not silent garbage).

## Tools

### web_search
| param | type | notes |
|---|---|---|
| `query` / `queries` | string / string[1..4] | parallel; for research prefer 2–4 varied angles |
| `numResults` | int 1–20 (def 5) | per query |
| `timeRange` | `day`\|`week`\|`month`\|`year` | maps to SearXNG `time_range` |
| `domainFilter` | string[] | `example.com` include; `-example.com` exclude; include matches host + subdomains |

Behavior: queries fan out in parallel. Per query, backends are tried **in config
order** with a health cache: a failed backend is skipped for `healthCooldownMs`
(default 5 min) and the next backend is tried. Output per query: numbered
title/URL/snippet list (snippets ≤500 chars).

### web_fetch
| param | type | notes |
|---|---|---|
| `url` / `urls` | string / string[1..5] | parallel |
| `raw` | bool | skip readability, return raw body as text |
| `maxChars` | int 500–100k (def 15k) | inline cap; excess → offload file |
| `mode` | `overview`\|`raw` (def `overview`) | `overview`: long content → type-aware map, not a window. `raw`: classic first-N-chars window |

Pipeline per URL:
1. `fetch()` with browser-ish UA, redirect follow, timeout (def 30 s), hard
   **10 MB** body cap (streamed, abort on exceed).
2. Status handling: 401/403/407/429/503 → `blocked` (bot wall, suggests
   web_browse); other ≥400 → structured error with first 300 chars of body.
3. **Wall heuristics** on 2xx short pages (<4 KB): JS-required, captcha,
   "verify you are human", Cloudflare/Datadome/Geetest markers, "unusual
   traffic", "just a moment" → `blocked` + reason + hint.
4. Content-type dispatch:
   - `text/html` (or HTML-looking body) → **linkedom** parse → **@mozilla/
     readability** article → **turndown** markdown; if the article is thin
     (<200 chars), strip chrome (`nav/header/footer/aside/script/...`) and
     turndown the whole `<body>` instead.
   - PDF (content-type or `%PDF-` magic) → **pdfjs-dist legacy** text, capped at
     `maxPdfPages` (def 100).
   - `image/*` → returned as an **image content block** (base64) in the tool
     result, so the model can actually see it.
   - other text → passthrough (truncated to 4 KB if content-type unknown).
5. Offload: content ≥ `offloadMinChars` (def 2 k) is written to
   `/tmp/pi-my-web/<timestamp>-<host+path>.md` and the path is mentioned in the
   result.

## Config
Built-in defaults deep-merged with `~/.pi/agent/pi-my-web.json`
(`$PI_MY_WEB_CONFIG` overrides the path). Read fresh on every tool call (no
/reload needed for config edits).

```json
{
  "search": {
    "backends": [
      { "name": "searxng-local", "adapter": "searxng-json", "baseUrl": "http://192.168.8.231:9009" }
    ],
    "timeoutMs": 20000,
    "healthCooldownMs": 300000
  },
  "fetch": {
    "userAgent": "Mozilla/5.0 ... Chrome/131",
    "timeoutMs": 30000,
    "maxResponseBytes": 10485760,
    "maxInlineChars": 15000,
    "maxPdfPages": 100,
    "offloadMinChars": 2000,
    "offloadDir": "/tmp/pi-my-web"
  },
  "browse": {
    "profileDir": null,
    "timeoutMs": 45000,
    "visiblePollMs": 120000,
    "viewportWidth": 1366,
    "viewportHeight": 900
  }
}
```

SearXNG = local docker `searxng-core`, JSON format enabled, verified 2026-09-05
at `192.168.8.231:9009` (LAN IP only). The old `priv.au` endpoint (429s) is
kept in `web-search.json` for rollback but ignored by pi-my-web.

## Repo & deployment
- Canonical: `/home/lionel/code/pi-my-web` → GitHub `lbrits/pi-my-web` (**private**
  — LAN IP in defaults).
- Research mirror: `/home/research/code/pi-my-web` (git clone, origin = local
  canonical path, so `git pull` works on the same box; research can't auth to
  GitHub for a private repo).
- Each pi auto-discovers package-style extensions, so deployment = a symlink:
  - `/home/lionel/.pi/agent/extensions/pi-my-web` → `/home/lionel/code/pi-my-web`
  - `/home/research/.pi/agent/extensions/pi-my-web` → `/home/research/code/pi-my-web`
  - `npm install` inside each copy (node_modules per copy; linkedom/readability/
    turndown/pdfjs-dist/typebox).
- Activation: `/reload` (or restart) in each pi session. Rollback: remove the
  symlink + restore the `tools.*.enabled` block in `web-search.json`, then
  /reload.

### Tool-name collision handling
Our `web_search` collides with pi-web-access's `web_search` while both are
loaded. Resolved without renaming: `web-search.json` now sets
`tools.{webSearch,sourceCheck,fetchContent,getSearchContent}.enabled=false`
(the package natively supports per-tool enable flags). Phase C removes the
package outright.

**Config-path trap (found 2026-09-05 during deployment):** the installed
pi-web-access (v0.27.0) reads its config from
`$PI_CODING_AGENT_DIR/web-search.json` → `$XDG_CONFIG_HOME/pi/web-search.json`
→ `~/.pi/web-search.json`. Neither env var is set in real sessions, so the
effective file is **`~/.pi/web-search.json`** — the files under
`~/.pi/agent/web-search.json` (priv.au) are OLD-location leftovers that the
current package never reads. The disables were written to `~/.pi/web-search.json`
for both users; the agent-dir copies were restored to their original content.

## Phase B — web_browse (wall-breaker) — DONE 2026-09-06
- **Browser**: Playwright's own Firefox (Juggler-patched build; stock/
  LibreWolf Firefox can't be driven — Playwright requires its baked-in patch,
  unlike Chromium where CDP is a stable standard protocol). Installed once
  per user: `npx playwright-core install firefox` →
  `~/.cache/ms-playwright/firefox-1543`. `playwright-core` (not `playwright`)
  = zero runtime deps, no postinstall browser download.
- `firefox.launchPersistentContext(profileDir, { headless })`; profile
  defaults to `~/.pi/agent/pi-my-web-browse` (config `browse.profileDir`
  overrides). Cookies survive → many walls clear on retry after the first
  manual clear.
- Two-stage: (1) headless `goto` (timeout `browse.timeoutMs`, default 45 s;
  best-effort `networkidle` 5 s) → wall check; (2) if a **2xx challenge page**
  persists and `browse.visiblePollMs` > 0 (default 120 s): relaunch **visible**
  (stage-1 context fully closed first — profile lock) and poll every 2 s, 
  re-reading the DOM (user may have solved it and navigated on), until the
  wall clears, the window is closed, or the deadline hits.
  4xx/5xx never escalate (a visible window won't help). `visiblePollMs: 0`
  = headless-only mode.
- `page.content()` → same `htmlToMarkdown` pipeline as web_fetch; result
  shape = `FetchOutcome` (same offload + source-adapter post-processing,
  same `formatFetchResults` rendering). Extras: `stage` (1|2) and
  `challengeCleared` in the tool result details.
- No vision involved: text extraction only; the user clears any captcha by
  looking at the visible window themselves (agent just polls the DOM).

## Phase C — retire pi-web-access
1. ~~Remove `"npm:pi-web-access"` from `packages[]` in both users'
   `~/.pi/agent/settings.json`; `npm uninstall` in each `~/.pi/agent/npm`.~~
   **DONE 2026-09-05** — packages set to `[]` on both users. Deviation: module
   intentionally NOT uninstalled (one-line rollback); `web-search.json` kept.
2. ~~Delete both `web-search.json` files~~ — kept as rollback docs.
3. Memory pass: MEMORY.md + daily log (supersede the "use notes_search fallback"
   line and the priv.au references).
4. Regression: `pi-injection-audit.mjs` → expect the 4 npm tool schemas gone and
   our 2–3 present; total system prompt should shrink.

## Phase D — type-aware overview ("bird's-eye view") + source adapters

Goal: stop returning an arbitrary first-15k-chars window for long content.
The full text is offloaded anyway, so the inline part becomes a **navigable
map** instead of a dumb cut. Model-free (design principle 2 holds): structural
extraction, not LLM summarization — the main model (the agent) still does any
real synthesis, and can now jump straight to sections via line numbers.

**When it kicks in:** only when `content.length > maxChars` (exactly where
truncation would have happened). Short content stays fully inline as before.
`mode:'raw'` forces the old window. If no structure is found at all, the
formatter falls back to the raw window (degrade soft, principle 5).

**Layers — first hit wins for the abstract/summary slot:**
1. **Source adapters** (URL registry; extra GET, best-effort, 15 s timeout):
   - `arxiv` — `arxiv.org/{abs,pdf}/<id>` (v1/v2 + old-style ids) → GET
     `arxiv.org/abs/<id>`, linkedom-parse the citation block: title, authors
     (`meta[citation_author]`), abstract (`blockquote.abstract`), comments,
     journal reference, DOI, subjects.
   - `pubmed` — `pubmed.ncbi.nlm.nih.gov/<PMID>/` → NCBI E-utilities
     `efetch.fcgi?db=pubmed&id=<PMID>&rettype=abstract&retmode=text`
     (keyless, 3 req/s) → clean citation+abstract block.
   - `wikipedia` — `<lang>.wikipedia.org/wiki/<Title>` → REST
     `api/rest_v1/page/summary/<title>` JSON (description + lead extract).
     Non-article namespaces (Wikipedia:, Talk:, File:, …) skipped; `m.` → `en`.
2. **Keyword summary detection** (the "grep for `# zusammenfassung`" idea):
   markdown headings normalized + matched against ~90 multilingual keywords
   (en/de/fr/es/it/pt/nl/sv/da/no/fi/pl/cs/sk/hu/ro/bg/ru/uk/el/tr/ja/zh/ko/hi).
   Match = exact or keyword-as-prefix ("Summary of results"). Section text =
   up to the next same-or-higher heading, squashed, ≤4k chars.
3. **PDF keyword scan**: same list, word-boundary search in the first ~6k
   chars of pdfjs text (arXiv PDFs hit "Abstract" on page 1).
4. **Lede**: first non-heading, non-list, non-marker line ≥80 chars, ≤1.2k.
5. **Outline**: markdown heading scan → `{level, text, line, start}` (fence-
   aware: `#` lines inside ``` blocks are ignored). PDFs get **page markers**
   instead: `pdfToText` now emits `[[page N]]` lines, overview lists
   `pN→L<line>`. Line numbers feed directly into `read offset=<line>` — the
   offloaded file is navigable, not a wall. Caps: 50 outline rows, 30 page refs.

**Overview block** (replaces the window): `title/authors/journal/doi` (adapter
metadata, or page title), `abstract/summary` (≤4k), `lede`, `outline (N)`
with `L<line>` per entry, `pages (N)`, and a final `[full text: N chars,
M lines → <offload path> — page with the read tool]` line. Budgeted to
`maxChars`.

**Deliberately NOT doing (yet):**
- **LLM summarizer** — the agent already summarizes; the small-model tier
  (5070 Ti) is the future home of *query-relevant passage extraction*
  (`purpose` param, RAG-lite), not of summarization. Revisit only if the
  structural overview proves thin in practice.
- `purpose` param, cross-URL synthesis, JS-rendered pages (Phase B's job).

**Schema note:** adding `mode` changes the tool schema → one prompt-cache
re-prefill per session on first use (accepted — see pi-lazy-tools verdict;
stable afterwards). Use the typebox-1.x array form:
`Type.Union([…])` (variadic form produced the 09-05 `anyOf.some` crash).

## Verification
- `node test/smoke.ts` — 49 checks: Phase A (search + fetch branches + walls)
  + Phase B (live headless browse; wall + visiblePollMs=0 → blocked) + Phase D
  (offline outline/keyword/adapter-detection units, overview builder, live
  arXiv/PubMed/Wikipedia adapter GETs). Uses a local HTTP server for
  PDF/image/wall fixtures (remote image URLs 404/429 non-deterministically);
  HTML + search hit the real network. Note: this box's LAN DNS cannot resolve
  example.com — browse test uses en.wikipedia.org.
- `/home/lionel/pi-injection-audit.mjs` — dump injected schemas before/after.
- In-session: one live `web_search` call after /reload.

## Known limitations (accepted)
- No YouTube/video extraction, no GitHub auto-clone (agent can `git clone` via
  bash), no hosted fallbacks (Jina Reader etc. could be a later config adapter).
- Search is **fallback**, not merge: no cross-provider result dedup/merge.
- Turndown tables are lossy on complex HTML.
- Wall detection is heuristic; `web_browse` is the escape hatch.

## File tree
```
src/index.ts      tool registration (web_search, web_fetch; web_browse in phase B)
src/config.ts     defaults + per-user json deep-merge
src/types.ts      shared interfaces
src/searxng.ts    the searxng-json adapter
src/search.ts     backend fallback, domain filter, formatting
src/http.ts       fetch wrapper (timeout, size cap)
src/pipeline.ts   html→markdown, pdf→text ([[page N]] markers), image→base64
src/walls.ts      bot-wall heuristics
src/browse.ts     Phase B: two-stage Playwright Firefox browse (wall-breaker)
src/offload.ts    temp-file offload
src/overview.ts   Phase D: source adapters (arxiv/pubmed/wikipedia), keyword
                  summary detection, heading outline, overview builder
src/fetcher.ts    per-URL orchestration + adapter pass + result formatting
                  (mode: overview | raw)
test/smoke.ts     node test/smoke.ts
```
