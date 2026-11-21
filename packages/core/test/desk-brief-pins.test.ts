import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BriefUnitPinSchema, MAX_UNIT_VERSION, SceneBriefSchema } from '../src/desk/brief';
import { briefHash } from '../src/desk/brief/record';

/*
 * The library pins of a brief (docs/embedding.md "Library units"): `unit` {ref, version, sha256} on the
 * set, a cast member and an element, kept as given, checked as the contract types them, and part of the
 * brief (its hash). That a brief without pins parses and hashes as before is desk-brief-golden.test.ts's.
 */

const FIXTURES = new URL('./fixtures/desk-embed/', import.meta.url);
const fixture = (name: string): any => JSON.parse(readFileSync(new URL(name, FIXTURES), 'utf8'));

const MIRA = 'chr_0123456789mira';
const KITE = 'ele_0123456789kite';
const PIN = { ref: 'lib_0123456789mead', version: 3, sha256: '0123456789abcdef'.repeat(4) };

describe('the library pins of a brief', () => {
  it('keeps the pins of the set, a cast member and an element as the host gave them', () => {
    for (const name of ['open-units.json', 'open-units-figure-hints.json']) {
      const scene = fixture(name).scene;
      const brief = SceneBriefSchema.parse(scene);
      expect(brief.set.unit, name).toEqual(scene.set.unit);
      for (const c of brief.cast)
        if (c.id === MIRA)
          expect(c.unit, name).toEqual(scene.cast.find((s: { id: string }) => s.id === MIRA).unit);
        else expect('unit' in c, `${name} ${c.id}`).toBe(false);
      for (const e of brief.elements)
        if (e.id === KITE)
          expect(e.unit, name).toEqual(scene.elements.find((s: { id: string }) => s.id === KITE).unit);
        else expect('unit' in e, `${name} ${e.id}`).toBe(false);
    }
    // the figure's kind and height ride on the cast member, as any hint does
    const hinted = SceneBriefSchema.parse(fixture('open-units-figure-hints.json').scene);
    const mira = hinted.cast.find((c) => c.id === MIRA)!;
    expect([mira.kind, mira.heightM]).toEqual(['child', 1.24]);
  });

  it('takes a pin on a location element (staging ignores it with a warning)', () => {
    const scene = fixture('open.json').scene;
    const location = scene.elements.find((e: { kind: string }) => e.kind === 'location');
    expect(location).toBeDefined();
    location.unit = PIN;
    const brief = SceneBriefSchema.parse(scene);
    expect(brief.elements.find((e) => e.id === location.id)!.unit).toEqual(PIN);
  });

  it('makes a pin part of the brief: a pin, a version or a hash of its own changes the brief hash', () => {
    const scene = fixture('open.json').scene;
    const hash = (set: object) =>
      briefHash(SceneBriefSchema.parse({ ...scene, set: { ...scene.set, ...set } }));
    const hashes = [
      hash({}),
      hash({ unit: PIN }),
      hash({ unit: { ...PIN, version: 4 } }),
      hash({ unit: { ...PIN, sha256: 'f'.repeat(64) } }),
      hash({ unit: { ...PIN, ref: 'lib_other' } }),
    ];
    expect(new Set(hashes).size).toBe(hashes.length);
    expect(hash({ unit: { ...PIN } })).toBe(hashes[1]);
  });

  it('checks a pin as the contract types it', () => {
    const ok = (pin: unknown) => BriefUnitPinSchema.safeParse(pin).success;
    expect(ok(PIN)).toBe(true);
    expect(ok({ ...PIN, version: 1 })).toBe(true);
    expect(ok({ ...PIN, version: MAX_UNIT_VERSION })).toBe(true);
    expect(MAX_UNIT_VERSION).toBe(1_000_000_000);
    for (const version of [0, -1, MAX_UNIT_VERSION + 1, 1.5, '3', null])
      expect(ok({ ...PIN, version }), `version ${String(version)}`).toBe(false);
    for (const sha256 of ['F'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), 'g'.repeat(64), ''])
      expect(ok({ ...PIN, sha256 }), `sha256 ${sha256}`).toBe(false);
    for (const ref of ['', '_lib', 'lib one', 'l'.repeat(101), 7])
      expect(ok({ ...PIN, ref }), `ref ${String(ref)}`).toBe(false);
    for (const key of ['ref', 'version', 'sha256'] as const) {
      const { [key]: _, ...rest } = PIN;
      expect(ok(rest), `without ${key}`).toBe(false);
    }
  });

  it('refuses a brief with a bad pin on the set, a cast member or an element', () => {
    expect(SceneBriefSchema.safeParse(fixture('invalid/open-units-bad-pin.json').scene).success).toBe(false);
    const scene = fixture('open-units.json').scene;
    const bad = { ...PIN, sha256: PIN.sha256.toUpperCase() };
    expect(SceneBriefSchema.safeParse(scene).success).toBe(true);
    const variants = [
      { ...scene, set: { ...scene.set, unit: bad } },
      { ...scene, cast: scene.cast.map((c: object, i: number) => (i === 0 ? { ...c, unit: bad } : c)) },
      {
        ...scene,
        elements: scene.elements.map((e: object, i: number) => (i === 0 ? { ...e, unit: bad } : e)),
      },
    ];
    for (const v of variants) expect(SceneBriefSchema.safeParse(v).success).toBe(false);
  });
});
