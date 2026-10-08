/**
 * Root-cause classes and fix recommendations (PLAN §8).
 *
 * Inputs: the CDP initiator chain of the connection (via `correlate`), the raw HTML of the
 * landing page (snippet + line number) and the timing markers (CMP load, banner click, scroll
 * phase).
 */
import type {
  CauseClass,
  ConnectionCause,
  ScenarioId,
  StackFrameRef,
  TimingMarkers,
} from '../types.js';
import { oneLine } from './format.js';

/** German label per cause class (PLAN §8 table). */
export const CAUSE_LABEL: Readonly<Record<CauseClass, string>> = {
  'html-quelltext': 'Im HTML-Quelltext (Preload-Scanner, Autoblocker zu spät)',
  'resource-hint': 'Resource-Hint (preconnect/dns-prefetch/preload)',
  'script-vor-cmp': 'Script vor CMP geladen',
  'nachgeladen-durch-script': 'Nachgeladen durch Script',
  'nach-ablehnen': 'Nach Ablehnen geladen',
  'consent-mode-advanced': 'Consent Mode Advanced',
  'lazy-load-scroll': 'Lazy-Load beim Scrollen',
  unbekannt: 'Ursache nicht eindeutig bestimmbar',
};

/** German fix per cause class (PLAN §8 table). */
export const CAUSE_FIX: Readonly<Record<CauseClass, string>> = {
  'html-quelltext':
    'Element nicht mit `src` im HTML ausliefern: `src` → `data-src` (vom CMP erst nach Einwilligung gesetzt), Zwei-Klick-Lösung oder CMP-Embed-Platzhalter verwenden und serverseitig so rendern. Ein Autoblocker, der erst per JavaScript eingreift, kommt zu spät – der Browser hat die Verbindung bereits aufgebaut.',
  'resource-hint':
    'Resource-Hint (`<link rel="preconnect|dns-prefetch|preload">`) entfernen oder erst nach Einwilligung einfügen.',
  'script-vor-cmp':
    'Script mit `type="text/plain"` und dem Dienst-Attribut des CMP versehen (bzw. über das CMP laden), damit es erst nach Einwilligung ausgeführt wird.',
  'nachgeladen-durch-script':
    'Das auslösende Script im CMP als Dienst einordnen, damit es (und alles, was es nachlädt) erst nach Einwilligung läuft.',
  'nach-ablehnen':
    'CMP-Konfiguration des Dienstes prüfen: Nach „Ablehnen“ darf der Dienst nicht geladen werden.',
  'consent-mode-advanced':
    'Google Consent Mode auf „Basic“ umstellen: Google-Tags erst nach Einwilligung laden, keine cookielosen Pings vor bzw. ohne Einwilligung.',
  'lazy-load-scroll':
    'Wie „Im HTML-Quelltext“: `loading="lazy"` verzögert nur, blockiert nicht. `src` → `data-src` / Zwei-Klick-Lösung verwenden.',
  unbekannt:
    'Einbindung des Dienstes im Quelltext und im Tag-Manager suchen und erst nach Einwilligung laden.',
};

/** Where a host appears in the raw HTML. */
export interface HtmlRef {
  /** 1-based line of the enclosing tag (or of the occurrence for text matches). */
  line: number;
  /** Tag (or line) text, collapsed and truncated. */
  text: string;
  /**
   * `src` = element that loads the resource while parsing (src/href of stylesheet/…),
   * `script-src` = `<script src>`, `hint` = resource hint, `other` = anything else
   * (data-src, links, inline JS strings, …).
   */
  kind: 'src' | 'script-src' | 'hint' | 'other';
  tag?: string;
  attribute?: string;
}

const HINT_RELS = /^(?:preconnect|dns-prefetch|preload|prefetch|modulepreload|prerender)$/i;
const LOADING_ATTRS = new Set(['src', 'srcset', 'poster', 'data', 'background', 'imagesrcset']);

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Finds every occurrence of `host` in `html` and classifies the enclosing element. */
export function findHostInHtml(html: string | undefined, host: string): HtmlRef[] {
  if (!html || !host) return [];
  const re = new RegExp(`(?<![a-z0-9.-])${escapeRe(host)}(?![a-z0-9-])`, 'gi');
  const refs: HtmlRef[] = [];
  const seenTags = new Set<number>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const idx = m.index;
    const lt = html.lastIndexOf('<', idx);
    const gtBefore = html.lastIndexOf('>', idx);
    const inTag = lt >= 0 && lt > gtBefore && /^<[a-zA-Z]/.test(html.slice(lt, lt + 2));
    if (inTag) {
      if (seenTags.has(lt)) continue;
      seenTags.add(lt);
      const gt = html.indexOf('>', idx);
      const tagText = html.slice(lt, gt >= 0 ? gt + 1 : Math.min(html.length, idx + 300));
      const tag = /^<([a-zA-Z][\w-]*)/.exec(tagText)?.[1]?.toLowerCase() ?? '';
      const before = html.slice(lt, idx);
      const attr = /([\w:-]+)\s*=\s*["']?[^"'\s>]*$/.exec(before)?.[1]?.toLowerCase() ?? '';
      const rel = /\brel\s*=\s*["']?([^"'>]+)/i.exec(tagText)?.[1]?.trim() ?? '';
      let kind: HtmlRef['kind'] = 'other';
      if (tag === 'link') {
        const rels = rel.split(/\s+/);
        if (attr === 'href' && rels.some((r) => HINT_RELS.test(r))) kind = 'hint';
        else if (attr === 'href' && rels.some((r) => /^(stylesheet|icon|manifest)$/i.test(r)))
          kind = 'src';
      } else if (tag === 'script' && attr === 'src') {
        kind = 'script-src';
      } else if (LOADING_ATTRS.has(attr)) {
        kind = 'src';
      }
      refs.push({
        line: lineOf(html, lt),
        text: oneLine(tagText),
        kind,
        tag,
        ...(attr ? { attribute: attr } : {}),
      });
    } else {
      const ls = html.lastIndexOf('\n', idx) + 1;
      const le = html.indexOf('\n', idx);
      refs.push({
        line: lineOf(html, idx),
        text: oneLine(html.slice(ls, le >= 0 ? le : html.length)),
        kind: 'other',
      });
    }
  }
  return refs;
}

function lineOf(text: string, idx: number): number {
  let n = 1;
  for (let i = text.indexOf('\n'); i >= 0 && i < idx; i = text.indexOf('\n', i + 1)) n++;
  return n;
}

/** Text of a 1-based line of `html`. */
export function htmlLine(html: string | undefined, line: number): string | undefined {
  if (!html || line < 1) return undefined;
  const t = html.split('\n')[line - 1];
  return t === undefined ? undefined : oneLine(t);
}

export interface CauseInput {
  scenario: ScenarioId;
  /** Relative ms of the first connection (or first activity). */
  time: number | undefined;
  timing: Partial<TimingMarkers> & { scrollPhaseEndAt?: number };
  causes: ConnectionCause[];
  wasPreconnectOnly: boolean;
  /** Raw HTML of the landing page and its URL(s) (to match parser initiators). */
  rawHtml?: string;
  pageUrls?: string[];
  host: string;
}

export interface CauseResult {
  causeClass: CauseClass;
  /** German explanation of how the cause was determined. */
  detail: string;
  snippet?: { text: string; line?: number };
  /** Script that triggered the connection (script initiators). */
  scriptUrl?: string;
}

/** Grace period after the scroll phase for lazy-loaded resources (ms). */
const SCROLL_GRACE_MS = 2000;

function scriptOf(c: ConnectionCause): string | undefined {
  const top: StackFrameRef | undefined = c.initiator.stack?.[0];
  return c.initiator.url ?? top?.url;
}

/** Determines the cause class of one A/B connection (PLAN §8). */
export function determineCause(input: CauseInput): CauseResult {
  const { scenario, time, timing, causes } = input;
  const refs = findHostInHtml(input.rawHtml, input.host);
  const parser = causes.find(
    (c) => c.initiator.type === 'parser' || c.initiator.type === 'preload',
  );
  const script = causes.find((c) => c.initiator.type === 'script');
  const hintCause = causes.find((c) => c.match === 'preconnect-hint');
  const pageUrls = new Set(input.pageUrls ?? []);

  // Snippet: prefer the HTML line the parser initiator points at.
  let srcRef: HtmlRef | undefined;
  if (
    parser?.initiator.line !== undefined &&
    (pageUrls.size === 0 || (parser.initiator.url && pageUrls.has(parser.initiator.url)))
  ) {
    const line = parser.initiator.line;
    srcRef =
      refs.find((r) => r.kind !== 'other' && r.kind !== 'hint' && r.line === line) ??
      refs.find((r) => r.line === line);
    if (!srcRef) {
      const text = htmlLine(input.rawHtml, line);
      if (text) srcRef = { line, text, kind: 'src' };
    }
  }
  srcRef ??= refs.find((r) => r.kind === 'src' || r.kind === 'script-src');
  const hintRef = refs.find((r) => r.kind === 'hint');
  const snippetOf = (r: HtmlRef | undefined): CauseResult['snippet'] =>
    r ? { text: r.text, line: r.line } : undefined;
  const withSnippet = (res: CauseResult, r: HtmlRef | undefined): CauseResult => {
    const s = snippetOf(r);
    return s ? { ...res, snippet: s } : res;
  };

  // 1. B: after the reject click.
  if (
    scenario === 'B' &&
    timing.bannerClickAt !== undefined &&
    time !== undefined &&
    time >= timing.bannerClickAt
  ) {
    const res: CauseResult = {
      causeClass: 'nach-ablehnen',
      detail: 'Die Verbindung entstand erst nach dem Klick auf „Ablehnen“.',
    };
    const s = script ? scriptOf(script) : undefined;
    return s ? { ...res, scriptUrl: s, detail: `${res.detail} Auslöser: ${s}` } : res;
  }

  // 2. Lazy loading during the scroll phase.
  const start = timing.scrollPhaseStartAt;
  const end = timing.scrollPhaseEndAt;
  const inScroll =
    start !== undefined &&
    time !== undefined &&
    time >= start &&
    (end === undefined || time <= end + SCROLL_GRACE_MS);
  if (inScroll && (parser || srcRef || !script)) {
    return withSnippet(
      {
        causeClass: 'lazy-load-scroll',
        detail: 'Die Verbindung entstand erst während des Scrollens (Lazy-Load).',
      },
      srcRef,
    );
  }

  // 3. Element in the raw HTML (preload scanner / parser).
  if (parser || (causes.length === 0 && srcRef && !input.wasPreconnectOnly)) {
    const beforeCmp =
      timing.cmpLoadedAt === undefined || time === undefined || time < timing.cmpLoadedAt;
    if (srcRef?.kind === 'script-src' && beforeCmp) {
      return withSnippet(
        {
          causeClass: 'script-vor-cmp',
          detail: `Das Script steht mit \`src\` im HTML-Quelltext${
            srcRef.line ? ` (Zeile ${srcRef.line})` : ''
          } und wird vor dem CMP geladen.`,
        },
        srcRef,
      );
    }
    const foreignDoc =
      parser?.initiator.url && pageUrls.size > 0 && !pageUrls.has(parser.initiator.url)
        ? parser.initiator.url
        : undefined;
    if (foreignDoc && !srcRef) {
      return {
        causeClass: 'html-quelltext',
        detail: `Geladen vom HTML des eingebetteten bzw. Folgedokuments ${foreignDoc} – Folge eines Elements, das selbst nicht blockiert wurde.`,
      };
    }
    return withSnippet(
      {
        causeClass: 'html-quelltext',
        detail: srcRef
          ? `Das Element steht im HTML-Quelltext (Zeile ${srcRef.line}); der Preload-Scanner des Browsers baut die Verbindung auf, bevor ein Autoblocker eingreifen kann.`
          : 'Die Anfrage wurde vom HTML-Parser ausgelöst (Element im Quelltext).',
      },
      srcRef,
    );
  }

  // 4. Resource hint.
  if (input.wasPreconnectOnly || hintCause || (hintRef && !script)) {
    return withSnippet(
      {
        causeClass: 'resource-hint',
        detail: hintRef
          ? `Resource-Hint im HTML-Quelltext (Zeile ${hintRef.line}).`
          : 'Verbindung ohne Anfrage (Preconnect bzw. Resource-Hint).',
      },
      hintRef,
    );
  }

  // 5. Script initiator.
  if (script) {
    const s = scriptOf(script);
    const beforeCmp =
      timing.cmpLoadedAt === undefined || time === undefined || time < timing.cmpLoadedAt;
    const res: CauseResult = beforeCmp
      ? {
          causeClass: 'script-vor-cmp',
          detail: `Ausgelöst durch ein Script, das vor dem CMP lief${s ? `: ${s}` : ''}.`,
        }
      : {
          causeClass: 'nachgeladen-durch-script',
          detail: `Nachgeladen durch ein Script${s ? `: ${s}` : ''}${
            inScroll ? ' (während des Scrollens)' : ''
          }.`,
        };
    if (s) res.scriptUrl = s;
    const line = script.initiator.line;
    if (s && line !== undefined && pageUrls.has(s)) {
      const text = htmlLine(input.rawHtml, line);
      if (text) res.snippet = { text, line };
    }
    return res;
  }

  return withSnippet(
    {
      causeClass: 'unbekannt',
      detail: 'Für diese Verbindung wurde kein auslösender Request gefunden.',
    },
    srcRef ?? refs[0],
  );
}
