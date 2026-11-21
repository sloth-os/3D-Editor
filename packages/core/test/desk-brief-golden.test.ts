import { describe, expect, it } from 'vitest';
import { SceneBriefSchema } from '../src/desk/brief';
import { briefHash } from '../src/desk/brief/record';
import {
  GOLDEN_FILE,
  goldenBriefs,
  goldenDigest,
  hasUnitKey,
  readGolden,
  stageGolden,
  type GoldenEntry,
} from './desk-brief-golden-helpers';

/*
 * Briefs without library pins stage exactly as they did before library units: every fixture brief
 * without pins and the five synthetic briefs of desk-brief-golden-helpers.ts (an interior, water,
 * animal stand-ins, a rider on a mount, a kite and a balloon in flight), staged again, give the hash,
 * the record, the report and the fingerprint of the staged document that
 * fixtures/desk-embed/staged-golden.json holds (written at 42d5331 by desk-brief-golden-write.ts,
 * before staging knew of pins; names stand for the random ids, the motion digests are neutralised and
 * numbers rounded to 1e-6). The brief schema's pins are optional with no default: a brief without
 * pins parses with no `unit` key anywhere, to the hash and the record frozen below. Each brief is
 * staged once (about 0.1–0.4 s each).
 */

/** Frozen at 42d5331, before the brief schema had pins: each brief's hash and its record's digest. */
const FROZEN: Record<string, { hash: string; record: string }> = {
  'open-with-state.json': { hash: '5ab93270d1b3682d', record: '0e3a2e6446393ffc' },
  'open.json': { hash: '5ab93270d1b3682d', record: '0e3a2e6446393ffc' },
  'synthetic:interior': { hash: 'a74bb7bdbab5a406', record: '5cbdca7d4c912b04' },
  'synthetic:water': { hash: 'dc63e3decdaa9e6d', record: 'd64b839d4f010008' },
  'synthetic:animals': { hash: 'c0c185b093150a53', record: 'dd9ba31e1a0177c0' },
  'synthetic:rider': { hash: '2d7312bcf6754362', record: 'e4f621ce44422daf' },
  'synthetic:kite': { hash: 'd48202c185c3a2fa', record: '61832c78caaf191c' },
};

const golden = readGolden();
const briefs = goldenBriefs();

const staged = new Map<string, GoldenEntry>();
/** Brief `name` staged and fingerprinted (once per run). */
function stagedOf(name: string): GoldenEntry {
  let entry = staged.get(name);
  if (!entry) staged.set(name, (entry = stageGolden(briefs[name])));
  return entry;
}

describe('briefs without pins stage exactly as before library units', () => {
  it(`${GOLDEN_FILE} covers every fixture brief without pins and the synthetic briefs`, () => {
    expect(Object.keys(golden.briefs).sort()).toEqual(Object.keys(briefs).sort());
    expect(Object.keys(FROZEN).sort()).toEqual(Object.keys(briefs).sort());
  });

  it.each(Object.keys(golden.briefs))('%s stages as before', (name) => {
    const now = stagedOf(name);
    const was = golden.briefs[name];
    expect(now.hash).toBe(was.hash);
    expect(now.record).toEqual(was.record);
    expect(now.report).toEqual(was.report);
    expect(Object.keys(now.fingerprint).sort()).toEqual(Object.keys(was.fingerprint).sort());
    for (const section of Object.keys(was.fingerprint))
      expect(now.fingerprint[section], section).toEqual(was.fingerprint[section]);
  });
});

describe('the brief pins leave a brief without pins as it was', () => {
  it.each(Object.keys(FROZEN))('%s parses with no unit key, to the same hash and record', (name) => {
    const parsed = SceneBriefSchema.parse(briefs[name]);
    expect(hasUnitKey(parsed)).toBe(false);
    expect(briefHash(parsed)).toBe(FROZEN[name].hash);
    expect(goldenDigest(stagedOf(name).record)).toBe(FROZEN[name].record);
  });
});
