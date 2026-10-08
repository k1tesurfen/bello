import { z } from 'zod';
import { tryNormalizeUrl } from './url.js';

const nonEmpty = z.string().trim().min(1, 'Darf nicht leer sein');
const posInt = z.number().int('Muss eine ganze Zahl sein').positive('Muss größer als 0 sein');

const urlField = z
  .string()
  .refine((v) => tryNormalizeUrl(v) !== null, { message: 'Ungültige URL' })
  .transform((v) => tryNormalizeUrl(v) as string);

const crawlDefaults = z.strictObject({
  maxPages: posInt.optional(),
  delayMs: z
    .number()
    .int('Muss eine ganze Zahl sein')
    .nonnegative('Darf nicht negativ sein')
    .optional(),
  sitesInParallel: posInt.optional(),
});

const company = z.strictObject({
  name: nonEmpty.optional(),
  logo: nonEmpty.optional(),
  colors: z
    .strictObject({
      primary: nonEmpty.optional(),
      secondary: nonEmpty.optional(),
      accent: nonEmpty.optional(),
      text: nonEmpty.optional(),
      background: nonEmpty.optional(),
    })
    .optional(),
  contact: nonEmpty.optional(),
});

const defaults = z.strictObject({
  outDir: nonEmpty.optional(),
  waitSeconds: z.number().nonnegative('Darf nicht negativ sein').optional(),
  crawl: crawlDefaults.optional(),
  /** Default page count (same meaning as --pages). */
  pages: posInt.optional(),
});

const processor = z.strictObject({
  host: nonEmpty,
  reason: nonEmpty,
  avv: nonEmpty.optional(),
});

const customer = z.strictObject({
  name: nonEmpty,
  url: urlField,
  crawl: z.boolean().optional(),
  maxPages: posInt.optional(),
  delayMs: z
    .number()
    .int('Muss eine ganze Zahl sein')
    .nonnegative('Darf nicht negativ sein')
    .optional(),
  waitSeconds: z.number().nonnegative('Darf nicht negativ sein').optional(),
  firstPartyAliases: z.array(nonEmpty).optional(),
  allowedProcessors: z.array(processor).optional(),
  banner: z
    .strictObject({
      rejectSelector: nonEmpty.optional(),
      acceptSelector: nonEmpty.optional(),
    })
    .optional(),
  vendorsFile: nonEmpty.optional(),
});

export const customerIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._-]*$/i, 'Ungültige Kunden-ID (erlaubt: Buchstaben, Ziffern, . _ -)');

export const configSchema = z.strictObject({
  company: company.optional(),
  defaults: defaults.optional(),
  customers: z.record(customerIdSchema, customer).optional(),
});

export type RawConfig = z.output<typeof configSchema>;

const TYPE_DE: Record<string, string> = {
  string: 'Text',
  number: 'Zahl',
  boolean: 'Ja/Nein (true/false)',
  array: 'Liste',
  object: 'Objekt',
  record: 'Objekt',
};

function describe(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'Liste';
  return TYPE_DE[typeof v] ?? typeof v;
}

/** Per-parse error map producing German messages. */
export function germanError(iss: z.core.$ZodRawIssue): string | undefined {
  switch (iss.code) {
    case 'invalid_type':
      if (iss.input === undefined) return 'Pflichtfeld fehlt';
      return `Erwartet ${TYPE_DE[iss.expected] ?? iss.expected}, gefunden: ${describe(iss.input)}`;
    case 'unrecognized_keys':
      return `Unbekannte${iss.keys.length > 1 ? ' Schlüssel' : 'r Schlüssel'}: ${iss.keys.map((k) => `„${k}“`).join(', ')}`;
    case 'too_small':
      return iss.origin === 'string' ? 'Darf nicht leer sein' : 'Wert zu klein';
    case 'too_big':
      return 'Wert zu groß';
    case 'invalid_format':
      return 'Ungültiges Format';
    case 'invalid_value':
      return 'Ungültiger Wert';
    default:
      return undefined;
  }
}

export function formatPath(path: ReadonlyArray<PropertyKey>): string {
  return path.map(String).join('.') || '(Wurzel)';
}
