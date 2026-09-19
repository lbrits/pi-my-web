# pi-my-web

Slim web-access extension for [pi](https://github.com/badlogic/pi-mono) coding
agent. Replaces the `pi-web-access` npm package with small, local,
backend-agnostic tools.

**See [PLAN.md](PLAN.md) for the full design, phases, and deployment notes.**

## Tools
- **web_search** — SearXNG-backed (config lists backends, tried in order with
  automatic fallback). Parallel multi-query, recency + domain filters.
- **web_fetch** — HTML→readability→markdown, PDF→pdfjs text, images returned
  as image attachments, long content offloaded to a temp file, bot-wall
  detection with structured `blocked` results, and site adapters
  (`src/adapters/`, one little .ts per site) that auto-follow interstitial
  pages to the real document (currently: Sci-Hub paper page → PDF).
- **web_browse** — wall-breaker: renders the URL in a real Firefox (Playwright,
  persistent per-user profile). Headless first; if a bot challenge is still up,
  relaunches with a **visible** window and waits up to 2 min for the user to
  clear it, then re-reads the page. Same result shape as `web_fetch`.
  Use when `web_fetch` comes back `blocked`.

## Setup
**Usual way — install as a pi package** (pi clones the repo and runs
`npm install` for you; ref-pinned, updated via `pi update --extensions`):
```bash
pi install git:github.com/lbrits/pi-my-web
```
Then start pi (or `/reload`). `web_fetch` works immediately. Two optional
extras:

- **web_browse (bot walls)** needs a browser, one time (~110 MB, no root):
  `npx playwright-core install firefox` (run inside the package directory,
  e.g. `~/.pi/agent/git/github.com/lbrits/pi-my-web`; or from anywhere:
  `npx -p playwright-core playwright-core install firefox`). It downloads
  Playwright's own Firefox build (stock/LibreWolf can't be driven) into
  `~/.cache/ms-playwright/`; the persistent profile lives at
  `~/.pi/agent/pi-my-web-browse/`.
- **web_search** needs a SearXNG instance. The built-in default points at the
  author's LAN copy — set `search.backends` in the config to your own
  (the official Docker image serves the `format=json` API out of the box):
  `docker run -d -p 8080:8080 searxng/searxng:latest`

**Dev install** (editable local checkout):
```bash
git clone https://github.com/lbrits/pi-my-web && cd pi-my-web
npm install
ln -s $PWD ~/.pi/agent/extensions/pi-my-web
```

Per-user config: `~/.pi/agent/pi-my-web.json` (or `$PI_MY_WEB_CONFIG`); see
PLAN.md for the schema.

## Logging & health report
Both tools log every outcome (JSONL) so failures are visible without reading
thinking traces:
- `~/.pi/agent/pi-my-web/requests.jsonl` — one line per URL/query (tool, ok,
  status, blocked, stage, ms)
- `~/.pi/agent/pi-my-web/errors.jsonl` — failures only, with a `kind`:
  `bot-wall`, `timeout`, `not-found`, `http-error`, `network`, `backend-down`,
  `usage`, `exception`

At agent start, if the error log has entries within the health window, a
compact “pi-my-web health” block is appended to the system prompt (injected
once per prompt, never duplicated; `not-found`/404s are kept out of the
block since a missing page is a content miss, not a broken tool). All of it is configurable under
`logging` in the config file:

```json
{
  "logging": {
    "requests": true,
    "errors": true,
    "healthReport": true,
    "retentionDays": 30,
    "healthWindowDays": 7,
    "dir": null
  }
}
```

(`dir: null` → `~/.pi/agent/pi-my-web`. Logging is best-effort: a logging
failure can never break a tool call or the agent loop.)

## Test
```bash
node test/smoke.ts
```
