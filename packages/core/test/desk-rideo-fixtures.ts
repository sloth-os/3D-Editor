import type { z } from 'zod';
import type { SceneDoc } from '../src/doc/scene-doc';
import type { Vec3 } from '../src/math/types';
import { FrameState } from '../src/eval/frame-state';
import { importRideoBlocking, type RideoImportResult } from '../src/desk/rideo/import';
import type { RideoImportInputSchema, RideoSceneBlockingSchema } from '../src/desk/rideo/schema';
import { createEditorState, type OperatorContext } from '../src/operators/context';
import { solveShotCameras } from '../src/operators/desk-shots';

/*
 * Three rideo clips as rideo stores them (SceneBlocking v1 and the clip around it, in rideo's own
 * field names and ids), for the rideo import and export tests: a dialogue in shot / reverse shot, a
 * girl riding her pony, and a boy flying a kite. rideo's axes: x right, y up, z toward the audience;
 * a facing of 0° looks at the audience, 90° to the right. The editor's axes are rideo (x, −z, y).
 */

export type BlockingInput = z.input<typeof RideoSceneBlockingSchema>;
export type ImportInput = z.input<typeof RideoImportInputSchema>;

export const MAYA = 'chr_maya0000001a';
export const LEO = 'chr_leo00000001b';
export const ROSIE = 'chr_rosie000001c';
export const PEPPER = 'chr_pepper00001d';
export const SAM = 'chr_sam00000001e';
export const MUM = 'chr_mum00000001f';

export const CUP = 'ele_teacup00001a';
export const TABLE = 'ele_table000001b';
export const KITE = 'ele_kite0000001c';
export const FENCE = 'ele_fence000001d';
export const OAK = 'ele_oaktree0001e';

export const SETTINGS = { fps: 24, width: 1920, height: 1080, aspectRatio: '16:9' };
const UPDATED = '2026-11-02T09:30:00.000Z';

/** rideo point (x, y, z) → editor. */
export const ed = (x: number, y: number, z: number): Vec3 => [x, -z, y];

// ---------------------------------------------------------------- dialogue: shot / reverse shot

export const DIALOGUE_SHOTS = [
  'sht_dlg000000001',
  'sht_dlg000000002',
  'sht_dlg000000003',
  'sht_dlg000000004',
  'sht_dlg000000005',
  'sht_dlg000000006',
] as const;

export function dialogueBlocking(): BlockingInput {
  const [s1, s2, s3, s4, s5, s6] = DIALOGUE_SHOTS;
  return {
    version: 1,
    source: 'ai',
    updatedAt: UPDATED,
    set: {
      width: 10,
      depth: 8,
      ground: 'stone paving',
      interior: false,
      sun: { azimuthDeg: 140, elevationDeg: 50 },
      landmarks: [
        {
          id: 'l1',
          label: 'bistro table',
          shape: 'cylinder',
          x: 0,
          z: 0,
          width: 0.7,
          depth: 0.7,
          height: 1.05,
          elementId: TABLE,
        },
        { id: 'l2', label: 'brick wall', shape: 'wall', x: 0, z: -3, width: 8, depth: 0.25, height: 3 },
      ],
    },
    actors: [
      { id: 'a1', characterId: MAYA, color: '#ff8a3d', heightM: 1.4, x: -0.9, z: 0, facingDeg: 90 },
      { id: 'a2', characterId: LEO, color: '#3d8bff', heightM: 1.78, x: 0.9, z: 0, facingDeg: 270 },
    ],
    props: [
      {
        id: 'p1',
        elementId: CUP,
        label: 'teacup',
        x: 0.6,
        z: 0.1,
        size: 0.12,
        color: '#f4efe6',
        heldBy: LEO,
      },
    ],
    shots: {
      [s1]: {
        camera: { x: 0, y: 1.5, z: 5, targetX: 0, targetY: 1.2, targetZ: 0, lensMm: 32 },
        spec: { subjects: [MAYA, LEO], angle: 'front', height: 'eye', move: 'none' },
      },
      [s2]: {
        camera: { x: -2, y: 1.45, z: 0.8, targetX: 0.9, targetY: 1.55, targetZ: 0, lensMm: 45 },
        spec: { subjects: [LEO], angle: 'over_shoulder', height: 'eye', move: 'none' },
      },
      [s3]: {
        camera: { x: 2, y: 1.6, z: 0.8, targetX: -0.9, targetY: 1.2, targetZ: 0, lensMm: 45 },
        spec: { subjects: [MAYA], angle: 'over_shoulder', height: 'eye', move: 'none' },
      },
      [s4]: {
        camera: {
          x: 1.2,
          y: 1.25,
          z: 1.4,
          targetX: -0.9,
          targetY: 1.2,
          targetZ: 0,
          lensMm: 50,
          end: { x: 0.6, y: 1.25, z: 1.0, targetX: -0.9, targetY: 1.2, targetZ: 0 },
        },
      },
      [s5]: {
        marks: { [LEO]: { x: 0.9, z: 0, facingDeg: 140, pose: 'walk', toX: 2.8, toZ: -2.2 } },
        camera: {
          x: 0,
          y: 1.5,
          z: 5.5,
          targetX: 0.5,
          targetY: 1.1,
          targetZ: 0,
          lensMm: 28,
          end: { x: 0, y: 1.5, z: 5.5, targetX: 2.5, targetY: 1.1, targetZ: -2 },
        },
      },
      // Maya has gone over to the door at the cut (a jump: the import opens the shot with a pre-roll)
      [s6]: {
        marks: { [MAYA]: { x: -2.2, z: 1, facingDeg: 45, pose: 'point' } },
        camera: { x: -0.6, y: 1.4, z: 3.6, targetX: -2.2, targetY: 1.1, targetZ: 1, lensMm: 40 },
      },
    },
  };
}

export function dialogueClip(): ImportInput {
  const [s1, s2, s3, s4, s5, s6] = DIALOGUE_SHOTS;
  return {
    blocking: dialogueBlocking(),
    state: 'ready',
    project: 'prj_cafe00000001',
    clip: 'clp_cafe00000001',
    settings: SETTINGS,
    modelLimits: { minSeconds: 2, maxSeconds: 10 },
    characters: [
      {
        id: MAYA,
        name: 'Maya',
        summary: 'A curious ten-year-old girl in a yellow raincoat.',
        identity: { age: '10', gender: 'female', height: '1.40 m' },
        heightM: 1.4,
      },
      {
        id: LEO,
        name: 'Leo',
        summary: "Maya's grandfather, a retired sailor with a white beard.",
        identity: { age: '70', gender: 'male' },
        heightM: 1.78,
      },
    ],
    elements: [
      { id: CUP, name: 'Teacup', kind: 'prop', label: 'teacup' },
      { id: TABLE, name: 'Bistro table', kind: 'location', label: 'bistro table' },
    ],
    shots: [
      {
        id: s1,
        index: 0,
        durationSec: 3,
        description: 'Maya and her grandfather Leo stand at a bistro table outside the café.',
        camera: { framing: 'wide', movement: 'static', lensMm: 32 },
        characterIds: [MAYA, LEO],
        elementIds: [TABLE, CUP],
        layout: [
          { characterId: MAYA, side: 'left', facing: 'right' },
          { characterId: LEO, side: 'right', facing: 'left' },
        ],
        boardState: 'approved',
      },
      {
        id: s2,
        index: 1,
        durationSec: 2.5,
        description: 'Over Maya’s shoulder: Leo tells her about the storm of 1979.',
        camera: { framing: 'over_shoulder', movement: 'static' },
        characterIds: [LEO, MAYA],
      },
      {
        id: s3,
        index: 2,
        durationSec: 2.5,
        description: 'The reverse: Maya listens, wide-eyed.',
        camera: { framing: 'over_shoulder', movement: 'static' },
        characterIds: [MAYA, LEO],
      },
      {
        id: s4,
        index: 3,
        durationSec: 3,
        description: 'Close on Maya as she realises what he means.',
        camera: { framing: 'close_up', movement: 'dolly_in', move: 'push_in', lensMm: 50 },
        characterIds: [MAYA],
      },
      {
        id: s5,
        index: 4,
        durationSec: 4,
        description: 'Leo walks over to the wall; the camera pans with him.',
        camera: { framing: 'wide', movement: 'pan' },
        characterIds: [LEO, MAYA],
      },
      {
        id: s6,
        index: 5,
        durationSec: 3,
        description: 'Maya points at the old photograph by the door.',
        camera: { framing: 'medium', movement: 'static' },
        angle: 'three_quarter_left',
        characterIds: [MAYA],
      },
    ],
  };
}

// ---------------------------------------------------------------- riding: a girl and her pony

export const RIDING_SHOTS = ['sht_rid000000001', 'sht_rid000000002', 'sht_rid000000003'] as const;

export function ridingClip(): ImportInput {
  const [r1, r2, r3] = RIDING_SHOTS;
  const blocking: BlockingInput = {
    version: 1,
    source: 'ai',
    updatedAt: UPDATED,
    set: {
      width: 16,
      depth: 12,
      ground: 'grass',
      sun: { azimuthDeg: 210, elevationDeg: 35 },
      landmarks: [
        {
          id: 'l1',
          label: 'paddock fence',
          shape: 'wall',
          x: 0,
          z: -4.5,
          width: 14,
          depth: 0.12,
          height: 1.1,
          elementId: FENCE,
        },
        {
          id: 'l2',
          label: 'water trough',
          shape: 'box',
          x: 4.5,
          z: -1.5,
          width: 1.4,
          depth: 0.5,
          height: 0.55,
        },
        { id: 'l3', label: 'pond', shape: 'water', x: -5, z: 3.5, width: 3, depth: 2, height: 0.05 },
      ],
    },
    actors: [
      { id: 'a1', characterId: ROSIE, color: '#ff8a3d', heightM: 1.3, x: -1.2, z: 1, facingDeg: 90 },
      // rideo's default height: the pony's own is the import's
      { id: 'a2', characterId: PEPPER, color: '#3d8bff', heightM: 1.7, x: 0.6, z: 1, facingDeg: 270 },
    ],
    props: [],
    shots: {
      [r1]: {
        marks: { [ROSIE]: { x: -1.2, z: 1, facingDeg: 90, pose: 'walk', toX: -0.2, toZ: 1 } },
        camera: { x: 0, y: 1.6, z: 7.5, targetX: 0, targetY: 0.9, targetZ: 1, lensMm: 35 },
      },
      [r2]: {
        // rideo's normalize keeps two marks 0.35 m apart: the rider stands next to its mount's
        marks: {
          [ROSIE]: { x: -3, z: -2.15, facingDeg: 90, pose: 'sit' },
          [PEPPER]: { x: -3, z: -2.5, facingDeg: 90, pose: 'walk', toX: 2.5, toZ: -2.5 },
        },
        camera: {
          x: -5.5,
          y: 1.5,
          z: 1.5,
          targetX: -3,
          targetY: 1,
          targetZ: -2.5,
          lensMm: 35,
          end: { x: 0, y: 1.5, z: 1.5, targetX: 2.5, targetY: 1, targetZ: -2.5 },
        },
      },
      [r3]: {
        marks: {
          [PEPPER]: { x: 3.4, z: -1.6, facingDeg: 90, pose: 'stand' },
          [ROSIE]: { x: 3.4, z: -0.7, facingDeg: 180, pose: 'stand' },
        },
        camera: { x: 3.4, y: 1.3, z: 3, targetX: 3.4, targetY: 0.9, targetZ: -1.2, lensMm: 40 },
      },
    },
  };
  return {
    blocking,
    state: 'ready',
    project: 'prj_pony00000001',
    clip: 'clp_pony00000001',
    settings: SETTINGS,
    characters: [
      {
        id: ROSIE,
        name: 'Rosie',
        summary: 'A brave eight-year-old girl in a red riding jacket.',
        identity: { age: '8', gender: 'female' },
        heightM: 1.3,
      },
      {
        id: PEPPER,
        name: 'Pepper',
        summary: "Rosie's dappled grey pony with a white mane.",
        identity: 'A small grey pony.',
      },
    ],
    elements: [{ id: FENCE, name: 'Paddock fence', kind: 'location', label: 'fence' }],
    shots: [
      {
        id: r1,
        index: 0,
        durationSec: 3,
        description: 'Rosie walks up to her pony Pepper in the paddock.',
        camera: { framing: 'wide', movement: 'static' },
        characterIds: [ROSIE, PEPPER],
        layout: [
          { characterId: ROSIE, side: 'left', facing: 'right' },
          { characterId: PEPPER, side: 'right', facing: 'left' },
        ],
      },
      {
        id: r2,
        index: 1,
        durationSec: 4,
        description: 'Rosie rides Pepper along the fence at a gentle walk.',
        camera: { framing: 'wide', movement: 'tracking' },
        characterIds: [ROSIE, PEPPER],
      },
      {
        id: r3,
        index: 2,
        durationSec: 3,
        description: 'Pepper stops at the water trough and Rosie climbs down to give him a drink.',
        camera: { framing: 'medium', movement: 'static' },
        characterIds: [PEPPER, ROSIE],
      },
    ],
  };
}

// ---------------------------------------------------------------- a kite on a windy hill

export const KITE_SHOTS = [
  'sht_kit000000001',
  'sht_kit000000002',
  'sht_kit000000003',
  'sht_kit000000004',
] as const;

export function kiteClip(): ImportInput {
  const [k1, k2, k3, k4] = KITE_SHOTS;
  const blocking: BlockingInput = {
    version: 1,
    source: 'ai',
    updatedAt: UPDATED,
    set: {
      width: 30,
      depth: 30,
      ground: 'grass',
      sun: { azimuthDeg: 120, elevationDeg: 45 },
      landmarks: [
        {
          id: 'l1',
          label: 'oak tree',
          shape: 'cylinder',
          x: 7,
          z: -8,
          width: 1.6,
          depth: 1.6,
          height: 7,
          elementId: OAK,
        },
        {
          id: 'l2',
          label: 'park bench',
          shape: 'box',
          x: -4,
          z: -2,
          width: 1.8,
          depth: 0.6,
          height: 0.9,
          rotationDeg: 20,
        },
      ],
    },
    actors: [
      { id: 'a1', characterId: SAM, color: '#ff8a3d', heightM: 1.35, x: 0, z: 0, facingDeg: 180 },
      // Mum watches Sam (rideo facing of the way from her to him: 121°)
      { id: 'a2', characterId: MUM, color: '#3d8bff', heightM: 1.68, x: -2.5, z: 1.5, facingDeg: 120 },
    ],
    props: [
      { id: 'p1', elementId: KITE, label: 'kite', x: 0.4, z: 0, size: 0.9, color: '#e5484d', heldBy: SAM },
    ],
    shots: {
      [k1]: { camera: { x: -1, y: 1.7, z: 9, targetX: 0, targetY: 2.5, targetZ: 0, lensMm: 28 } },
      // in front of her, Sam behind the camera
      [k2]: { camera: { x: -1.15, y: 1.6, z: 0.7, targetX: -2.5, targetY: 1.55, targetZ: 1.5, lensMm: 60 } },
      [k3]: {
        marks: { [SAM]: { x: 0, z: 0, facingDeg: 180, pose: 'run', toX: 0, toZ: -6 } },
        camera: { x: 2.5, y: 1.4, z: 2.5, targetX: 0, targetY: 1.2, targetZ: -1, lensMm: 35 },
      },
      // shot 4 is not blocked yet (rideo's state 'incomplete'): the import solves its camera
    },
  };
  return {
    blocking,
    state: 'incomplete',
    project: 'prj_kite00000001',
    clip: 'clp_kite00000001',
    settings: SETTINGS,
    characters: [
      {
        id: SAM,
        name: 'Sam',
        summary: 'A cheerful nine-year-old boy.',
        identity: { age: '9', gender: 'male' },
        heightM: 1.35,
      },
      {
        id: MUM,
        name: 'Mum',
        summary: "Sam's mother, patient and warm.",
        identity: { age: '38', gender: 'female' },
        heightM: 1.68,
      },
    ],
    elements: [
      { id: KITE, name: 'Red diamond kite', kind: 'prop', label: 'kite' },
      { id: OAK, name: 'Old oak tree', kind: 'location', label: 'oak tree' },
    ],
    shots: [
      {
        id: k1,
        index: 0,
        durationSec: 4,
        description: 'Sam launches his red kite into the wind while Mum watches from the path.',
        camera: { framing: 'wide', movement: 'static' },
        characterIds: [SAM, MUM],
        elementIds: [KITE],
      },
      {
        id: k2,
        index: 1,
        durationSec: 2.5,
        description: 'Mum shades her eyes and smiles.',
        camera: { framing: 'close_up', movement: 'static' },
        characterIds: [MUM],
      },
      {
        id: k3,
        index: 2,
        durationSec: 4,
        description: 'Sam runs up the hill, the kite climbing behind him.',
        camera: { framing: 'medium', movement: 'tracking' },
        characterIds: [SAM],
        elementIds: [KITE],
      },
      {
        id: k4,
        index: 3,
        durationSec: 3,
        description: 'Mum waves to Sam from the bench.',
        camera: { framing: 'wide', movement: 'static' },
        characterIds: [MUM],
      },
    ],
  };
}

// ---------------------------------------------------------------- helpers

/** An operator context for `doc` collecting its reports. */
export function rideoContext(doc: SceneDoc): OperatorContext & { reports: string[] } {
  const reports: string[] = [];
  return {
    doc,
    state: createEditorState(),
    origin: doc.origin,
    source: 'test',
    report: (level, message) => reports.push(`${level}: ${message}`),
    reports,
  };
}

/** Imports `input` into `doc` (desk.import_rideo_blocking's execute, the shot solver handed in). */
export function importClip(doc: SceneDoc, input: ImportInput): RideoImportResult {
  return importRideoBlocking(rideoContext(doc), input, solveShotCameras);
}

/** An object's evaluated world matrix at a frame. */
export function worldAt(doc: SceneDoc, id: string, frame: number) {
  const m = new FrameState(doc, frame).world(id);
  if (!m) throw new Error(`${id} has no world matrix at frame ${frame}`);
  return m;
}

/** An object's world origin at a frame. */
export const originAt = (doc: SceneDoc, id: string, frame: number): Vec3 => {
  const m = worldAt(doc, id, frame);
  return [m[12], m[13], m[14]];
};

/** An object's evaluated scale channel at a frame (its own, not its parents'). */
export function scaleAt(doc: SceneDoc, id: string, frame: number): Vec3 {
  const o = new FrameState(doc, frame).byId.get(id);
  if (!o) throw new Error(`${id} has no frame state at frame ${frame}`);
  return [o.scale[0], o.scale[1], o.scale[2]];
}

/** The rideo facing (degrees in [0, 360)) of an object's −Y axis at a frame. */
export function facingAt(doc: SceneDoc, id: string, frame: number): number {
  const m = worldAt(doc, id, frame);
  // the object's front is its −Y axis: (−m[4], −m[5]) on the floor; rideo facing atan2(x, −y)
  const d = (Math.atan2(-m[4], m[5]) * 180) / Math.PI;
  return ((d % 360) + 360) % 360;
}

/** The smallest difference between two angles in degrees. */
export const angleDiff = (a: number, b: number): number => Math.abs(((((a - b) % 360) + 540) % 360) - 180);
