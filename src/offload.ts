import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Write full extracted content to a temp file so the agent can page through
 * it with the read tool instead of burning context. Returns the path.
 */
export function offloadContent(dir: string, url: string, content: string): string {
  mkdirSync(dir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
  let slug = "fetch";
  try {
    const u = new URL(url);
    slug = u.hostname + (u.pathname.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(-60) || "");
  } catch {
    /* keep default slug */
  }
  const path = join(dir, `${ts}-${slug}.md`);
  writeFileSync(path, content, "utf8");
  return path;
}
