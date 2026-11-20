import {
  DESK_PROPS,
  briefPins,
  listUnits,
  parseSlotKey,
  pinKey,
  readUnitHeader,
  sha256Hex as coreSha256Hex,
  slotKey,
  stateUnitRows,
  unitBudget,
  unitSize,
  unitSourceOf,
  unitStatus,
  type BriefUnitPin,
  type GivenProblem,
  type GivenUnit,
  type SceneBrief,
  type SceneDoc,
  type StageUnitRow,
  type UnitKind,
  type UnitSlot,
  type UnitSource,
} from '@3d-editor/core';
import {
  IdSchema,
  MAX_OPEN_UNIT_BYTES,
  MAX_STATE_UNITS,
  MAX_UNIT_BYTES,
  UNIT_DATA_FORMAT,
  UNIT_DATA_VERSION,
  StateUnitSchema,
  openUnitBytes,
  parseOpenUnits,
  type StateUnit,
} from './protocol';

/*
 * The library units of an open on the page's side (docs/embedding.md "Library units", "The desk's
 * part"): which of the host's `open.units` entries count for the brief's pins, the units the desk
 * keeps while the scene is open, and what the desk's Library tab shows of them. Nothing here runs
 * unless the host turned units on for the open (controller.ts acceptUnits).
 *
 * - An entry counts for a pin when its format and version are ones the desk reads, its bytes hash to
 *   its SHA-256 (WebCrypto, else core's), and its `ref@version` is pinned by the brief; the first
 *   entry of a `ref@version` counts, later ones are ignored. Whether its SHA-256 is the pin's, its
 *   header reads and its kind fits the slot is core's (brief/units.ts unitSourceOf, resolveUnits).
 * - An entry left out records why for its pin: bytes that do not hash to their SHA-256 are pending
 *   `mismatch`; another format is refused `unreadable`, a newer format version `too_new`; an entry
 *   dropped for being over 32 MiB whose `ref` and `version` are a pin's is refused `too_large`;
 *   entries past 48 MiB in all (a host over its limit) are pending `unavailable`.
 * - The units kept after the open are those an Update shots could still place (core pinsWanted),
 *   within one staging's budget (core unitBudget): the desk has no cache of units.
 * - A staging or an Update shots whose worker fails with the files (it stops, runs out of memory)
 *   runs again without them (withoutFiles): their pins wait, pending `unavailable`.
 */

/** The SHA-256 of `bytes` as 64 lowercase hex digits: WebCrypto where the page has it, else core's. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const subtle = (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto?.subtle;
  if (subtle && typeof subtle.digest === 'function') {
    try {
      const d = new Uint8Array(await subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>));
      let out = '';
      for (const b of d) out += b.toString(16).padStart(2, '0');
      return out;
    } catch {
      // a page without WebCrypto here (not a secure context): core's hash below
    }
  }
  return coreSha256Hex(bytes);
}

/** The library units an open brought: the files that count for the brief's pins, and why the others do not. */
export interface UnitIntake {
  /** Files that count for a pin (their SHA-256 checked), in the order the host sent them. */
  units: GivenUnit[];
  /** Why a pinned `ref@version` the host sent cannot be used (core's GivenProblem). */
  problems: GivenProblem[];
  /** Entries left out (logged): their index in `open.units` and why. */
  ignored: { index: number; reason: string }[];
}

/** An intake with nothing: units on, but the host sent no files. */
export const emptyIntake = (): UnitIntake => ({ units: [], problems: [], ignored: [] });

const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

/** The byte length of a host's data (an ArrayBuffer or a view of one), else null. */
function byteLengthOf(v: unknown): number | null {
  if (v instanceof ArrayBuffer || ArrayBuffer.isView(v)) return v.byteLength;
  if (Object.prototype.toString.call(v) === '[object ArrayBuffer]') return (v as ArrayBuffer).byteLength;
  return null;
}

/**
 * Reads the host's `open.units` (raw) for `brief`'s pins (see the module comment). `hash` is the
 * SHA-256 used (sha256Hex by default). Never throws for a bad entry: it is left out and logged.
 */
export async function readOpenUnits(
  raw: unknown,
  brief: SceneBrief,
  o: { hash?: (bytes: Uint8Array) => Promise<string> } = {},
): Promise<UnitIntake> {
  const hash = o.hash ?? sha256Hex;
  const pinned = new Set(briefPins(brief).map((p) => pinKey(p.pin)));
  const out = emptyIntake();
  const problem = (ref: string, version: number, p: Omit<GivenProblem, 'ref' | 'version'>) =>
    out.problems.push({ ref, version, ...p });
  const { units, dropped } = parseOpenUnits(raw);
  // entries dropped by the protocol's check: one over 32 MiB that a pin names is refused too_large
  // (permanent for that version); the others count as not sent
  for (const d of dropped) {
    const entry = Array.isArray(raw) && d.index >= 0 ? (raw[d.index] as unknown) : null;
    const ref = isRecord(entry) && typeof entry.ref === 'string' ? entry.ref : null;
    const version = isRecord(entry) && typeof entry.version === 'number' ? entry.version : null;
    const size = isRecord(entry) && isRecord(entry.unit) ? byteLengthOf(entry.unit.data) : null;
    if (ref !== null && version !== null && size !== null && size > MAX_UNIT_BYTES)
      if (pinned.has(pinKey({ ref, version }))) {
        problem(ref, version, {
          staged: 'refused',
          why: 'too_large',
          message: `${pinKey({ ref, version })}: the file sent is ${(size / 2 ** 20).toFixed(1)} MiB, over the ${MAX_UNIT_BYTES / 2 ** 20} MiB a unit may have`,
        });
        out.ignored.push({ index: d.index, reason: 'over 32 MiB' });
        continue;
      }
    out.ignored.push({ index: d.index, reason: d.problem });
  }
  // the host's index of each entry kept (the protocol keeps them in order, leaving out those dropped)
  const droppedAt = new Set(dropped.map((d) => d.index));
  const indexes: number[] = [];
  if (Array.isArray(raw)) for (let k = 0; k < raw.length; k++) if (!droppedAt.has(k)) indexes.push(k);
  const seen = new Set<string>();
  let total = 0;
  for (let i = 0; i < units.length; i++) {
    const u = units[i];
    const key = pinKey(u);
    const index = indexes[i] ?? i;
    if (!pinned.has(key)) {
      out.ignored.push({ index, reason: `${key} is pinned by no slot of the brief` });
      continue;
    }
    if (seen.has(key)) {
      out.ignored.push({ index, reason: `${key} was sent before: the first one counts` });
      continue;
    }
    seen.add(key);
    if (u.unit.format !== UNIT_DATA_FORMAT) {
      problem(u.ref, u.version, {
        staged: 'refused',
        why: 'unreadable',
        message: `${key}: a file of format '${u.unit.format}', not a unit this desk reads`,
      });
      continue;
    }
    if (u.unit.version !== UNIT_DATA_VERSION) {
      problem(u.ref, u.version, {
        staged: 'refused',
        why: u.unit.version > UNIT_DATA_VERSION ? 'too_new' : 'unreadable',
        message: `${key}: a unit of format version ${u.unit.version}; this desk reads ${UNIT_DATA_VERSION}`,
      });
      continue;
    }
    const data = openUnitBytes(u);
    // a host over its 48 MiB: the rest waits for another open (the staging's budget would not take it)
    if (total + data.byteLength > MAX_OPEN_UNIT_BYTES) {
      problem(u.ref, u.version, {
        staged: 'pending',
        why: 'unavailable',
        message: `${key}: the units sent with this open pass ${MAX_OPEN_UNIT_BYTES / 2 ** 20} MiB`,
      });
      continue;
    }
    if ((await hash(data)) !== u.sha256) {
      problem(u.ref, u.version, {
        staged: 'pending',
        why: 'mismatch',
        message: `${key}: the bytes sent do not hash to the SHA-256 sent with them`,
      });
      continue;
    }
    total += data.byteLength;
    out.units.push({ ref: u.ref, version: u.version, sha256: u.sha256, data });
  }
  return out;
}

/** The page's source of the units held (headers read now, nothing decoded): for briefChanges. */
export const intakeSource = (intake: UnitIntake): UnitSource => unitSourceOf(intake.units, intake.problems);

/** The units an intake holds, copied for a worker request (the copies' buffers can be transferred). */
export function intakeCopy(intake: UnitIntake): { units: GivenUnit[]; problems: GivenProblem[] } {
  return {
    units: intake.units.map((u) => ({ ...u, data: u.data.slice() })),
    problems: intake.problems.map((p) => ({ ...p })),
  };
}

/** The buffers of a request's unit copies (its transfer list). */
export const intakeTransfer = (copy: { units: GivenUnit[] }): Transferable[] =>
  copy.units.map((u) => u.data.buffer as ArrayBuffer);

/**
 * The intake kept after an open or an update: only the units `wanted` (core pinsWanted: those an
 * Update shots could still place), within one staging's budget (core unitBudget, in the order of
 * `wanted`); a wanted unit past the budget waits for another open (pending `unavailable`). Problems
 * are kept for the wanted pins only.
 */
export function keepWanted(intake: UnitIntake, wanted: readonly BriefUnitPin[]): UnitIntake {
  const want = new Set(wanted.map(pinKey));
  const held = new Map(intake.units.filter((u) => want.has(pinKey(u))).map((u) => [pinKey(u), u]));
  const budget = unitBudget(
    wanted.filter((p) => held.get(pinKey(p))?.sha256 === p.sha256),
    (p) => {
      const u = held.get(pinKey(p))!;
      try {
        return unitSize(readUnitHeader(u.data), u.data.byteLength);
      } catch {
        // a file that does not read: its size is the file's (staging refuses it)
        return { packed: u.data.byteLength, unpacked: 0 };
      }
    },
  );
  const units: GivenUnit[] = [];
  const problems = intake.problems.filter((p) => want.has(pinKey(p)));
  for (const u of held.values()) {
    const verdict = budget.verdicts.get(pinKey(u));
    if (verdict === undefined || verdict === 'fits') units.push(u);
    else
      problems.push({
        ref: u.ref,
        version: u.version,
        staged: verdict === 'over_budget' ? 'refused' : 'pending',
        why: verdict,
      });
  }
  return { units, problems, ignored: [] };
}

/**
 * The intake after the staging worker failed with its files (it stopped, ran out of memory, or the
 * staging threw): no files, each pin it held waiting for another open (pending `unavailable`, as
 * docs/embedding.md "When a unit is not used" says), its other problems as they were.
 */
export function withoutFiles(intake: UnitIntake, reason: string): UnitIntake {
  return {
    units: [],
    problems: [
      ...intake.problems,
      ...intake.units.map((u): GivenProblem => ({
        ref: u.ref,
        version: u.version,
        staged: 'pending',
        why: 'unavailable',
        message: `${pinKey(u)}: the staging stopped while it read the unit (${reason}); the next open tries again`,
      })),
    ],
    ignored: intake.ignored,
  };
}

/** The protocol's `from` of a unit's slot (null: none, or ids the protocol does not take). */
export function protocolFrom(
  slot: UnitSlot | null,
): { castId: string | null; elementId: string | null; set: boolean } | null {
  if (!slot) return null;
  if ('set' in slot) return { castId: null, elementId: null, set: true };
  if ('castId' in slot)
    return IdSchema.safeParse(slot.castId).success
      ? { castId: slot.castId, elementId: null, set: false }
      : null;
  return IdSchema.safeParse(slot.elementId).success
    ? { castId: null, elementId: slot.elementId, set: false }
    : null;
}

/** The pending and refused reasons (decision 5) in words, for notices and the Library tab. */
export const UNIT_REASON_WORDS: Record<string, string> = {
  missing: 'its file was not sent',
  mismatch: 'the file sent is not the pinned one',
  unavailable: 'it could not be used this time',
  unreadable: 'it is not a unit file this desk reads',
  too_new: 'it was made by a newer desk',
  too_large: 'it is larger than a unit may be',
  wrong_kind: 'it is not a unit of the right kind',
  figure_kind: 'the figure is not of the actor’s kind',
  figure_rig: 'the figure does not fit the actor’s rig or height',
  over_budget: 'it is larger than one staging takes',
  set_ground: 'its ground is not at height 0',
};

/** A reason code in words (an unknown code as it is). */
export const reasonWords = (why: string | null | undefined): string =>
  (why && UNIT_REASON_WORDS[why]) || why || 'it could not be used';

/** The name of a brief slot ('the set', a cast member's or an element's name). */
export function slotName(brief: SceneBrief, slot: string): string {
  const s = parseSlotKey(slot);
  if (!s) return slot;
  if ('set' in s) return 'the set';
  if ('castId' in s) return brief.cast.find((c) => c.id === s.castId)?.name ?? slot;
  return brief.elements.find((e) => e.id === s.elementId)?.name ?? slot;
}

/** Report rows of slots staged from the words for a reason the person should hear of (not 'local', 'not_staged'). */
export const unitMisses = (rows: readonly StageUnitRow[]): StageUnitRow[] =>
  rows.filter((r) => r.staged === 'words' && r.why !== 'local' && r.why !== 'not_staged');

/** At most this many slots are named in the notice of an open's misses. */
export const MAX_NOTICE_SLOTS = 5;

/**
 * The person's notice of the library units an open or Update shots did not use (null: none): each
 * slot's name, its pin and why, at most MAX_NOTICE_SLOTS, then how many more.
 */
export function unitNotice(rows: readonly StageUnitRow[], brief: SceneBrief): string | null {
  const misses = unitMisses(rows);
  if (!misses.length) return null;
  const named = misses.slice(0, MAX_NOTICE_SLOTS).map((r) => {
    const name = slotName(brief, r.slot);
    return `${name === 'the set' ? 'The set' : name} (${r.ref} v${r.version}): ${reasonWords(r.why)}`;
  });
  const more = misses.length - named.length;
  const n = misses.length;
  return `${n} library unit${n === 1 ? ' was' : 's were'} not used, so ${n === 1 ? 'its slot is' : 'their slots are'} staged from the brief's words. ${named.join('; ')}${more > 0 ? `; and ${more} more` : ''}.`;
}

/** state.units: the rows the scene's record gives, each checked against the protocol (≤ 128). */
export function stateUnits(doc: SceneDoc): StateUnit[] {
  const out: StateUnit[] = [];
  for (const r of stateUnitRows(doc)) {
    const parsed = StateUnitSchema.safeParse(r);
    if (parsed.success) out.push(parsed.data);
  }
  return out.slice(0, MAX_STATE_UNITS);
}

// ---------------------------------------------------------------- the Library tab's rows

/**
 * What the Library tab says of a slot or an instance: 'current' up to date; 'edited' parts edited
 * here; 'update' the brief pins another version whose file the desk holds (Update shots places it);
 * 'pending' the pinned version waits (not sent yet, or not usable this time); 'refused' the pinned
 * version cannot be used; 'local' the slot was made local.
 */
export type LibraryStatus = 'current' | 'edited' | 'update' | 'pending' | 'refused' | 'local';

export interface LibraryRow {
  /** The instance key ('set', 'cast:<id>', 'el:<id>', …), or the slot's key when it has no instance. */
  key: string;
  /** The brief slot ('set', 'cast:<castId>', 'el:<elementId>'), or null for an instance of no slot. */
  slot: string | null;
  /** The instance's root object (Make local), or null when the slot holds no instance. */
  root: string | null;
  kind: UnitKind;
  /** The unit's name (an instance's), else the slot's name in the brief. */
  name: string;
  ref: string;
  /** The version the scene holds (an instance's), else the version the slot's record or the brief pins. */
  version: number;
  status: LibraryStatus;
  /** Parts of the instance edited or deleted here (0 without an instance). */
  edited: number;
  /** The version the brief pins for the slot when it is not the one the scene holds (else null). */
  pinned: { ref: string; version: number } | null;
  /** The pending or refused reason (decision 5), else null. */
  why: string | null;
  /** The status in words ("up to date", "3 parts edited here", "the brief pins v3: Update shots places it" …). */
  text: string;
}

const KIND_OF_SLOT = (slot: UnitSlot): UnitKind =>
  'set' in slot ? 'set' : 'castId' in slot ? 'figure' : 'prop';

/** The slots in the brief's order: the set, the cast, the elements. */
function slotOrder(brief: SceneBrief): Map<string, number> {
  const order = new Map<string, number>([['set', 0]]);
  brief.cast.forEach((c, i) => order.set(slotKey({ castId: c.id }), 1 + i));
  brief.elements.forEach((e, i) => order.set(slotKey({ elementId: e.id }), 1 + brief.cast.length + i));
  return order;
}

/**
 * The Library tab's rows of the scene (see LibraryStatus): one per instance of a library unit
 * (listUnits, with unitStatus's edited and deleted parts and the brief's pin of its slot), and one
 * per brief slot with a pin or a record pin but no instance (pending, refused, made local, or a
 * version the desk holds for Update shots). `held(pin)`: whether the desk holds the pin's file now.
 * In slot order (the set, the cast, the elements), then instances of no slot.
 */
export function libraryRows(
  doc: SceneDoc,
  brief: SceneBrief,
  held: (pin: BriefUnitPin) => boolean,
): LibraryRow[] {
  const pins = new Map(briefPins(brief).map((p) => [p.key, p]));
  const records = new Map(stateUnitRows(doc).map((r) => [r.slot, r]));
  const rows: LibraryRow[] = [];
  const covered = new Set<string>();
  const v = (version: number) => `v${version}`;
  for (const inst of listUnits(doc)) {
    let edited = 0;
    try {
      const st = unitStatus(doc, inst.root);
      edited = st.edited.length + st.missing.length;
    } catch {
      // an instance whose provenance stopped reading meanwhile: no parts counted
    }
    const slot = inst.binding ? inst.key : null;
    if (slot) covered.add(slot);
    const pin = slot ? (pins.get(slot)?.pin ?? null) : null;
    const rec = slot ? records.get(slot) : undefined;
    const other = pin && (pin.ref !== inst.ref || pin.version !== inst.version) ? pin : null;
    const row: LibraryRow = {
      key: inst.key,
      slot,
      root: inst.root,
      kind: inst.kind,
      name: inst.name,
      ref: inst.ref,
      version: inst.version,
      status: 'current',
      edited,
      pinned: other ? { ref: other.ref, version: other.version } : null,
      why: null,
      text: 'up to date',
    };
    const pinWords = other
      ? other.ref === inst.ref
        ? v(other.version)
        : `${other.ref} ${v(other.version)}`
      : '';
    if (
      other &&
      rec &&
      rec.staged !== 'unit' &&
      rec.ref === other.ref &&
      rec.version === other.version &&
      !(rec.staged === 'pending' && held(other))
    ) {
      row.status = rec.staged;
      row.why = rec.why ?? null;
      row.text = `the brief pins ${pinWords}: ${rec.staged === 'refused' ? 'refused' : 'waiting'} (${reasonWords(rec.why)}); ${v(inst.version)} stays`;
    } else if (other && held(other)) {
      row.status = 'update';
      row.text = `the brief pins ${pinWords}: Update shots brings it in`;
    } else if (other) {
      row.status = 'pending';
      row.why = 'missing';
      row.text = `the brief pins ${pinWords}: waiting for its file; ${v(inst.version)} stays`;
    } else if (edited > 0) {
      row.status = 'edited';
      row.text = `${edited} part${edited === 1 ? '' : 's'} edited here`;
    }
    rows.push(row);
  }
  // slots with a pin (the brief's or the record's) and no instance
  const slots = new Set<string>([...pins.keys(), ...records.keys()]);
  for (const slot of slots) {
    if (covered.has(slot)) continue;
    const parsed = parseSlotKey(slot);
    if (!parsed) continue;
    const pin = pins.get(slot)?.pin ?? null;
    const rec = records.get(slot) ?? null;
    const name = slotName(brief, slot);
    const base = { key: slot, slot, root: null, kind: KIND_OF_SLOT(parsed), name, edited: 0 };
    // a slot made local stays so, whatever the brief pins (staging never places a unit there again)
    if (rec?.local) {
      rows.push({
        ...base,
        ref: rec.ref,
        version: rec.version,
        status: 'local',
        pinned: null,
        why: null,
        text: 'made local: it stays as it is',
      });
      continue;
    }
    if (!pin) continue;
    const samePin = rec && rec.ref === pin.ref && rec.version === pin.version;
    if (held(pin) && !(samePin && rec!.staged === 'refused')) {
      rows.push({
        ...base,
        ref: pin.ref,
        version: pin.version,
        status: 'update',
        pinned: { ref: pin.ref, version: pin.version },
        why: null,
        text: `${v(pin.version)} is here: Update shots places it`,
      });
      continue;
    }
    const staged = samePin && rec!.staged !== 'unit' ? rec!.staged : 'pending';
    const why = samePin && rec!.staged !== 'unit' ? (rec!.why ?? null) : 'missing';
    rows.push({
      ...base,
      ref: pin.ref,
      version: pin.version,
      status: staged,
      pinned: null,
      why,
      text: `${staged === 'refused' ? 'refused' : 'waiting'}: ${reasonWords(why)}; staged from the words`,
    });
  }
  const order = slotOrder(brief);
  const rank = (r: LibraryRow) => (r.slot !== null ? (order.get(r.slot) ?? order.size) : order.size + 1);
  return rows
    .map((r, i) => ({ r, i }))
    .sort((a, b) => rank(a.r) - rank(b.r) || a.i - b.i)
    .map((x) => x.r);
}

// ---------------------------------------------------------------- what can be saved

/** What the Save to library dialog can save: the set, an actor's figure or a prop. */
export interface SaveTarget {
  what: { set: true } | { root: string };
  kind: UnitKind;
  /** In words: 'The set', the cast member's or the prop's name. */
  label: string;
  /** The unit's name offered (the instance's, else the place's, the cast member's or the prop's). */
  name: string;
  /** The library version it would be a new version of (the instance it is), else null. */
  basedOn: { ref: string; version: number; name: string } | null;
  /** The brief slot it comes from, else null. */
  slot: string | null;
}

const role = (o: { custom_props?: Record<string, unknown> } | null | undefined) =>
  String(o?.custom_props?.[DESK_PROPS.role] ?? '');
/** A name without the suffix that made it unique ('Kite.001' → 'Kite'). */
const stem = (name: string) => name.replace(/\.\d{3,}$/, '') || name;

/**
 * What can be saved from the scene: the set (always), each actor with its cast member's name, and
 * each prop (the brief's props and prop instances), with the instance each would be a new version
 * of. In that order; actors and props by name.
 */
export function saveTargets(doc: SceneDoc, brief: SceneBrief): SaveTarget[] {
  const instances = listUnits(doc);
  const byRoot = new Map(instances.map((i) => [i.root, i]));
  const based = (root: string | undefined) => {
    const i = root ? byRoot.get(root) : undefined;
    return i ? { ref: i.ref, version: i.version, name: i.name } : null;
  };
  const setInst = instances.find((i) => i.key === 'set');
  const place = brief.elements.find((e) => e.kind === 'location');
  const out: SaveTarget[] = [
    {
      what: { set: true },
      kind: 'set',
      label: 'The set',
      name: setInst?.name ?? place?.name ?? brief.name,
      basedOn: setInst ? { ref: setInst.ref, version: setInst.version, name: setInst.name } : null,
      slot: 'set',
    },
  ];
  const actors: SaveTarget[] = [];
  const props: SaveTarget[] = [];
  const seen = new Set<string>();
  for (const o of doc.listObjects()) {
    const r = role(o);
    const inst = byRoot.get(o.id);
    if (r === 'actor') {
      const castId = String(o.custom_props?.[DESK_PROPS.characterId] ?? '');
      const cast = brief.cast.find((c) => c.id === castId);
      const label = cast?.name ?? stem(o.name);
      actors.push({
        what: { root: o.id },
        kind: 'figure',
        label,
        name: inst?.name ?? label,
        basedOn: based(o.id),
        slot: inst?.binding ? inst.key : cast ? slotKey({ castId: cast.id }) : null,
      });
      seen.add(o.id);
    } else if (r === 'prop' || (inst && inst.kind === 'prop')) {
      const elementId = String(o.custom_props?.[DESK_PROPS.elementId] ?? '');
      const element = brief.elements.find((e) => e.id === elementId && e.kind !== 'location');
      const label = element?.name ?? stem(o.name);
      props.push({
        what: { root: o.id },
        kind: 'prop',
        label,
        name: inst?.name ?? label,
        basedOn: based(o.id),
        slot: inst?.binding ? inst.key : element ? slotKey({ elementId: element.id }) : null,
      });
      seen.add(o.id);
    }
  }
  const byLabel = (a: SaveTarget, b: SaveTarget) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0);
  return [...out, ...actors.sort(byLabel), ...props.sort(byLabel)];
}

/**
 * The target the Save dialog starts with: the one the selected object belongs to (the object, or its
 * nearest parent that is a target), else the set.
 */
export function defaultSaveTarget(
  doc: SceneDoc,
  targets: readonly SaveTarget[],
  selected: string | null,
): SaveTarget {
  const roots = new Map(
    targets.filter((t) => 'root' in t.what).map((t) => [(t.what as { root: string }).root, t]),
  );
  let id: string | null = selected;
  for (let hops = 0; id && hops < 64; hops++) {
    const hit = roots.get(id);
    if (hit) return hit;
    id = doc.getObject(id)?.parent ?? null;
  }
  return targets[0];
}
