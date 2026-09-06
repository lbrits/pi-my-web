const WALL_PATTERNS: Array<[RegExp, string]> = [
  [/are you (a |an )?robot/i, "bot check"],
  [/\bcaptcha\b/i, "captcha"],
  [/\bplease enable javascript\b/i, "JS-required wall"],
  [/\bverify (that )?you('?re| are)( a |an )?(human|not a robot)/i, "human verification"],
  [/\bhuman verification\b/i, "human verification"],
  [/cf-chl|challenge-platform|datadome|distil\.net|geetest/i, "CDN/bot-manager challenge"],
  [/\bunusual traffic\b/i, "rate-limit wall"],
  [/\baccess denied\b/i, "access denied"],
  [/\brequest blocked\b/i, "request blocked"],
  [/\battention required\b/i, "attention required (Cloudflare)"],
  [/\bjust a moment\b|\bchecking your browser\b/i, "browser check"],
];

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
 * Heuristic bot-wall detection. Status-based walls plus short pages whose body
 * looks like a challenge. Returns blocked:false for normal 2xx/3xx and for
 * other 4xx/5xx (those are plain errors, reported by the caller with status).
 */
export function detectWall(opts: { status: number; text: string }): { blocked: boolean; reason?: string } {
  if ([401, 403, 407, 429, 503].includes(opts.status)) {
    return { blocked: true, reason: `HTTP ${opts.status}` };
  }
  if (opts.status < 200 || opts.status >= 400) return { blocked: false };
  const text = withoutAssets(opts.text);
  if (text.length > 4000) return { blocked: false };
  for (const [re, why] of WALL_PATTERNS) {
    if (re.test(text)) return { blocked: true, reason: why };
  }
  return { blocked: false };
}
