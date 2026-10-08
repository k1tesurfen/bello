import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { isEuEeaCountry } from './countries.js';

const hostPattern = z
  .string()
  .min(1)
  .regex(/^[a-z0-9*.-]+$/, 'Host-Muster darf nur a-z, 0-9, *, . und - enthalten');

export const vendorSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  name: z.string().min(1),
  country: z
    .string()
    .regex(/^[A-Z]{2}$/)
    .optional(),
  /** Explicit override; derived from `country` (outside EU/EEA) if absent. */
  thirdCountry: z.boolean().optional(),
  category: z.string().min(1),
  /** May be empty for self-hosted vendors (e.g. Borlabs Cookie). */
  hosts: z.array(hostPattern).default([]),
  cookies: z.array(z.string().min(1)).default([]),
  storageKeys: z.array(z.string().min(1)).default([]),
  /**
   * Cookie / storage-key globs (same syntax as `cookies`) that are technically necessary (bot
   * protection, load balancing, CSRF, payment fraud prevention). Matches are documented as INFO
   * instead of being treated as tracking. Every other match of a non-CMP vendor is tracking.
   */
  necessaryCookies: z.array(z.string().min(1)).default([]),
  necessaryStorageKeys: z.array(z.string().min(1)).default([]),
  privacyPolicyAliases: z.array(z.string().min(1)).default([]),
  fix: z.string().optional(),
  isCmp: z.boolean().default(false),
});

export type Vendor = z.infer<typeof vendorSchema> & { thirdCountry: boolean };

const fileSchema = z.object({ vendors: z.array(vendorSchema) });

/** Default German recommendation per category, used if a vendor has no own `fix`. */
export const CATEGORY_FIX: Readonly<Record<string, string>> = {
  werbung:
    'Dienst erst nach aktiver Einwilligung (Opt-in) laden, z. B. über den Tag-Manager mit Consent-Trigger oder per CMP-Blockierung (data-src statt src).',
  analyse:
    'Analyse-Skript erst nach Einwilligung laden oder auf eine einwilligungsfreie, selbst gehostete Lösung (z. B. Matomo ohne Cookies) umstellen.',
  video:
    'Video erst nach Klick einbetten (Zwei-Klick-Lösung) oder datenschutzfreundliche Einbettung nutzen (z. B. youtube-nocookie.com bzw. Vorschaubild lokal hosten).',
  karten:
    'Karte erst nach Einwilligung laden (Zwei-Klick-Lösung) oder eine selbst gehostete Karte (z. B. OpenStreetMap-Tiles lokal) einsetzen.',
  fonts: 'Schriftarten lokal vom eigenen Server ausliefern statt von einem Drittanbieter zu laden.',
  cdn: 'Bibliotheken selbst hosten (Dateien ins eigene Projekt übernehmen) statt über ein Drittanbieter-CDN zu laden.',
  zahlung:
    'Zahlungsdienst nur auf den Seiten einbinden, auf denen er tatsächlich benötigt wird (Checkout), und in der Datenschutzerklärung nennen.',
  'bot-schutz':
    'Bot-Schutz erst beim Absenden des Formulars laden oder eine datensparsame Alternative (z. B. Altcha, Friendly Captcha) verwenden.',
  social:
    'Social-Plugins erst nach Einwilligung bzw. über eine Zwei-Klick-Lösung (Shariff) einbinden.',
  'tag-manager':
    'Tag-Manager erst nach Einwilligung laden oder alle enthaltenen Tags per Consent-Trigger absichern.',
  chat: 'Chat-Widget erst nach Einwilligung laden oder per Klick auf einen Platzhalter nachladen.',
  sonstiges:
    'Dienst prüfen: Wenn nicht zwingend erforderlich, erst nach Einwilligung laden und in der Datenschutzerklärung aufführen.',
};

export function defaultFix(category: string): string {
  return CATEGORY_FIX[category] ?? (CATEGORY_FIX['sonstiges'] as string);
}

export function defaultVendorsPath(): string {
  return fileURLToPath(new URL('../../data/vendors.yaml', import.meta.url));
}

export function parseVendors(text: string, source = 'vendors.yaml'): Vendor[] {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (err) {
    throw new Error(`${source}: ungültiges YAML (${(err as Error).message})`, { cause: err });
  }
  const res = fileSchema.safeParse(raw);
  if (!res.success) {
    const issues = res.error.issues
      .slice(0, 5)
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    throw new Error(`${source}: Vendor-Datei ungültig (${issues})`);
  }
  const seen = new Set<string>();
  return res.data.vendors.map((v) => {
    if (seen.has(v.id)) throw new Error(`${source}: doppelte Vendor-ID „${v.id}“`);
    seen.add(v.id);
    return {
      ...v,
      thirdCountry: v.thirdCountry ?? (v.country ? !isEuEeaCountry(v.country) : false),
    };
  });
}

/** Load the built-in vendors.yaml, optionally merged with a customer file (same id overrides). */
export async function loadVendors(
  opts: { vendorsFile?: string; extraVendorsFile?: string } = {},
): Promise<Vendor[]> {
  const path = opts.vendorsFile ?? defaultVendorsPath();
  const base = parseVendors(await readFile(path, 'utf8'), path);
  if (!opts.extraVendorsFile) return base;
  const extra = parseVendors(await readFile(opts.extraVendorsFile, 'utf8'), opts.extraVendorsFile);
  const byId = new Map(base.map((v) => [v.id, v]));
  for (const v of extra) byId.set(v.id, v);
  return [...byId.values()];
}
