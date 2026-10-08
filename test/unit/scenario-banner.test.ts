import { describe, expect, it } from 'vitest';
import { isHideOnlyRule, rulesForFrame } from '../../src/scenarios/autoconsent.js';
import { classifyButtonText, normalizeButtonText } from '../../src/scenarios/banner-patterns.js';
import { DEFAULT_SCENARIO_BUDGET_MS, slowSiteTuning } from '../../src/scenarios/run.js';

describe('classifyButtonText', () => {
  it.each([
    ['Alle ablehnen', 'reject'],
    ['Ablehnen', 'reject'],
    ['  Nur notwendige  ', 'reject'],
    ['Nur notwendige Cookies', 'reject'],
    ['Nur notwendige Cookies akzeptieren', 'reject'],
    ['Nur essenzielle Cookies akzeptieren', 'reject'],
    ['Weiter ohne Einwilligung', 'reject'],
    ['Reject all', 'reject'],
    ['Only necessary cookies', 'reject'],
    ['Accept necessary', 'reject'],
    ['Alle akzeptieren', 'accept'],
    ['Akzeptieren', 'accept'],
    ['Zustimmen', 'accept'],
    ['Alle Cookies akzeptieren', 'accept'],
    ['Ich stimme zu', 'accept'],
    ['Accept all', 'accept'],
    ['OK', 'accept'],
    ['Einstellungen', 'settings'],
    ['Cookie-Einstellungen', 'settings'],
    ['Mehr Optionen', 'settings'],
    ['Manage preferences', 'settings'],
    ['Auswahl speichern', 'save'],
    ['Auswahl erlauben', 'save'],
    ['Einstellungen speichern', 'save'],
    ['Save & exit', 'save'],
    ['Pur-Abo abschließen', 'pay'],
    ['Mit Pur-Abo anmelden', 'pay'],
    ['Jetzt abonnieren', 'pay'],
    ['Mit contentpass weiter', 'pay'],
    ['Ablehnen und Abo abschließen', 'pay'],
    ['Werbefrei lesen', 'pay'],
  ])('%s → %s', (text, kind) => {
    expect(classifyButtonText(text)).toBe(kind);
  });

  it.each([
    'Datenschutzerklärung',
    'Impressum',
    'Mehr erfahren',
    'Jetzt kaufen',
    'YouTube-Video laden und Datenschutzerklärung von Google akzeptieren, damit es weitergeht',
    '',
  ])('%s → kein Banner-Button', (text) => {
    expect(classifyButtonText(text)).toBeUndefined();
  });

  it('normalisiert Leerraum, Groß/Klein und Satzzeichen am Rand', () => {
    expect(normalizeButtonText('\n  Alle Akzeptieren ›  ')).toBe('alle akzeptieren');
  });
});

describe('rulesForFrame', () => {
  const rules = [
    { name: 'main-default' },
    { name: 'frame-only', runContext: { main: false, frame: true } },
    { name: 'both', runContext: { main: true, frame: true } },
    { name: 'site', runContext: { urlPattern: '^https://www\\.example\\.de' } },
  ];
  it('wählt Regeln nach Frame-Kontext und URL-Muster', () => {
    expect(rulesForFrame(rules, 'https://www.example.de/', true).map((r) => r.name)).toEqual([
      'main-default',
      'both',
      'site',
    ]);
    expect(rulesForFrame(rules, 'https://cmp.example/frame', false).map((r) => r.name)).toEqual([
      'frame-only',
      'both',
    ]);
    expect(rulesForFrame(rules, 'https://andere.de/', true).map((r) => r.name)).toEqual([
      'main-default',
      'both',
    ]);
  });
});

describe('isHideOnlyRule', () => {
  it('Regeln, die den Banner nur ausblenden, gelten nicht als Entscheidung', () => {
    expect(
      isHideOnlyRule({
        name: 'sourcepoint-top',
        optOut: [
          { stylesheet: 'div { visibility: hidden }' },
          { removeClass: 'sp-message-open', selector: 'html', optional: true },
          { eval: 'EVAL_SOURCEPOINT_RESTORE_SCROLL', optional: true },
        ],
      }),
    ).toBe(true);
    expect(isHideOnlyRule({ name: 'klick', optOut: [{ waitForThenClick: '#reject' }] })).toBe(
      false,
    );
    expect(
      isHideOnlyRule({
        name: 'verschachtelt',
        optOut: [{ if: { exists: '#x' }, then: [{ click: '#x' }], else: [{ hide: '#y' }] }],
      }),
    ).toBe(false);
    expect(isHideOnlyRule({ name: 'api', optOut: [{ eval: 'EVAL_USERCENTRICS_API_2' }] })).toBe(
      false,
    );
  });
});

describe('slowSiteTuning', () => {
  const base = { detectTimeoutMs: 10_000, budgetMs: DEFAULT_SCENARIO_BUDGET_MS };
  it('schnelle Seite: keine Anpassung', () => {
    expect(slowSiteTuning(4_000, true, base)).toEqual({ slow: false, ...base });
  });
  it('langsame Seite: längere Banner-Wartezeit und größeres Zeitbudget (gedeckelt)', () => {
    const t = slowSiteTuning(30_000, true, base);
    expect(t.slow).toBe(true);
    expect(t.detectTimeoutMs).toBe(25_000);
    expect(t.budgetMs).toBe(base.budgetMs + 80_000);
    const sehrLangsam = slowSiteTuning(200_000, true, base);
    expect(sehrLangsam.detectTimeoutMs).toBe(30_000);
    expect(sehrLangsam.budgetMs).toBe(2 * base.budgetMs);
  });
  it('load-Ereignis kam nie: maximale Banner-Wartezeit', () => {
    const t = slowSiteTuning(25_000, false, base);
    expect(t.slow).toBe(true);
    expect(t.detectTimeoutMs).toBe(30_000);
    expect(t.budgetMs).toBe(base.budgetMs + 60_000);
  });
});
