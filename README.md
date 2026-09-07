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

## Setup
```bash
npm install
ln -s /path/to/pi-my-web ~/.pi/agent/extensions/pi-my-web   # or copy
```
Optional per-user config: `~/.pi/agent/pi-my-web.json` (see PLAN.md for the
schema; defaults include a local SearXNG backend).

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
once per prompt, never duplicated). All of it is configurable under
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
