import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { SceneDoc } from '../src/doc/scene-doc';
import { getShots } from '../src/desk/shots';
import { readBriefRecord } from '../src/desk/brief/record';
import { SceneBriefSchema, stageBrief, type SceneBrief, type StageBriefReport } from '../src/desk/brief';

/*
 * The golden fingerprints of briefs staged as the desk staged them before library units
 * (desk-brief-golden.test.ts; written by desk-brief-golden-write.ts into
 * fixtures/desk-embed/staged-golden.json at the commit before any staging change): every fixture
 * brief without pins and five synthetic briefs (an interior, water, animals the desk stands in for,
 * a rider on a mount, a kite and a balloon in flight), each with
 * - `hash`: the brief's hash (record.ts briefHash, as the report gives it);
 * - `record`: the brief record staging wrote, with the desk's ids as names;
 * - `report`: what stageBrief reported (the fields it had then), with ids as names;
 * - `fingerprint`: a digest of every datablock of the staged document (objects, meshes, materials,
 *   cameras, lights, armatures, curves, collections, images, F-curves, drivers, shots, the scene's
 *   settings, the world and the render settings) by name. Staging is deterministic apart from its
 *   random ids, so names stand for ids (`<obj:Mira>`), the motion digests the import records (which
 *   digest ids) are neutralised, and numbers are rounded to 1e-6.
 * Equal entries: the brief staged exactly as before.
 */

/** The fixtures folder of the staging tests. */
export const DESK_EMBED_FIXTURES = new URL('./fixtures/desk-embed/', import.meta.url);
/** The golden file, in DESK_EMBED_FIXTURES. */
export const GOLDEN_FILE = 'staged-golden.json';

/** A section of a fingerprint: each datablock (or setting) by name, with the digest of its content. */
export type GoldenSection = Record<string, string>;

/** A brief staged, as the golden file keeps it. */
export interface GoldenEntry {
  hash: string;
  record: unknown;
  report: unknown;
  fingerprint: Record<string, GoldenSection>;
}

export interface GoldenFile {
  about: string;
  briefs: Record<string, GoldenEntry>;
}

// ---------------------------------------------------------------- briefs

const shot = (
  over: Partial<SceneBrief['shots'][number]> & Pick<SceneBrief['shots'][number], 'id' | 'index'>,
): SceneBrief['shots'][number] => ({
  durationSec: 2,
  description: '',
  action: '',
  castIds: [],
  elementIds: [],
  framing: null,
  movement: null,
  move: null,
  lensMm: null,
  continuity: 'cut',
  layout: [],
  ...over,
});

/** The synthetic briefs, by golden name: each stages a part of the words the fixtures leave out. */
export const SYNTHETIC_BRIEFS: Record<string, SceneBrief> = {
  // an interior from the words (no interior flag), a person kind from words, a held prop that does not fly
  'synthetic:interior': {
    id: 'scn_golden.interior',
    name: 'Breakfast',
    fps: 24,
    width: 640,
    height: 360,
    set: {
      description: 'Inside a small kitchen, morning light through the window, a table in the middle.',
      interior: null,
      timeOfDay: 'morning',
    },
    cast: [
      {
        id: 'ada',
        name: 'Ada',
        description: 'A woman of 40 in a green cardigan.',
        kind: null,
        heightM: 1.66,
      },
      { id: 'ben', name: 'Ben', description: 'Her son, a boy of 10.', kind: 'person', heightM: null },
    ],
    elements: [
      { id: 'kitchen', name: 'The kitchen', description: 'A small kitchen with a table.', kind: 'location' },
      { id: 'teapot', name: 'Teapot', description: 'A blue teapot.', kind: 'prop' },
      { id: 'mood', name: 'Warm light', description: 'A warm, soft look.', kind: 'other' },
    ],
    shots: [
      shot({
        id: 'k1',
        index: 0,
        durationSec: 2.5,
        description: 'Medium: Ada pours tea from the teapot while Ben watches.',
        castIds: ['ada', 'ben'],
        elementIds: ['kitchen', 'teapot'],
        framing: 'medium',
        movement: 'static',
        layout: [
          { castId: 'ada', side: 'left', facing: 'right' },
          { castId: 'ben', side: 'right', facing: 'left' },
        ],
      }),
      shot({
        id: 'k2',
        index: 1,
        durationSec: 1.5,
        description: 'Close-up: Ben smiles.',
        castIds: ['ben'],
        framing: 'close_up',
        movement: 'dolly_in',
      }),
    ],
  },
  // a river in front of the cast from a location's words, at dusk; a shot that sets its own lens and move
  'synthetic:water': {
    id: 'scn_golden.water',
    name: 'The crossing',
    fps: 30,
    width: 1280,
    height: 720,
    set: { description: 'A grassy bank at dusk.', interior: false, timeOfDay: 'dusk' },
    cast: [
      { id: 'tom', name: 'Tom', description: 'An old fisherman with a beard.', kind: 'man', heightM: 1.8 },
      {
        id: 'lia',
        name: 'Lia',
        description: 'A young woman with a red scarf.',
        kind: 'woman',
        heightM: null,
      },
    ],
    elements: [
      { id: 'river', name: 'The river', description: 'A wide river in front of them.', kind: 'location' },
      { id: 'basket', name: 'Basket', description: 'A wicker basket.', kind: 'prop' },
    ],
    shots: [
      shot({
        id: 'w1',
        index: 0,
        durationSec: 3,
        description: 'Wide: Tom and Lia stand on the bank looking at the river.',
        castIds: ['tom', 'lia'],
        elementIds: ['river', 'basket'],
        framing: 'wide',
        movement: 'pan_right',
      }),
      shot({
        id: 'w2',
        index: 2,
        durationSec: 2,
        description: 'Over the shoulder: Lia talks to Tom.',
        castIds: ['lia', 'tom'],
        framing: 'over_shoulder',
        lensMm: 50,
        move: 'locked_off',
        continuity: 'continuous',
      }),
    ],
  },
  // animals the desk has no figure for stand in as the nearest kind it builds; an unknown hint; a cast
  // member in no shot
  'synthetic:animals': {
    id: 'scn_golden.animals',
    name: 'The farmyard',
    fps: 24,
    width: 640,
    height: 360,
    set: { description: 'A muddy farmyard at noon.', interior: false, timeOfDay: 'noon' },
    cast: [
      { id: 'daisy', name: 'Daisy', description: 'A white duck.', kind: 'duck', heightM: null },
      { id: 'gus', name: 'Gus', description: 'A tall farmer in a hat.', kind: 'griffin', heightM: null },
      { id: 'tweety', name: 'Tweety', description: 'A small yellow bird.', kind: null, heightM: null },
      { id: 'bess', name: 'Bess', description: 'A brown and white cow.', kind: 'cow', heightM: null },
      { id: 'rex', name: 'Rex', description: 'A sheepdog.', kind: null, heightM: null },
    ],
    elements: [],
    shots: [
      shot({
        id: 'a1',
        index: 0,
        durationSec: 2,
        description: 'Wide: the animals gather around Gus.',
        castIds: ['daisy', 'gus', 'tweety', 'bess'],
        framing: 'wide',
        movement: 'static',
      }),
      shot({
        id: 'a2',
        index: 1,
        durationSec: 1,
        description: 'Daisy waddles past.',
        castIds: ['daisy'],
        movement: 'whip',
      }),
    ],
  },
  // a rider gets on a mount between two shots (a pre-roll before the cut)
  'synthetic:rider': {
    id: 'scn_golden.rider',
    name: 'The ride',
    fps: 24,
    width: 640,
    height: 360,
    set: { description: 'A meadow.', interior: false, timeOfDay: null },
    cast: [
      { id: 'lily', name: 'Lily', description: 'A girl of 9.', kind: 'child', heightM: null },
      { id: 'star', name: 'Star', description: 'A brown horse.', kind: 'horse', heightM: null },
    ],
    elements: [],
    shots: [
      shot({
        id: 'r1',
        index: 0,
        durationSec: 2,
        description: 'Medium: Lily walks beside Star.',
        castIds: ['lily', 'star'],
        framing: 'medium',
        movement: 'static',
      }),
      shot({
        id: 'r2',
        index: 1,
        durationSec: 2,
        description: 'Medium: Lily rides Star across the field.',
        castIds: ['lily', 'star'],
        framing: 'medium',
        movement: 'tracking',
      }),
    ],
  },
  // a kite and a balloon held and flying on their strings, at golden hour; a prop standing on the ground
  'synthetic:kite': {
    id: 'scn_golden.kite',
    name: 'On the dunes',
    fps: 25,
    width: 960,
    height: 540,
    set: {
      description: 'Sand dunes by the sea on a windy evening, the sea on the right.',
      interior: false,
      timeOfDay: 'golden_hour',
    },
    cast: [
      { id: 'sam', name: 'Sam', description: 'A boy of 7 in shorts.', kind: 'child', heightM: 1.2 },
      { id: 'ivy', name: 'Ivy', description: 'His sister, a girl of 12.', kind: 'child', heightM: null },
    ],
    elements: [
      { id: 'kite', name: 'Green kite', description: 'A green box kite.', kind: 'prop' },
      { id: 'balloon', name: 'Red balloon', description: 'A red balloon on a string.', kind: 'prop' },
      { id: 'bucket', name: 'Bucket', description: 'A yellow sand bucket.', kind: 'prop' },
    ],
    shots: [
      shot({
        id: 'f1',
        index: 0,
        durationSec: 3,
        description: 'Wide: Sam flies the kite high above the dunes while Ivy holds the balloon.',
        action: 'Sam runs with the kite.',
        castIds: ['sam', 'ivy'],
        elementIds: ['kite', 'balloon', 'bucket'],
        framing: 'wide',
        movement: 'tracking',
        layout: [
          { castId: 'sam', side: 'left', facing: 'right' },
          { castId: 'ivy', side: 'right', facing: 'camera' },
        ],
      }),
      shot({
        id: 'f2',
        index: 1,
        durationSec: 2,
        description: 'Low angle: the kite dances in the wind.',
        castIds: ['sam'],
        elementIds: ['kite'],
        framing: 'medium',
        movement: 'tilt_up',
      }),
    ],
  },
};

/** Whether `v` holds a `unit` key at any depth (a brief with library pins). */
export function hasUnitKey(v: unknown): boolean {
  if (Array.isArray(v)) return v.some(hasUnitKey);
  if (v && typeof v === 'object')
    return Object.entries(v as Record<string, unknown>).some(([k, x]) => k === 'unit' || hasUnitKey(x));
  return false;
}

/**
 * The fixture briefs a golden covers: the scene of every open fixture in DESK_EMBED_FIXTURES (not
 * under invalid/) that validates and has no pins, by file name.
 */
export function fixtureBriefs(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of readdirSync(DESK_EMBED_FIXTURES).sort()) {
    if (!f.endsWith('.json') || f === GOLDEN_FILE) continue;
    const m = JSON.parse(readFileSync(new URL(f, DESK_EMBED_FIXTURES), 'utf8'));
    if (m?.type !== 'open' || hasUnitKey(m.scene) || !SceneBriefSchema.safeParse(m.scene).success) continue;
    out[f] = m.scene;
  }
  return out;
}

/** Every brief a golden covers, by golden name. */
export const goldenBriefs = (): Record<string, unknown> => ({ ...fixtureBriefs(), ...SYNTHETIC_BRIEFS });

// ---------------------------------------------------------------- fingerprint

/** The datablock lists of a snapshot, with the prefix their names take in a fingerprint. */
const KINDS = [
  ['objects', 'obj'],
  ['meshes', 'mesh'],
  ['materials', 'mat'],
  ['cameras', 'cam'],
  ['lights', 'light'],
  ['armatures', 'arm'],
  ['curves', 'curve'],
  ['collections', 'col'],
  ['images', 'img'],
] as const;

/** The custom prop holding the import's motion digest (a digest of ids: neutralised). */
const MOTION_PROP = 'desk_rideo_motion';

const round = (v: number): number => {
  const r = Math.round(v * 1e6) / 1e6;
  return Object.is(r, -0) ? 0 : r;
};

/** A short digest of a text (sha256, 16 hex digits). */
const hashOf = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 16);

/** The canonical JSON of a normalised value (keys sorted). */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object')
    return `{${Object.keys(v as Record<string, unknown>)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  return JSON.stringify(v) ?? 'null';
}

/** Replaces ids by names: a normaliser for one staged document. */
class Names {
  private readonly token = new Map<string, string>();
  private pattern: RegExp | null = null;

  add(id: string, name: string): void {
    if (id && !this.token.has(id)) this.token.set(id, `<${name}>`);
    this.pattern = null;
  }

  text(s: string): string {
    if (!this.token.size) return s;
    this.pattern ??= new RegExp([...this.token.keys()].sort((a, b) => b.length - a.length).join('|'), 'g');
    return s.replace(this.pattern, (id) => this.token.get(id)!);
  }

  /** `v` with ids as names, numbers rounded, typed arrays as lists, the motion digests neutralised. */
  value(v: unknown, key?: string): unknown {
    if (key === MOTION_PROP && typeof v === 'string') return '<motion>';
    if (typeof v === 'string') return this.text(v);
    if (typeof v === 'number') return round(v);
    if (ArrayBuffer.isView(v))
      return v instanceof Uint8Array
        ? hashOf(Buffer.from(v).toString('base64'))
        : Array.from(v as unknown as ArrayLike<number>, round);
    if (Array.isArray(v)) return v.map((x) => this.value(x));
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>))
        if (x !== undefined) out[this.text(k)] = this.value(x, k);
      return out;
    }
    return v;
  }
}

/**
 * Names the items with ids inside datablock `owner` (an object's constraints, modifiers, particle
 * systems …): `<field>:<owner>/<item name>`.
 */
function nestedNames(names: Names, v: unknown, owner: string, field = ''): void {
  if (Array.isArray(v))
    v.forEach((x, i) => {
      if (x && typeof x === 'object' && typeof (x as { id?: unknown }).id === 'string') {
        const item = x as { id: string; name?: unknown };
        names.add(item.id, `${field}:${owner}/${typeof item.name === 'string' ? item.name : i}`);
      }
      nestedNames(names, x, owner, field);
    });
  else if (v && typeof v === 'object')
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) nestedNames(names, x, owner, k);
}

/** The names of a staged document's datablocks, the items inside them, and its shots (see Names). */
function namesOf(doc: SceneDoc, snap: ReturnType<SceneDoc['toSnapshot']>): Names {
  const names = new Names();
  for (const [list, prefix] of KINDS)
    for (const b of snap[list] as { id: string; name?: string }[])
      names.add(b.id, `${prefix}:${b.name ?? ''}`);
  for (const [list, prefix] of KINDS)
    for (const b of snap[list] as { id: string; name?: string }[]) {
      const { id: _id, ...fields } = b;
      nestedNames(names, fields, `${prefix}:${b.name ?? ''}`);
    }
  for (const s of getShots(doc)) names.add(s.id, `shot:${s.name}`);
  return names;
}

/** A section of `items`, each by the name `keyOf` gives it (repeated names: their digests joined in order). */
function section(items: unknown[], keyOf: (x: any) => string): GoldenSection {
  const out: GoldenSection = {};
  const all = items.map((x) => [keyOf(x), hashOf(canonical(x))] as const);
  all.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  for (const [k, h] of all) out[k] = k in out ? `${out[k]}+${h}` : h;
  return out;
}

/**
 * The fingerprint of a staged document (see the module comment), with its record and the report of
 * its staging normalised the same way.
 */
export function fingerprintOf(doc: SceneDoc, report: StageBriefReport): GoldenEntry {
  const snap = doc.toSnapshot();
  const names = namesOf(doc, snap);
  const n = (v: unknown) => names.value(v) as any;
  const { brief: _record, ...scene } = snap.scene as unknown as Record<string, unknown>;
  const fingerprint: Record<string, GoldenSection> = {};
  for (const [list, prefix] of KINDS)
    fingerprint[list] = section(n(snap[list]), (b) => `${prefix}:${b.name ?? ''}`);
  fingerprint.fcurves = section(
    n(snap.fcurves),
    (f) => `${f.target_type}|${f.target_id}|${f.path}|${f.index}`,
  );
  fingerprint.drivers = section(n(snap.drivers), (d) =>
    canonical([d.target_type, d.target_id, d.path, d.index]),
  );
  fingerprint.shots = section(n(getShots(doc)), (s) => `shot:${s.name}`);
  fingerprint.scene = Object.fromEntries(
    Object.keys(scene)
      .sort()
      .map((k) => [k, hashOf(canonical(n(scene[k])))]),
  );
  fingerprint.settings = {
    world: hashOf(canonical(n(snap.world))),
    render: hashOf(canonical(n(snap.render))),
  };
  const { sceneId, hash, shots, cast, props, changes, solved, warnings, issues } = report;
  return {
    hash,
    record: n(readBriefRecord(doc)),
    report: n({ sceneId, hash, shots, cast, props, changes, solved, warnings, issues }),
    fingerprint,
  };
}

/** Stages brief `raw` in an empty document (with `stage`, stageBrief by default) and fingerprints it. */
export function stageGolden(
  raw: unknown,
  stage: (doc: SceneDoc, brief: SceneBrief) => StageBriefReport = (doc, brief) => stageBrief(doc, brief),
): GoldenEntry {
  const brief = SceneBriefSchema.parse(raw);
  const doc = SceneDoc.create({ empty: true });
  try {
    return fingerprintOf(doc, stage(doc, brief));
  } finally {
    doc.destroy();
  }
}

/** The digest of a normalised value (a golden entry's record, say): equal values, equal digests. */
export const goldenDigest = (v: unknown): string => hashOf(canonical(v));

/** The golden file as it is on disk. */
export const readGolden = (): GoldenFile =>
  JSON.parse(readFileSync(new URL(GOLDEN_FILE, DESK_EMBED_FIXTURES), 'utf8')) as GoldenFile;
