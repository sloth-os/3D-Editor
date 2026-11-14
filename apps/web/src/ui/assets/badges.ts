import type { StoreResult } from '@3d-editor/core';
import type { StoreProviderStatus } from '../../io/store-client';

/*
 * What the Asset Browser's badges say: a model's licence (short name, how free it is, the credit
 * it asks for) and how each store provider answered (ok / needs key / offline).
 */

/** How much a licence asks: none (public domain), a credit, a share-alike/no-derivatives term, or unknown. */
export type LicenceTone = 'free' | 'credit' | 'restricted' | 'unknown';

/** A short name of an SPDX licence id: 'CC0', 'CC BY 4.0', 'CC BY-NC 4.0', 'MIT'… */
export function licenceLabel(spdx: string | null | undefined): string {
  const id = (spdx ?? '').trim();
  if (!id || /^(NOASSERTION|NONE|UNKNOWN)$/i.test(id)) return 'Licence?';
  if (/^CC0/i.test(id)) return 'CC0';
  if (/^(PDDL|Unlicense)/i.test(id) || /public.?domain/i.test(id)) return 'Public domain';
  const cc = /^CC-(BY(?:-(?:NC|ND|SA))*)-(\d(?:\.\d)?)/i.exec(id);
  if (cc) return `CC ${cc[1].toUpperCase()} ${cc[2]}`;
  return id.length > 18 ? `${id.slice(0, 17)}…` : id;
}

/** How free a licence is (for the badge colour). */
export function licenceTone(spdx: string | null | undefined): LicenceTone {
  const id = (spdx ?? '').trim();
  if (!id || /^(NOASSERTION|NONE|UNKNOWN)$/i.test(id)) return 'unknown';
  if (/^(CC0|PDDL|Unlicense)/i.test(id) || /public.?domain/i.test(id)) return 'free';
  if (/^CC-BY(-SA)?-\d/i.test(id) && !/-(NC|ND)\b/i.test(id))
    return /-SA\b/i.test(id) ? 'restricted' : 'credit';
  if (/-(NC|ND)\b/i.test(id) || /^LicenseRef/i.test(id)) return 'restricted';
  // MIT, Apache, BSD and the like: a notice to keep
  return 'credit';
}

/** The badge's tooltip: the licence, the credit it asks for, the author and the source. */
export function licenceTooltip(r: Pick<StoreResult, 'license' | 'author' | 'source_url'>): string {
  const lines = [`Licence: ${r.license.spdx || 'unknown'}`];
  if (r.license.attribution) lines.push(`Credit: ${r.license.attribution}`);
  if (r.author) lines.push(`Author: ${r.author}`);
  if (r.source_url) lines.push(`Source: ${r.source_url}`);
  if (r.license.url) lines.push(`Licence text: ${r.license.url}`);
  return lines.join('\n');
}

/** What a provider's badge says. */
export interface ProviderBadge {
  label: 'ok' | 'needs key' | 'offline' | 'disabled';
  tone: 'ok' | 'warn' | 'error' | 'muted';
  /** Why (the server's message), for the tooltip. */
  title: string;
}

/** The badge of a provider's status: ok, needs key (a setting is missing), offline (error/timeout), disabled. */
export function providerBadge(p: StoreProviderStatus): ProviderBadge {
  switch (p.status) {
    case 'needs_key':
      return {
        label: 'needs key',
        tone: 'warn',
        title: p.message ?? `Set ${p.needs_key ?? 'its key'} on the editor server to use ${p.name}`,
      };
    case 'error':
    case 'timeout':
      return { label: 'offline', tone: 'error', title: p.message ?? `${p.name} did not answer` };
    case 'disabled':
      return {
        label: 'disabled',
        tone: 'muted',
        title: p.message ?? `${p.name} is not enabled on the server`,
      };
    default:
      return {
        label: 'ok',
        tone: 'ok',
        // e.g. Sketchfab: searching works without its token, downloads need it
        title: p.message ?? (p.needs_key ? `Downloads need ${p.needs_key}` : `${p.name} answers`),
      };
  }
}
