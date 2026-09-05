import type { FetchConfig } from "./types.ts";

export interface ExtractedText {
  title: string;
  markdown: string;
  kind: "markdown" | "text";
}

export interface ExtractedImage {
  image: { data: string; mimeType: string };
  title: string;
}

const utf8 = new TextDecoder("utf-8", { fatal: false });

export async function htmlToMarkdown(html: string): Promise<ExtractedText> {
  const linkedom: any = await import("linkedom");
  const readabilityMod: any = await import("@mozilla/readability");
  const turndownMod: any = await import("turndown");
  const Readability =
    readabilityMod.Readability ?? readabilityMod.default?.Readability ?? readabilityMod.default;
  const TurndownService = turndownMod.default ?? turndownMod;

  const parsed: any = linkedom.parseHTML(html);
  // linkedom >=0.18 returns the window/global facade (with .document);
  // older versions returned [window, document].
  const doc = parsed?.document ?? (Array.isArray(parsed) ? parsed[1] : parsed);
  const td = new TurndownService({
    headingStyle: "ATX",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
  });

  let article: any = null;
  try {
    article = new Readability(doc).parse();
  } catch {
    /* fall back to full body below */
  }
  let markdown = article?.content ? td.turndown(String(article.content)) : "";
  if (markdown.trim().length < 200) {
    for (const sel of [
      "script", "style", "noscript", "template", "svg", "canvas",
      "header", "footer", "nav", "aside", "form", "iframe", "button",
    ]) {
      doc.querySelectorAll(sel).forEach((e: any) => e.remove());
    }
    const root: any = doc.body ?? doc.documentElement;
    if (root) markdown = td.turndown(root);
  }
  markdown = markdown.replace(/\n{3,}/g, "\n\n").trim();
  return {
    title: String(article?.title ?? doc.title ?? "").trim(),
    markdown,
    kind: "markdown",
  };
}

export async function pdfToText(bytes: Uint8Array, maxPages: number): Promise<ExtractedText> {
  const pdfjs: any = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = pdfjs.getDocument({ data: bytes });
  const doc = await task.promise;
  const pages: string[] = [];
  const n = Math.min(doc.numPages, maxPages);
  for (let i = 1; i <= n; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    let t = "";
    for (const it of tc.items) {
      t += String(it.str ?? "");
      if (it.hasEOL) t += "\n";
    }
    pages.push(t.trim());
  }
  await task.destroy();
  return { title: "", markdown: pages.join("\n\n"), kind: "text" };
}

/**
 * Dispatch on content type. Returns ExtractedText, or ExtractedImage for
 * image/* (base64, so the tool can attach it to the tool result).
 */
export async function extract(
  res: { contentType: string; body: Uint8Array },
  cfg: FetchConfig,
  raw: boolean,
): Promise<ExtractedText | ExtractedImage> {
  const ct = res.contentType.toLowerCase();

  if (ct.startsWith("image/")) {
    return {
      image: {
        data: Buffer.from(res.body).toString("base64"),
        mimeType: ct.split(";")[0].trim(),
      },
      title: "",
    };
  }

  const looksLikePdf =
    ct.includes("pdf") ||
    Buffer.from(res.body.subarray(0, 5)).toString("latin1") === "%PDF-";
  if (looksLikePdf) {
    return await pdfToText(res.body, cfg.maxPdfPages);
  }

  const text = utf8.decode(res.body);
  if (raw) return { title: "", markdown: text, kind: "text" };

  const looksLikeHtml =
    ct.includes("html") || /<(!doctype html|html[\s>])/i.test(text.slice(0, 1000));
  if (looksLikeHtml) return await htmlToMarkdown(text);

  if (ct.startsWith("text/") || ct === "" || /\b(xml|json)\b/i.test(ct)) {
    return { title: "", markdown: text, kind: "text" };
  }
  return { title: "", markdown: text.slice(0, 4000), kind: "text" };
}
