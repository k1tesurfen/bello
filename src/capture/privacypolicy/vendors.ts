/** Matching of contacted vendors against a privacy policy text (PLAN §5.7). */

export interface PolicyVendor {
  id: string;
  name: string;
  aliases: string[];
}

const LEGAL_FORMS = new Set([
  'gmbh',
  'ag',
  'inc',
  'llc',
  'ltd',
  'limited',
  'corp',
  'corporation',
  'co',
  'kg',
  'ug',
  'se',
  'bv',
  'sa',
  'sarl',
  'plc',
  'ohg',
  'gbr',
  'ev',
  'llp',
  'lp',
  'oy',
  'ab',
  'as',
  'srl',
  'spa',
  'mbh',
  'company',
  'holding',
  'holdings',
]);
const COUNTRY_TOKENS = new Set([
  'ireland',
  'germany',
  'deutschland',
  'europe',
  'emea',
  'uk',
  'usa',
  'us',
  'international',
  'netherlands',
  'france',
  'sweden',
  'finland',
  'limited',
]);

/** Lower-cases, folds umlauts/diacritics and unifies separators. */
export function normalizeForMatch(s: string): string {
  return s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .replace(/[‐-―_/\\|]/gu, ' ')
    .replace(/-/g, ' ')
    .replace(/[“”„"'’‘`´]/g, '')
    .replace(/[,;:()[\]{}!?]/g, ' ')
    .replace(/&/g, ' and ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokens(term: string): string[] {
  return normalizeForMatch(term)
    .split(' ')
    .map((t) => t.replace(/^\.+|\.+$/g, ''))
    .filter(Boolean);
}

/** Search variants of a company name / alias: full and without legal-form suffixes. */
export function termVariants(term: string): string[] {
  const full = tokens(term);
  if (full.length === 0) return [];
  const variants = new Set<string>([full.join(' ')]);
  const t = [...full];
  let stripped = false;
  for (;;) {
    const last = t[t.length - 1];
    if (
      t.length > 1 &&
      last &&
      (LEGAL_FORMS.has(last) || LEGAL_FORMS.has(last.replace(/\./g, '')))
    ) {
      t.pop();
      stripped = true;
      variants.add(t.join(' '));
    } else break;
  }
  if (stripped) {
    // "Google Ireland Limited" -> "Google Ireland" -> "Google"
    while (t.length > 1 && COUNTRY_TOKENS.has(t[t.length - 1]!)) {
      t.pop();
      variants.add(t.join(' '));
    }
  }
  return [...variants].filter((v) => v.length >= 3);
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function matchVendorsInPolicy(
  text: string,
  vendors: PolicyVendor[],
): { mentioned: string[]; missing: string[] } {
  const hay = normalizeForMatch(text);
  const mentioned: string[] = [];
  const missing: string[] = [];
  for (const v of vendors) {
    const found = [v.name, ...v.aliases].some((term) =>
      termVariants(term).some((variant) => {
        const re = new RegExp(
          `(?<![\\p{L}\\p{N}])${escapeRe(variant).replace(/ /g, '\\s+')}(?![\\p{L}\\p{N}])`,
          'u',
        );
        return re.test(hay);
      }),
    );
    (found ? mentioned : missing).push(v.id);
  }
  return { mentioned, missing };
}
