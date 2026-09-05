export interface BackendConfig {
  name: string;
  adapter: string;
  baseUrl: string;
}

export interface SearchConfig {
  backends: BackendConfig[];
  timeoutMs: number;
  healthCooldownMs: number;
}

export interface FetchConfig {
  userAgent: string;
  timeoutMs: number;
  maxResponseBytes: number;
  maxInlineChars: number;
  maxPdfPages: number;
  offloadMinChars: number;
  offloadDir: string | null;
}

export interface PiMyWebConfig {
  search: SearchConfig;
  fetch: FetchConfig;
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  engine?: string;
}

export interface QueryOutcome {
  query: string;
  ok: boolean;
  backend?: string;
  results: SearchResult[];
  error?: string;
}

export interface FetchOutcome {
  url: string;
  ok: boolean;
  finalUrl?: string;
  status?: number;
  contentType?: string;
  bytes?: number;
  title?: string;
  kind: "markdown" | "text" | "image" | "blocked" | "error";
  content?: string;
  image?: { data: string; mimeType: string };
  blocked?: boolean;
  reason?: string;
  offload?: string;
}
