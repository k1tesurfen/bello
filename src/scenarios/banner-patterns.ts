/**
 * Text patterns for the heuristic banner fallback (PLAN §5.6).
 *
 * The same regex sources are used in Node (unit tests, classification) and inside the page
 * (see `banner-dom.ts`), so they are kept as plain strings. Every pattern is matched against the
 * *whole* normalized button text (lower case, collapsed whitespace, leading/trailing punctuation
 * removed), never as a substring – "Nur notwendige Cookies akzeptieren" must not count as
 * "accept".
 */

/**
 * Kind of a consent-banner control. `pay` is the paid alternative of a "consent or pay" banner
 * (Pur-Abo, contentpass, "werbefrei lesen" …) – never clicked, only used to explain why a
 * rejection is impossible without paying.
 */
export type ButtonKind = 'reject' | 'save' | 'accept' | 'pay' | 'settings';

/** Classification order: earlier kinds win (reject before accept, save before accept). */
export const BUTTON_KIND_ORDER: readonly ButtonKind[] = [
  'reject',
  'save',
  'accept',
  'pay',
  'settings',
];

const NECESSARY =
  '(?:technisch )?(?:notwendige|erforderliche|essenzielle|essentielle|funktionale|nötige)';

export const BUTTON_PATTERNS: Readonly<Record<ButtonKind, readonly string[]>> = {
  reject: [
    // German
    '^(?:alle )?(?:optionalen |nicht notwendigen |zusätzlichen )?(?:cookies |dienste )?ablehnen(?: und schließen| & schließen| und weiter)?$',
    '^alles ablehnen$',
    `^nur ${NECESSARY}(?: cookies| dienste| technologien)?(?: (?:akzeptieren|zulassen|erlauben|verwenden|nutzen|speichern|annehmen))?$`,
    `^${NECESSARY} cookies (?:akzeptieren|zulassen|erlauben|verwenden)$`,
    `^(?:mit|weiter mit) ${NECESSARY}n? cookies(?: fortfahren)?$`,
    '^(?:ich )?(?:willige )?nicht ein$',
    '^nicht (?:einwilligen|zustimmen|akzeptieren)$',
    '^(?:alle )?verweigern$',
    '^einwilligung verweigern$',
    '^(?:ohne (?:einwilligung|zustimmung|cookies) (?:fortfahren|weiter)|weiter ohne (?:einwilligung|zustimmung|cookies|akzeptieren))$',
    '^(?:ich )?lehne ab$',
    // English
    '^(?:reject|decline|deny|refuse)(?: all)?(?: (?:optional |non-essential )?cookies)?(?: and close)?$',
    '^(?:use |allow |accept )?(?:only )?(?:strictly )?(?:necessary|essential|required)(?: cookies)?(?: only)?$',
    '^only (?:strictly )?(?:necessary|essential|required)(?: cookies)?$',
    '^continue without (?:accepting|consent|agreeing|cookies)$',
    '^(?:i )?do not (?:accept|agree|consent)$',
    '^(?:i )?disagree$',
  ],
  save: [
    '^(?:auswahl|einstellungen|präferenzen|meine auswahl|ausgewählte) (?:speichern|bestätigen|übernehmen|erlauben|zulassen|akzeptieren)(?: und (?:schließen|beenden|fortfahren))?$',
    '^speichern(?: und (?:schließen|beenden)| & schließen| & beenden)?$',
    '^(?:save|confirm)(?: my)?(?: (?:choices|choice|selection|settings|preferences))?(?: (?:and|&) (?:close|exit))?$',
    '^allow selection$',
  ],
  accept: [
    '^(?:alle |allen )?(?:cookies )?(?:akzeptieren|zustimmen|annehmen|zulassen|erlauben|aktivieren)(?: und (?:schließen|fortfahren|weiter))?$',
    '^alle (?:cookies|dienste) (?:akzeptieren|zulassen|annehmen|erlauben|aktivieren)$',
    '^alles (?:akzeptieren|zulassen|erlauben|annehmen)$',
    '^(?:ich )?(?:stimme zu|bin einverstanden|akzeptiere|willige ein)$',
    '^(?:einverstanden|verstanden|alles klar|zustimmen und weiter|akzeptieren und weiter|ok|okay)$',
    '^(?:accept|allow|agree|enable)(?: all)?(?: cookies)?(?: (?:and|&) (?:close|continue|proceed))?$',
    '^(?:yes,? )?i (?:agree|accept)$',
    '^(?:got it|ok|okay|i understand)$',
  ],
  pay: [
    '^(?:jetzt )?(?:pur-?abo|abo|abonnement|contentpass|werbefrei-?abo)(?: (?:jetzt )?(?:abschließen|buchen|bestellen|kaufen|abonnieren|anmelden|testen|nutzen|starten))?$',
    '^(?:mit|weiter mit|jetzt mit|login mit|anmelden mit) (?:pur-?abo|contentpass|abo|abonnement)(?: (?:anmelden|lesen|weiter|fortfahren|abschließen|nutzen))?$',
    '^(?:jetzt )?(?:abonnieren|abo abschließen|werbefrei (?:lesen|nutzen|surfen)|ohne werbung (?:lesen|nutzen)|ohne tracking (?:lesen|nutzen))$',
    '^(?:ablehnen|nicht zustimmen|ablehnen und weiter) (?:und|&|mit) (?:pur-?abo|abo|contentpass)(?: (?:abschließen|lesen|weiter))?$',
    '^(?:ablehnen|nicht zustimmen) (?:und|&) abonnieren$',
    '^(?:subscribe|subscribe now|go ad-?free|ad-?free subscription|reject and subscribe|reject & subscribe)$',
  ],
  settings: [
    '^(?:cookie-?|privatsphäre-?|datenschutz-?)?einstellungen(?: (?:anpassen|verwalten|öffnen|ändern|bearbeiten|anzeigen))?$',
    '^(?:mehr |weitere )?optionen(?: anzeigen)?$',
    '^(?:individuelle |eigene )?(?:einstellungen|auswahl)(?: (?:anpassen|treffen|vornehmen))?$',
    '^(?:cookies |präferenzen |auswahl |zwecke )?(?:anpassen|verwalten|konfigurieren|anzeigen)$',
    '^präferenzen$',
    '^details(?: (?:anzeigen|einblenden))?$',
    '^ablehnen oder anpassen$',
    '^(?:cookie )?(?:settings|preferences|options)$',
    '^(?:manage|customi[sz]e|configure)(?: (?:cookies|preferences|options|settings|choices))?$',
    '^(?:more options|show purposes|show details|let me choose|cookie settings)$',
  ],
};

/** Text of the banner container must contain one of these (consent context). */
export const CONSENT_KEYWORDS =
  'cookie|einwillig|zustimm|datenschutz|consent|privacy|tracking|privatsphäre|dsgvo|gdpr|personalis|drittanbieter|endgerät|partner';

/** id/class/aria-label hints of a banner container. */
export const ROOT_HINTS =
  'cookie|consent|cmp|gdpr|dsgvo|privacy|datenschutz|banner|notice|onetrust|usercentrics|borlabs|didomi|klaro|cookiebot|cky|ccm|sp_message|message-container';

/**
 * CMP-specific controls whose meaning is known from their markup, independent of the
 * (customisable) label. They take precedence over the text classification. Matched with
 * `Element.matches`, so the same selectors work inside shadow roots and iframes.
 *
 *  - Sourcepoint (message and privacy-manager iframes): `sp_choice_type_<n>` –
 *    11 accept all, 13 reject all, 12 show options, 9 "pay"/subscription redirect.
 *  - Usercentrics v2 (`#usercentrics-root`, shadow DOM): `data-testid=uc-*-button`.
 *  - Usercentrics v3 (`#usercentrics-cmp-ui`, shadow DOM): `data-action-type`.
 *  - CCM19 (`#ccm-widget`): `ccm--decline-cookies`, `ccm--save-settings[data-full-consent]`.
 */
export const CMP_BUTTON_SELECTORS: Readonly<Record<ButtonKind, readonly string[]>> = {
  reject: [
    '.sp_choice_type_13',
    '.sp_choice_type_REJECT_ALL',
    '[data-testid="uc-deny-all-button"]',
    '[data-action-type="deny"]',
    '.ccm--decline-cookies',
  ],
  save: [
    '.sp_choice_type_SAVE_AND_EXIT',
    '[data-testid="uc-save-button"]',
    '[data-action-type="save"]',
    '.ccm--save-settings:not([data-full-consent="true"])',
  ],
  accept: [
    '.sp_choice_type_11',
    '.sp_choice_type_ACCEPT_ALL',
    '[data-testid="uc-accept-all-button"]',
    '[data-action-type="accept"]',
    '.ccm--save-settings[data-full-consent="true"]',
  ],
  pay: ['.sp_choice_type_9'],
  settings: [
    '.sp_choice_type_12',
    '[data-testid="uc-more-button"]',
    '[data-action-type="more"]',
    '#ccm-widget [data-ccm-modal="ccm-details"]:not(.ccm-info-button)',
  ],
};

/** Normalizes a button label as done in the page (lower case, whitespace, punctuation). */
export function normalizeButtonText(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
}

const compiled = Object.fromEntries(
  BUTTON_KIND_ORDER.map((k) => [k, BUTTON_PATTERNS[k].map((s) => new RegExp(s, 'iu'))]),
) as Record<ButtonKind, RegExp[]>;

/** Classifies a (raw) button label; `undefined` if it is not a consent control. */
export function classifyButtonText(text: string): ButtonKind | undefined {
  const t = normalizeButtonText(text);
  if (!t || t.length > 80) return undefined;
  for (const kind of BUTTON_KIND_ORDER) {
    if (compiled[kind].some((r) => r.test(t))) return kind;
  }
  return undefined;
}
