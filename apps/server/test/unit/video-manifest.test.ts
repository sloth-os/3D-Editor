import { describe, expect, it } from 'vitest';
import { SceneDoc, createCube, newShotId, setShots, type Mat4 } from '@3d-editor/core';
import { buildPalette } from '../../src/video/passes';
import {
  MANIFEST_VERSION,
  ShotTracks,
  buildManifest,
  credits,
  quatFromMatrix,
  timecode,
  type ManifestFile,
} from '../../src/video/manifest';
import { videoExportParamsSchema } from '../../src/video/params';
import { planExport } from '../../src/video/plan';

/*
 * manifest.json of video exports: quaternions, timecodes, the per-frame camera and subject tracks,
 * per-shot entries (files, timing, subjects, rideo fields) and the store models' credits.
 */

const S = Math.SQRT1_2;

/** Column-major matrix of a rotation about Z by `a` radians, translated. */
function rotZ(a: number, t: [number, number, number] = [0, 0, 0], scale = 1): Mat4 {
  const c = Math.cos(a) * scale;
  const s = Math.sin(a) * scale;
  return [c, s, 0, 0, -s, c, 0, 0, 0, 0, scale, 0, t[0], t[1], t[2], 1];
}

describe('quaternions and timecodes', () => {
  it('turns rotation matrices into unit quaternions [x, y, z, w] with w ≥ 0', () => {
    expect(quatFromMatrix(rotZ(0))).toEqual([0, 0, 0, 1]);
    const q = quatFromMatrix(rotZ(Math.PI / 2));
    expect(q[2]).toBeCloseTo(S, 9);
    expect(q[3]).toBeCloseTo(S, 9);
    // scale is ignored
    const scaled = quatFromMatrix(rotZ(Math.PI / 2, [1, 2, 3], 3));
    scaled.forEach((v, i) => expect(v).toBeCloseTo(q[i], 9));
    // 180° about X: the hemisphere with w ≥ 0
    const x180 = quatFromMatrix([1, 0, 0, 0, 0, -1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1]);
    expect(x180.map((v) => Math.abs(v))).toEqual([1, 0, 0, 0]);
    // −90° about Z flips to w ≥ 0
    const neg = quatFromMatrix(rotZ(-Math.PI / 2));
    expect(neg[3]).toBeGreaterThan(0);
    expect(neg[2]).toBeCloseTo(-S, 9);
    // a camera looking along +Y (rotation of 90° about X)
    const cam = quatFromMatrix([1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, -10, 0, 1]);
    expect(cam[0]).toBeCloseTo(S, 9);
    expect(cam[3]).toBeCloseTo(S, 9);
  });

  it('writes HH:MM:SS:FF at whole frames per second', () => {
    expect(timecode(0, 24)).toBe('00:00:00:00');
    expect(timecode(23, 24)).toBe('00:00:00:23');
    expect(timecode(24, 24)).toBe('00:00:01:00');
    expect(timecode(3600 * 24 + 25, 24)).toBe('01:00:01:01');
    expect(timecode(61 * 30 + 3, 30)).toBe('00:01:01:03');
    // NTSC rates count 24 frames per second (non-drop)
    expect(timecode(48, 24000 / 1001)).toBe('00:00:02:00');
  });
});

describe('shot tracks', () => {
  it('records the camera and subject boxes of each frame', () => {
    const t = new ShotTracks();
    t.add(1, undefined); // frames without metadata add nothing
    t.add(1, {
      camera: { matrix: rotZ(Math.PI / 2, [1, -2, 3.123456789]), fovY: Math.PI / 4 },
      subjects: { a: { x: 10, y: 20, w: 30, h: 40, visible: true }, b: null },
    });
    t.add(2.5, {
      camera: { matrix: rotZ(0), fovY: 0 },
      subjects: { a: { x: 0, y: 0, w: 0, h: 0, visible: false }, b: null },
    });
    expect(t.camera).toEqual([
      { frame: 1, position: [1, -2, 3.12346], rotation_quat: [0, 0, 0.707107, 0.707107], fov_deg: 45 },
      { frame: 2.5, position: [0, 0, 0], rotation_quat: [0, 0, 0, 1], fov_deg: 0 },
    ]);
    expect(t.subjects.get('a')).toEqual([
      { frame: 1, x: 10, y: 20, w: 30, h: 40, visible: true },
      { frame: 2.5, x: 0, y: 0, w: 0, h: 0, visible: false },
    ]);
    expect(t.subjects.get('b')?.every((e) => !e.visible)).toBe(true);
  });
});

describe('manifest', () => {
  function project() {
    const doc = SceneDoc.create();
    const cam = doc.listObjects().find((o) => o.type === 'CAMERA')!;
    const cube = doc.listObjects().find((o) => o.type === 'MESH')!;
    let chair = '';
    doc.transact(() => {
      doc.updateScene({ fps: 24, frame_start: 1, frame_end: 48, camera: cam.id });
      doc.updateRender({ resolution_x: 320, resolution_y: 180, resolution_percentage: 100 });
      doc.updateObject(cube.id, {
        custom_props: {
          desk_role: 'prop',
          desk_color: '#ff8a3d',
          desk_character_id: 'char-cube',
          desk_element_id: 'el-9',
        },
      });
      chair = doc.addObject({
        type: 'MESH',
        name: 'Chair',
        data: doc.addMesh('Chair', createCube({ size: 0.5 })),
        custom_props: {
          store_id: 'poly:chair-01',
          license: 'CC-BY 4.0',
          author: 'Someone',
          source_url: 'https://example.com/chair',
        },
      });
    });
    const shots = setShots(doc, [
      {
        id: newShotId(),
        name: 'Wide',
        enabled: true,
        camera: cam.id,
        frame_start: 1,
        frame_end: 12,
        subjects: [cube.id],
        framing: 'wide',
        move: 'push_in',
        notes: 'establishing',
        external: { source: 'rideo', project: 'rp', clip: 'clip-1', shot: 'rs-1', index: 0 },
      },
      {
        id: newShotId(),
        name: 'Close',
        enabled: true,
        camera: cam.id,
        frame_start: 13,
        frame_end: 24,
        subjects: [],
      },
    ]);
    return { doc, cam, cube, chair, shots };
  }

  it('describes the export, each shot and the credits', () => {
    const { doc, cam, cube, chair, shots } = project();
    const plan = planExport(doc, videoExportParamsSchema.parse({ width: 160, height: 90 }));
    const tracks = plan.shots.map(() => new ShotTracks());
    tracks[0].add(1, {
      camera: { matrix: rotZ(0, [0, -10, 1]), fovY: 0.6 },
      subjects: { [cube.id]: { x: 50, y: 20, w: 40, h: 40, visible: true } },
    });
    const files: ManifestFile[] = [
      { name: 'sequence.mp4', kind: 'sequence', bytes: 100, frames: 24, duration_s: 1, sha256: 'aa' },
      {
        name: 'shot-01-wide.mp4',
        kind: 'clip',
        pass: 'beauty',
        shot: shots[0].id,
        external_shot: 'rs-1',
        bytes: 50,
        frames: 12,
        duration_s: 0.5,
        sha256: 'bb',
      },
      {
        name: 'shot-01-wide.depth.mp4',
        kind: 'clip',
        pass: 'depth',
        shot: shots[0].id,
        bytes: 40,
        frames: 12,
        duration_s: 0.5,
        sha256: 'cc',
      },
      { name: 'shot-01-wide.png', kind: 'poster', shot: shots[0].id, bytes: 10, sha256: 'dd' },
      { name: 'shot-01-wide.jpg', kind: 'poster', shot: shots[0].id, bytes: 9, sha256: 'ee' },
      {
        name: 'shot-02-close.mp4',
        kind: 'clip',
        pass: 'beauty',
        shot: shots[1].id,
        bytes: 50,
        frames: 12,
        duration_s: 0.5,
        sha256: 'ff',
      },
    ];
    const palette = buildPalette(doc, [cube.id]);
    const m = buildManifest({
      doc,
      project: { id: 'p1', name: 'Demo' },
      createdAt: '2026-11-13T10:00:00.000Z',
      plan,
      codec: 'h264',
      look: 'material',
      quality: 'draft',
      passes: ['beauty', 'depth'],
      files,
      palette,
      tracks,
      warnings: ['something happened'],
    }) as Record<string, any>;
    expect(m).toMatchObject({
      version: MANIFEST_VERSION,
      project: { id: 'p1', name: 'Demo' },
      fps: 24,
      width: 160,
      height: 90,
      aspect: 1.777778,
      frames: 24,
      duration_s: 1,
      codec: 'h264',
      color: { matrix: 'bt709', primaries: 'bt709', transfer: 'bt709', range: 'limited' },
      passes: ['beauty', 'depth'],
      warnings: ['something happened'],
    });
    expect(m.files).toEqual(files);
    expect(m.mask_palette[0]).toMatchObject({
      index: 1,
      object: cube.id,
      color: '#' + palette[0].color.map((c) => c.toString(16).padStart(2, '0')).join(''),
    });
    expect(m.credits).toEqual([
      {
        object: chair,
        name: 'Chair',
        store_id: 'poly:chair-01',
        license: 'CC-BY 4.0',
        author: 'Someone',
        source_url: 'https://example.com/chair',
      },
    ]);
    expect(Array.isArray(m.issues)).toBe(true);
    const [wide, close] = m.shots;
    expect(wide).toMatchObject({
      id: shots[0].id,
      name: 'Wide',
      index: 0,
      external: { source: 'rideo', project: 'rp', clip: 'clip-1', shot: 'rs-1', index: 0 },
      camera: { object: cam.id, name: cam.name, lens_mm: 50, sensor_mm: 36 },
      framing: 'wide',
      move: 'push_in',
      notes: 'establishing',
      scene_frames: [1, 12],
      output_frames: 12,
      timecode_in: '00:00:00:00',
      timecode_out: '00:00:00:12',
      duration_s: 0.5,
      files: {
        beauty: 'shot-01-wide.mp4',
        depth: 'shot-01-wide.depth.mp4',
        poster: 'shot-01-wide.png',
        poster_jpeg: 'shot-01-wide.jpg',
      },
      subjects: [
        {
          object: cube.id,
          name: 'Cube',
          role: 'prop',
          color: '#ff8a3d',
          character_id: 'char-cube',
          element_id: 'el-9',
        },
      ],
      rideo: { clip: 'clip-1', shot: 'rs-1', camera_move: 'push_in' },
    });
    expect(typeof wide.blocking_line).toBe('string');
    expect(typeof wide.moves_line).toBe('string');
    expect(wide.camera_track).toEqual([
      { frame: 1, position: [0, -10, 1], rotation_quat: [0, 0, 0, 1], fov_deg: 34.3775 },
    ]);
    // subject tracks are keyed by the character id when there is one
    expect(Object.keys(wide.subject_tracks)).toEqual(['char-cube']);
    expect(close).toMatchObject({
      index: 1,
      timecode_in: '00:00:00:12',
      timecode_out: '00:00:01:00',
      files: { beauty: 'shot-02-close.mp4' },
      subjects: [],
      camera_track: [],
      external: null,
    });
    // JSON round trip (no typed arrays, no undefined)
    expect(JSON.parse(JSON.stringify(m))).toEqual(m);
  });

  it('lists credits only for objects with store attribution', () => {
    const doc = SceneDoc.create();
    expect(credits(doc)).toEqual([]);
    const cube = doc.listObjects().find((o) => o.type === 'MESH')!;
    doc.transact(() => doc.updateObject(cube.id, { custom_props: { license: 'CC0' } }));
    expect(credits(doc)).toEqual([
      { object: cube.id, name: 'Cube', store_id: null, license: 'CC0', author: null, source_url: null },
    ]);
  });
});
