/**
 * Central data model of Bello.
 *
 * Conventions:
 * - All `*At` / `start*` / `time` fields named "relative" are milliseconds relative to the
 *   scenario's navigation start (t = 0, see {@link TimingMarkers.navigationStart}).
 *   They may be negative (e.g. a speculative DNS lookup before navigation was recorded).
 * - Absolute timestamps are epoch milliseconds (`Date.now()` scale) and are named `*Epoch`
 *   or documented as such.
 * - Identifiers and enum values are English or fixed German tokens; every human readable
 *   text that ends up in a report (`title`, `description`, `fix`, …) is German.
 */

/** Schema version of `report.json`. Bump on breaking changes. */
export const SCHEMA_VERSION = 1 as const;

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

/** A = no interaction, B = reject all, C = accept all (PLAN §3). */
export type ScenarioId = 'A' | 'B' | 'C';

export const SCENARIO_IDS: readonly ScenarioId[] = ['A', 'B', 'C'];

/** Evidence directory name per scenario (PLAN §10). */
export const SCENARIO_DIR: Readonly<Record<ScenarioId, string>> = {
  A: 'A-no-interaction',
  B: 'B-reject',
  C: 'C-accept',
};

/** German display label per scenario. */
export const SCENARIO_LABEL: Readonly<Record<ScenarioId, string>> = {
  A: 'Keine Interaktion',
  B: 'Alle ablehnen',
  C: 'Alle akzeptieren',
};

/**
 * Whether a scenario could be executed completely. Bello must never report "grün" for a
 * scenario that was not executed (PLAN §7).
 */
export type ScenarioStatus =
  | { state: 'vollstaendig' }
  | {
      state: 'unvollstaendig';
      /** Machine-readable reason. */
      reasonCode:
        | 'banner-nicht-bedienbar'
        | 'banner-nicht-gefunden'
        | 'navigation-fehlgeschlagen'
        | 'bot-schutz'
        | 'timeout'
        | 'browser-fehler'
        /** Capture evidence missing/implausible (NetLog sanity check, capture hook failed). */
        | 'kein-mitschnitt'
        | 'sonstiges';
      /** German explanation for the report. */
      reason: string;
    };

// ---------------------------------------------------------------------------
// Severity & traffic light
// ---------------------------------------------------------------------------

export type Severity = 'KRITISCH' | 'HOCH' | 'MITTEL' | 'INFO';

/** Ordered from most to least severe. */
export const SEVERITY_ORDER: readonly Severity[] = ['KRITISCH', 'HOCH', 'MITTEL', 'INFO'];

/** Overall result (PLAN §7 "Gesamtampel"). */
export type TrafficLight = 'rot' | 'gelb' | 'gruen';

// ---------------------------------------------------------------------------
// Timing
// ---------------------------------------------------------------------------

/** Reference points of a scenario run. All but `navigationStart` are relative ms. */
export interface TimingMarkers {
  /** Epoch ms at which `page.goto()` was issued. This is t = 0 for every relative time. */
  navigationStart: number;
  /** When the CMP script was loaded/initialised (relative ms), if detected. */
  cmpLoadedAt?: number;
  /** When the banner button (reject/accept) was clicked (relative ms). */
  bannerClickAt?: number;
  /** Start of the passive reader's scroll phase (relative ms). */
  scrollPhaseStartAt?: number;
  /** End of the passive reader's scroll phase on the landing page (relative ms). */
  scrollPhaseEndAt?: number;
  /** DOMContentLoaded / load of the main document (relative ms). */
  domContentLoadedAt?: number;
  loadAt?: number;
  /** End of capture, i.e. browser close was initiated (relative ms). */
  endAt?: number;
}

// ---------------------------------------------------------------------------
// Network: requests (CDP)
// ---------------------------------------------------------------------------

/** How a request was triggered (simplified CDP initiator, PLAN §5.2). */
export type InitiatorType = 'parser' | 'script' | 'preload' | 'preconnect' | 'other';

export interface StackFrameRef {
  url: string;
  functionName?: string;
  /** 1-based line / column (converted from CDP's 0-based values). */
  line?: number;
  column?: number;
}

export interface RequestInitiator {
  type: InitiatorType;
  /** Document (parser) or script URL that caused the request. */
  url?: string;
  /** 1-based line/column inside `url` (parser: HTML line; script: call site). */
  line?: number;
  column?: number;
  /** Flattened JS stack (top frame first), including async parents. */
  stack?: StackFrameRef[];
  /** CDP request id of the initiating request (e.g. for redirects / preload). */
  requestId?: string;
}

export interface RequestRecord {
  /** CDP request id (unique within one browser target; prefixed with the session for OOPIFs). */
  id: string;
  url: string;
  /** Lower-case host name of `url`. */
  host: string;
  method: string;
  /** CDP resource type, e.g. Document, Script, Stylesheet, Font, Image, XHR, Fetch, Other. */
  resourceType: string;
  /** URL of the frame document that issued the request (if known). */
  frameUrl?: string;
  frameId?: string;
  /** True if the request was captured in an out-of-process iframe target. */
  oopif?: boolean;
  initiator: RequestInitiator;
  /** Relative ms when the request was about to be sent. */
  startTime: number;
  /** Relative ms when the response headers / failure arrived. */
  endTime?: number;
  /** HTTP status code (absent for failed requests). */
  status?: number;
  /** Remote IP / port as reported by CDP. */
  remoteIp?: string;
  remotePort?: number;
  failed?: boolean;
  /** e.g. `net::ERR_ABORTED`, `net::ERR_BLOCKED_BY_CLIENT`. */
  errorText?: string;
  canceled?: boolean;
  /** CDP blockedReason (e.g. `inspector`, `mixed-content`, `coep-frame-resource-needs-coep-header`). */
  blockedReason?: string;
  /** Request is a redirect hop that got replaced by another request with the same id. */
  redirectedTo?: string;
  /** Raw Set-Cookie headers from responseReceivedExtraInfo (incl. blocked ones). */
  setCookies?: SetCookieRecord[];
  /**
   * Request body (UTF-8, truncated to 64 KiB). Only captured for Google consent-mode endpoints
   * (GA4 batches carry `gcs`/`gcd` in the POST body).
   */
  postData?: string;
}

export interface SetCookieRecord {
  /** Raw Set-Cookie header line. */
  raw: string;
  name?: string;
  domain?: string;
  /** If Chromium blocked the cookie: CDP blocked reasons. */
  blockedReasons?: string[];
}

// ---------------------------------------------------------------------------
// Network: sockets (NetLog)
// ---------------------------------------------------------------------------

export interface DnsPhase {
  /** First resolution start (relative ms). */
  startTime: number;
  /** Resolution end (relative ms), if seen. */
  endTime?: number;
  /** Resolved addresses (IPv4/IPv6 without port). */
  addresses: string[];
  /** Resolution error (e.g. net error code) if it failed. */
  error?: number;
}

export interface TcpPhase {
  /** First TCP connect start (relative ms). */
  startTime: number;
  endTime?: number;
  /** Destination(s) actually connected / attempted, as `ip:port`. */
  remoteAddresses: string[];
  /** Number of TCP connect attempts (SYN sent) to this host. */
  count: number;
  /** True if at least one connect succeeded (handshake completed). */
  connected: boolean;
}

export interface TlsPhase {
  startTime: number;
  endTime?: number;
  /** Server name indication sent (derived from the socket group; equals the host). */
  sni?: string;
  count: number;
  /** True if at least one handshake completed. */
  established: boolean;
  /** Negotiated protocol version of the first successful handshake, e.g. `TLS 1.3`. */
  version?: string;
}

export interface QuicPhase {
  /** First QUIC session creation (Initial packet sent), relative ms. */
  startTime: number;
  /** Peer addresses (`ip:port`) seen in received packets. */
  remoteAddresses: string[];
  count: number;
}

/** Everything the NetLog tells us about connections to one host (PLAN §5.1). */
export interface HostConnection {
  /** Lower-case host name (no port). */
  host: string;
  /** Ports seen (from socket groups / URLs). */
  ports: number[];
  dns?: DnsPhase;
  tcp?: TcpPhase;
  tls?: TlsPhase;
  quic?: QuicPhase;
  /** All remote IPs this host connected to or attempted (TCP/QUIC), deduplicated, no port. */
  remoteIps: string[];
  /** URL requests (URL_REQUEST_START_JOB) to this host, including aborted ones. */
  urlRequests: NetLogUrlRequest[];
  /**
   * True if a socket was opened to this host (TCP/QUIC) but no URL request was ever started
   * for it, e.g. `<link rel="preconnect">` or a speculative connection.
   */
  wasPreconnectOnly: boolean;
  /** True if the socket pool reported preconnect activity for this host. */
  sawPreconnect: boolean;
  /** Earliest relative time of anything we saw for this host. */
  firstSeen: number;
  /**
   * Earliest time at which the user's IP was transmitted to this host, i.e. first TCP connect
   * or QUIC session start. Undefined if only DNS happened.
   */
  firstConnectAt?: number;
  /**
   * Strongest socket-level evidence for this host:
   * `none` = only a URL request record (e.g. failed before DNS), `dns` = name resolution only
   * (weak indication), `connect` = TCP SYN / QUIC Initial sent (IP transmitted),
   * `tls` = TLS ClientHello sent (IP + SNI transmitted).
   */
  level: 'none' | 'dns' | 'connect' | 'tls';
  /** At least one URL request (URL_REQUEST_START_JOB) targeted this host. */
  requested: boolean;
  /** Filled by {@link correlate} (capture/cdp): CDP requests explaining this connection. */
  causes?: ConnectionCause[];
  /**
   * Synthesised by the analysis from a CDP request that failed (e.g. `net::ERR_ABORTED`) to a host
   * that does not appear in the NetLog at all: a connection attempt that can neither be proven
   * nor ruled out on socket level.
   */
  unverified?: boolean;
}

export interface NetLogUrlRequest {
  url: string;
  method?: string;
  /** Relative ms of URL_REQUEST_START_JOB. */
  startTime: number;
  /** Net error if the request failed / was aborted (e.g. -3 = ERR_ABORTED). */
  netError?: number;
  aborted: boolean;
  /**
   * True if the request headers were actually sent to the server (HTTP_TRANSACTION_SEND_REQUEST
   * or the HTTP/2 / QUIC send-headers events). Requests riding a pooled (coalesced) HTTP/2 or
   * QUIC session have no own socket, so this is the only proof that data reached the host.
   */
  headersSent?: boolean;
  /** Chromium request type, e.g. `main frame`, `subframe`, `other`. */
  requestType?: string;
  /** Initiating origin, `not an origin` for browser-initiated requests (navigation, Chrome internals). */
  initiatorOrigin?: string;
  /** `<top-frame-site> <frame-site>`, identifies the frame context (useful for iframes). */
  networkIsolationKey?: string;
  /** NetLog source id (for debugging/evidence references). */
  sourceId: number;
}

/** Correlation of a socket-level connection with the CDP request(s) that caused it. */
export interface ConnectionCause {
  requestId: string;
  url: string;
  initiator: RequestInitiator;
  resourceType: string;
  frameUrl?: string;
  /** How the correlation was established. */
  match: 'url' | 'host-time' | 'preconnect-hint';
  /** |requestStart - connectStart| in ms (for host-time matches). */
  deltaMs?: number;
}

// ---------------------------------------------------------------------------
// Storage, fingerprinting, consent mode (filled by later slices)
// ---------------------------------------------------------------------------

/** Checkpoints at which storage is snapshotted (PLAN §5.3). */
export type StorageCheckpoint = 'nach-laden' | 'nach-klick' | 'ende';

export interface CookieRecord {
  name: string;
  domain: string;
  path: string;
  /** Epoch seconds, -1 for session cookies (Playwright convention). */
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
  /** First-party relative to the scanned site. */
  firstParty?: boolean;
  /** Where we saw it. */
  source: 'context' | 'set-cookie';
  checkpoint?: StorageCheckpoint;
  /** Value is hashed/truncated before storing in evidence. */
  valuePreview?: string;
  /** Matched vendor/tracking-cookie pattern (classification slice). */
  trackingMatch?: TrackingMatchRef;
  /** True if recognised as the CMP's own consent cookie (not a finding). */
  isConsentCookie?: boolean;
}

export interface StorageRecord {
  kind: 'localStorage' | 'sessionStorage' | 'indexedDB';
  /** Origin of the frame the storage belongs to. */
  origin: string;
  frameUrl?: string;
  /** Key (local/sessionStorage) or database name (IndexedDB). */
  key: string;
  valuePreview?: string;
  checkpoint: StorageCheckpoint;
  trackingMatch?: TrackingMatchRef;
  /** True if recognised as the CMP's own consent state (not a finding). */
  isConsentKey?: boolean;
}

/** Vendor pattern a cookie / storage key matched. */
export interface TrackingMatchRef {
  vendor: string;
  pattern: string;
  /** Vendor display name. */
  vendorName?: string;
  /**
   * Vendor category (documentation). Every match counts as tracking unless the vendor is a CMP or
   * the matched entry is explicitly marked `necessary` in the vendor list.
   */
  category?: VendorCategory;
  /** The vendor list marks this cookie/key as technically necessary (e.g. bot protection). */
  necessary?: boolean;
}

export type FingerprintApi =
  | 'canvas.toDataURL'
  | 'canvas.toBlob'
  | 'canvas.getImageData'
  | 'webgl.getParameter'
  | 'webgl.getSupportedExtensions'
  | 'audio.OfflineAudioContext'
  | 'audio.AudioContext'
  | 'navigator.plugins'
  | 'navigator.mimeTypes'
  | 'navigator.hardwareConcurrency'
  | 'navigator.deviceMemory'
  | 'font.measureText'
  | (string & {});

export interface FingerprintEvent {
  api: FingerprintApi;
  /** Relative ms. */
  time: number;
  frameUrl?: string;
  /** Script URL derived from the call stack. */
  scriptUrl?: string;
  stack?: StackFrameRef[];
  /** Extra details, e.g. WebGL parameter name or font name. */
  detail?: string;
  count?: number;
}

/** A Google request carrying Consent Mode parameters (PLAN §5.5). */
export interface ConsentModePing {
  requestId?: string;
  url: string;
  host: string;
  /** Relative ms. */
  time: number;
  gcs?: string;
  gcd?: string;
  npa?: string;
  dma?: string;
  dmaCps?: string;
  /** Interpretation of gcs (e.g. G100 = ad+analytics denied). */
  adStorage?: 'granted' | 'denied';
  analyticsStorage?: 'granted' | 'denied';
  /** Decoded from gcd (best effort). */
  adUserData?: 'granted' | 'denied' | 'unbekannt';
  adPersonalization?: 'granted' | 'denied' | 'unbekannt';
  /** Ping sent while consent was denied → "Advanced Mode". */
  advancedMode: boolean;
}

// ---------------------------------------------------------------------------
// Classification & findings
// ---------------------------------------------------------------------------

export type VendorCategory =
  | 'werbung'
  | 'analyse'
  | 'video'
  | 'karten'
  | 'fonts'
  | 'cdn'
  | 'zahlung'
  | 'bot-schutz'
  | 'social'
  | 'tag-manager'
  | 'cmp'
  | 'sonstiges'
  | (string & {});

/** Result of classifying a host (PLAN §6). */
export interface Classification {
  host: string;
  /** Which classification stage decided. */
  stage: 'first-party' | 'allowlist' | 'vendors' | 'easyprivacy' | 'dbip' | 'unbekannt';
  firstParty: boolean;
  /** Registrable domain (eTLD+1). */
  registrableDomain?: string;
  vendor?: {
    id: string;
    name: string;
    /** ISO 3166-1 alpha-2 country of the company seat. */
    country?: string;
    category?: VendorCategory;
    fix?: string;
  };
  /** Customer allowlist entry that matched. */
  allowlist?: { host: string; reason: string };
  /** Host matched an EasyPrivacy domain rule. */
  easyPrivacy?: boolean;
  /** Geolocation of the actually connected IP (DB-IP). */
  ipInfo?: { ip: string; country?: string; asn?: number; asOrg?: string };
  /** True if company seat or IP is outside the EU/EEA (third country). */
  thirdCountry?: boolean;
}

/** Root-cause classes (PLAN §8). */
export type CauseClass =
  | 'html-quelltext'
  | 'resource-hint'
  | 'script-vor-cmp'
  | 'nachgeladen-durch-script'
  | 'nach-ablehnen'
  | 'consent-mode-advanced'
  | 'lazy-load-scroll'
  | 'unbekannt';

export type FindingCategory =
  | 'drittverbindung'
  | 'nur-dns'
  | 'cookie'
  | 'storage'
  | 'fingerprinting'
  | 'consent-mode'
  | 'banner'
  | 'datenschutzerklaerung'
  | 'sonstiges';

/** Reference into the evidence bundle. */
export interface EvidenceRef {
  scenario?: ScenarioId;
  /** Path relative to the report directory, e.g. `evidence/A-no-interaction/netlog.json`. */
  file?: string;
  /** e.g. NetLog source id, CDP request id, cookie name. */
  pointer?: string;
  /** Source snippet (raw HTML) with line number. */
  snippet?: { text: string; line?: number };
}

export interface Finding {
  /** Stable id (hash of category/host/cause) so `bello diff` can match findings across runs. */
  id: string;
  severity: Severity;
  scenarios: ScenarioId[];
  category: FindingCategory;
  host?: string;
  vendor?: string;
  /** ISO country code (vendor seat or IP location). */
  country?: string;
  causeClass?: CauseClass;
  /** German title, e.g. "Verbindung zu www.youtube.com vor Einwilligung". */
  title: string;
  /** German description incl. timing ("38 ms nach Navigationsstart, 412 ms bevor …"). */
  description: string;
  /** German fix recommendation. */
  fix?: string;
  /** Relative times of the triggering event per scenario. */
  timing?: Partial<Record<ScenarioId, number>>;
  evidence: EvidenceRef[];
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export interface BannerInfo {
  found: boolean;
  /** CMP name as detected by autoconsent or heuristics. */
  cmp?: string;
  method?: 'autoconsent' | 'heuristik' | 'selektor';
  /** Reject on first layer available. */
  rejectFirstLayer?: boolean;
  clicked?: 'reject' | 'accept';
  /** When the banner was first seen (relative ms). */
  detectedAt?: number;
  /** Second layer handling (reject not on the first layer). */
  secondLayer?: {
    tried: boolean;
    succeeded: boolean;
    via?: string;
    uncheckedToggles?: number;
  };
}

export interface ScenarioResult {
  scenario: ScenarioId;
  url: string;
  status: ScenarioStatus;
  timing: TimingMarkers;
  /** Chromium version used for this run. */
  browserVersion?: string;
  banner?: BannerInfo;
  connections: HostConnection[];
  requests: RequestRecord[];
  cookies: CookieRecord[];
  storage: StorageRecord[];
  fingerprinting: FingerprintEvent[];
  consentMode: ConsentModePing[];
  /** Evidence files relative to the report directory. */
  evidenceFiles: string[];
}

export interface ScanMetadata {
  /** ISO UTC timestamp of scan start. */
  startedAt: string;
  finishedAt?: string;
  belloVersion: string;
  chromiumVersion?: string;
  exitIp?: string;
  exitCountry?: string;
  /** Exit-IP check (PLAN §4): skipped, failed, or result incl. EU verdict. */
  exitIpCheck?: {
    status: 'ok' | 'nicht-eu' | 'unbekannt' | 'fehlgeschlagen' | 'uebersprungen';
    /** True if the exit IP is located in the EU/EEA. */
    inEu?: boolean;
    /** German note/warning. */
    message?: string;
    /** IP echo service used. */
    service?: string;
  };
  /**
   * Command line of the scan. Credentials are redacted (`user:pass@` in URLs and the value of
   * `--proxy`).
   */
  commandLine: string[];
  /** Customer id from the configuration (`--customer`), if any. */
  customerId?: string;
  /** True if the scan ran in crawl mode (several pages of the site). */
  crawl: boolean;
  /** Absolute path of the configuration file (absent = built-in defaults). */
  configPath?: string;
  /** SHA-256 (hex) of the configuration file. */
  configHash?: string;
  /** Proxy server used for the scan (credentials removed). */
  proxy?: string;
  /** Data sets that were not available (classification degraded). */
  unavailableData?: string[];
  /** Non-fatal problems during the scan (German). */
  warnings?: string[];
  /** Source attributions shown in reports (e.g. "IP-Geolokation: DB-IP.com"). */
  attributions?: string[];
}

/** Banner design checks of one page (PLAN §7 "Banner-Design-Prüfungen"). */
export interface BannerDesignCheck {
  rejectFirstLayer?: boolean;
  imprintReachable?: boolean;
  privacyPolicyReachable?: boolean;
  /** German explanations. */
  details: string[];
}

/** Privacy policy comparison (PLAN §5.7). */
export interface PrivacyPolicyCheck {
  /** URL of the privacy policy (absent = not found). */
  url?: string;
  /** Evidence file with the extracted text, relative to the report directory. */
  file?: string;
  /** Vendor names mentioned / missing in the text. */
  mentioned: string[];
  missing: string[];
  /** German note if the check could not be performed. */
  error?: string;
}

/** Result of one page (start page in quick mode, every crawled page in crawl mode). */
export interface PageResult {
  url: string;
  scenarios: ScenarioResult[];
  bannerDesign?: BannerDesignCheck;
  privacyPolicy?: PrivacyPolicyCheck;
}

/** Explanation of the traffic light (PLAN §7). */
export interface Assessment {
  trafficLight: TrafficLight;
  /** German label, e.g. "Gelb – manuelle Prüfung nötig". */
  label: string;
  /** True if at least one scenario could not be executed completely. */
  manualReview: boolean;
  /** Scenarios that count as incomplete. */
  incomplete: Array<{ page: string; scenario: ScenarioId; reasonCode: string; reason: string }>;
  /**
   * Scenarios whose status was `banner-nicht-gefunden` but that do not count as incomplete
   * because the site showed no third-party activity at all (no banner needed).
   */
  neutralized: Array<{ page: string; scenario: ScenarioId; reason: string }>;
  /** Number of findings per severity. */
  counts: Record<Severity, number>;
  /** German one-line reasons for the traffic light. */
  reasons: string[];
}

export interface ScanReport {
  schemaVersion: typeof SCHEMA_VERSION;
  /** Scanned (start) URL. */
  url: string;
  customer?: string;
  meta: ScanMetadata;
  trafficLight: TrafficLight;
  /** Why the traffic light has its colour (added with the analysis). */
  assessment?: Assessment;
  /** Per page (crawl) and scenario; quick-check has one page. */
  pages: PageResult[];
  classifications: Classification[];
  findings: Finding[];
  /** SHA-256 of evidence/manifest.json. */
  manifestHash?: string;
  /** Legal disclaimer (German). */
  disclaimer?: string;
}
