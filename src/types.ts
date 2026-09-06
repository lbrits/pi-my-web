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

export interface BrowseConfig {
  /** null → default per-user profile dir (~/.pi/agent/pi-my-web-browse) */
  profileDir: string | null;
  /** per-navigation timeout */
  timeoutMs: number;
  /** stage-2 visible-window wait for the user to clear a challenge; 0 = headless only */
  visiblePollMs: number;
  viewportWidth: number;
  viewportHeight: number;
}

export interface PiMyWebConfig {
  search: SearchConfig;
  fetch: FetchConfig;
  browse: BrowseConfig;
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
  /** URL of the interstitial page a site adapter auto-followed from */
  followedFrom?: string;
  /** Phase D: authoritative source metadata (arXiv/PubMed/Wikipedia adapter) */
  meta?: {
    source: string;
    title?: string;
    abstract?: string;
    authors?: string;
    doi?: string;
    extra?: string;
  };
}
