/**
 * Interactive challenges: pages a real (visible) browser can plausibly pass —
 * JS browser checks, captchas, bot-manager challenges. Bot managers
 * (Cloudflare & co.) often serve these with HTTP 403.
 */
const CHALLENGE_PATTERNS: Array<[RegExp, string]> = [
  [/are you (a |an )?robot/i, "bot check"],
  [/\bcaptcha\b/i, "captcha"],
  [/\bplease enable javascript\b/i, "JS-required wall"],
  [/\bverify (that )?you('?re| are)( a |an )?(human|not a robot)/i, "human verification"],
  [/\bhuman verification\b/i, "human verification"],
  [/cf-chl|challenge-platform|datadome|distil\.net|geetest/i, "CDN/bot-manager challenge"],
  [/\battention required\b/i, "attention required (Cloudflare)"],
  [/\bjust a moment\b|\bchecking your browser\b/i, "browser check"],
];

/** Static refusals: a visible window will not help. */
const REFUSAL_PATTERNS: Array<[RegExp, string]> = [
  [/\bunusual traffic\b/i, "rate-limit wall"],
  [/\baccess denied\b/i, "access denied"],
  [/\brequest blocked\b/i, "request blocked"],
];

export interface BodyWall {
  blocked: boolean;
  reason?: string;
  /** true when an interactive challenge matched (a visible browser may clear it) */
  challenge: boolean;
}

/**
 * Strip <style> and <script> blocks. Challenge pages often ship a lot of
 * inline CSS/JS (e.g. the AltCHA widget) that bloats the raw HTML past the
 * size gate while the visible content is tiny; patterns should run on what's
 * left.
 */
function withoutAssets(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ");
}

/**
 * Body-only wall heuristics (status-agnostic). Used where a stale status
 * must not matter — e.g. stage-2 polling, where the response status is still
 * the initial goto's (often the challenge's 403) after the user cleared the
 * challenge in the visible window.
 */
export function wallFromBody(html: string): BodyWall {
  const text = withoutAssets(html);
  if (text.length > 4000) return { blocked: false, challenge: false };
  for (const [re, why] of CHALLENGE_PATTERNS) {
    if (re.test(text)) return { blocked: true, reason: why, challenge: true };
  }
  for (const [re, why] of REFUSAL_PATTERNS) {
    if (re.test(text)) return { blocked: true, reason: why, challenge: false };
  }
  return { blocked: false, challenge: false };
}

/**
 * Heuristic bot-wall detection. Status-based walls plus short pages whose body
 * looks like a challenge. Returns blocked:false for normal 2xx/3xx and for
 * other 4xx/5xx (those are plain errors, reported by the caller with status).
 */
export function detectWall(opts: { status: number; text: string }): { blocked: boolean; reason?: string } {
  if ([401, 403, 407, 429, 503].includes(opts.status)) {
    const body = wallFromBody(opts.text);
    return {
      blocked: true,
      reason: body.reason ? `HTTP ${opts.status} (${body.reason})` : `HTTP ${opts.status}`,
    };
  }
  if (opts.status < 200 || opts.status >= 400) return { blocked: false };
  const body = wallFromBody(opts.text);
  return body.blocked ? { blocked: true, reason: body.reason } : { blocked: false };
}
