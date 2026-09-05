export interface DownloadedResponse {
  status: number;
  finalUrl: string;
  contentType: string;
  body: Uint8Array;
}

export class SizeExceededError extends Error {}

/**
 * Download a URL with browser-ish headers, a timeout, and a hard size cap.
 */
export async function download(
  url: string,
  opts: { userAgent: string; timeoutMs: number; maxBytes: number; signal?: AbortSignal },
): Promise<DownloadedResponse> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error(`timeout after ${opts.timeoutMs}ms`)),
    opts.timeoutMs,
  );
  const onOuter = () => controller.abort();
  opts.signal?.addEventListener("abort", onOuter, { once: true });
  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "user-agent": opts.userAgent,
        accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,application/pdf;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "accept-language": "en-US,en;q=0.9",
      },
    });
    const chunks: Uint8Array[] = [];
    let total = 0;
    if (res.body) {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > opts.maxBytes) {
          await reader.cancel().catch(() => {});
          throw new SizeExceededError(`response exceeds ${Math.round(opts.maxBytes / 1024 / 1024)} MB`);
        }
        chunks.push(value);
      }
    } else {
      chunks.push(new Uint8Array(await res.arrayBuffer()));
      total = chunks[0].byteLength;
    }
    const body = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      body.set(c, off);
      off += c.byteLength;
    }
    return {
      status: res.status,
      finalUrl: res.url || url,
      contentType: res.headers.get("content-type") ?? "",
      body,
    };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onOuter);
  }
}
