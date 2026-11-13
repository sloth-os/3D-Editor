/*
 * Licences of store models: SPDX ids from the providers' many spellings, how restrictive each is
 * (a model made of parts under several licences carries the most restrictive one), their deed URLs
 * and what an inserted model's licence asks of a film (attribution, no commercial use …).
 */

/** SPDX id for "the licence is not known yet" (Khronos models before their metadata.json is read). */
export const UNKNOWN_LICENSE = 'NOASSERTION';

const CC_URL: Record<string, string> = {
  'CC0-1.0': 'https://creativecommons.org/publicdomain/zero/1.0/',
};
for (const v of ['2.0', '2.5', '3.0', '4.0'])
  for (const kind of ['BY', 'BY-SA', 'BY-ND', 'BY-NC', 'BY-NC-SA', 'BY-NC-ND'])
    CC_URL[`CC-${kind}-${v}`] = `https://creativecommons.org/licenses/${kind.toLowerCase()}/${v}/`;

/**
 * The SPDX id of a licence written as a provider writes it: 'CC0 1.0', 'CC-BY 3.0', 'CC BY-NC 4.0',
 * 'cc-by-sa', 'Creative Commons Attribution 4.0', 'Public Domain' … Unknown names are kept (trimmed,
 * at most 64 characters) so the user still sees what the provider said.
 */
export function normalizeLicense(raw: string | null | undefined): string {
  const text = (raw ?? '').trim();
  if (!text) return UNKNOWN_LICENSE;
  const spaced = text
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, ' ')
    .trim();
  const tokens = spaced.split(' ');
  const has = (...ws: string[]) => ws.some((w) => tokens.includes(w));
  if (has('cc0', 'unlicense') || /^cc ?zero|public ?domain/.test(spaced) || spaced === 'pd') return 'CC0-1.0';
  const cc = has('cc') || spaced.includes('creative commons');
  if (cc && has('by', 'attribution')) {
    let kind = 'BY';
    if (has('nc', 'noncommercial') || spaced.includes('non commercial')) kind += '-NC';
    if (has('sa', 'sharealike') || spaced.includes('share alike')) kind += '-SA';
    else if (has('nd', 'noderivs', 'noderivatives') || spaced.includes('no deriv')) kind += '-ND';
    const v = /\b(\d)(?:\.(\d))?\b/.exec(spaced);
    return `CC-${kind}-${v ? `${v[1]}.${v[2] ?? '0'}` : '4.0'}`;
  }
  return text.slice(0, 64);
}

/**
 * How restrictive a licence is (higher: more restrictive): public domain 0, permissive licences
 * that ask for a notice 5, CC BY 10 (+1 ShareAlike, +2 NoDerivatives, +4 NonCommercial), anything
 * unknown 100.
 */
export function licenseRank(spdx: string): number {
  const s = spdx.toUpperCase();
  if (s === 'CC0-1.0' || s === 'UNLICENSE' || s === 'PDDL-1.0') return 0;
  if (/^(MIT|APACHE-2\.0|BSD-[23]-CLAUSE|ISC|ZLIB)$/.test(s)) return 5;
  const m = /^CC-BY(-NC)?(-SA|-ND)?-\d\.\d$/.exec(s);
  if (m) return 10 + (m[1] ? 4 : 0) + (m[2] === '-SA' ? 1 : m[2] === '-ND' ? 2 : 0);
  return 100;
}

/** The most restrictive of `licenses` (the first of equals); null for an empty list. */
export function mostRestrictive<T extends { spdx: string }>(licenses: readonly T[]): T | null {
  let best: T | null = null;
  for (const l of licenses) if (!best || licenseRank(l.spdx) > licenseRank(best.spdx)) best = l;
  return best;
}

/** The deed URL of a Creative Commons licence, else null. */
export function licenseUrl(spdx: string): string | null {
  return CC_URL[spdx] ?? null;
}

/** What a licence asks of the film a model appears in (null: nothing beyond the credit). */
export function licenseNote(spdx: string): string | null {
  const s = spdx.toUpperCase();
  if (s === UNKNOWN_LICENSE) return 'its licence is not known: check the source before publishing';
  if (licenseRank(s) >= 100) return `licence ${spdx}: check its terms before publishing`;
  const notes: string[] = [];
  if (s.includes('-NC')) notes.push('non-commercial use only');
  if (s.includes('-ND')) notes.push('no modified versions may be shared');
  if (s.includes('-SA')) notes.push('modified versions must use the same licence');
  if (s.startsWith('CC-BY')) notes.push('credit the author');
  return notes.length ? `licence ${spdx}: ${notes.join(', ')}` : null;
}

/** `text` cut to `max` characters (with an ellipsis when cut). */
export function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
