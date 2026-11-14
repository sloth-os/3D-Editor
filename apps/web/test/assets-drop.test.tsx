import { afterEach, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import * as Y from 'yjs';
import { SceneDoc, builtinResult, getCatalogEntry, type StoreResult } from '@3d-editor/core';
import { session as sessionSignal } from '../src/app/store';
import { viewport } from '../src/editor/editor';
import { EditorStateSignals, ViewState } from '../src/editor/state';
import type { ProjectSession } from '../src/project/session';
import type { ViewportEngine } from '../src/viewport/engine';
import {
  ASSET_DRAG_TYPE,
  assetDragOver,
  dropAsset,
  dropLocation,
  getAssetDragData,
  hasAssetDrag,
  setAssetDragData,
  type DropTarget,
} from '../src/ui/assets/drop';

/*
 * Dragging a model card into the viewport: the drag carries the model as
 * application/x-3d-editor-asset, and the drop inserts it on the surface under the pointer, else on
 * the ground plane z = 0, else at the 3D cursor.
 */

/** A DataTransfer as browsers fill it (types listed, data readable on drop). */
class FakeDataTransfer {
  private data = new Map<string, string>();
  effectAllowed = 'all';
  dropEffect = 'none';
  get types(): string[] {
    return [...this.data.keys()];
  }
  setData(type: string, value: string): void {
    this.data.set(type, value);
  }
  getData(type: string): string {
    return this.data.get(type) ?? '';
  }
}

const chair = (): StoreResult => builtinResult(getCatalogEntry('chair')!);

const W = 200;
const H = 100;

/** A camera 10 m in front of the origin and 5 m up, looking at it (Z up), and a 2 m box on the ground. */
function scene(far = 1000): { target: DropTarget; box: THREE.Mesh; camera: THREE.PerspectiveCamera } {
  const camera = new THREE.PerspectiveCamera(50, W / H, 0.1, far);
  camera.up.set(0, 0, 1);
  camera.position.set(0, -10, 5);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  camera.updateProjectionMatrix();
  const box = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), new THREE.MeshBasicMaterial());
  box.position.set(0, 0, 1);
  box.updateMatrixWorld();
  const target: DropTarget = {
    camera,
    rayAt(x, y) {
      const rc = new THREE.Raycaster();
      rc.setFromCamera(new THREE.Vector2((x / W) * 2 - 1, -(y / H) * 2 + 1), camera);
      return rc;
    },
    objects: { pickables: () => [box] },
  };
  return { target, box, camera };
}

function fakeSession(): ProjectSession {
  const doc = SceneDoc.create({ empty: true });
  const undo = new Y.UndoManager(doc.sharedTypes(), {
    trackedOrigins: new Set([doc.origin]),
    captureTimeout: 0,
  });
  return {
    id: 'drop-test',
    doc,
    undo,
    state: new EditorStateSignals(),
    view: new ViewState(),
  } as unknown as ProjectSession;
}

afterEach(() => {
  sessionSignal.value = null;
  viewport.engine = null;
});

describe('asset drag data', () => {
  it('carries the model as application/x-3d-editor-asset and reads it back on drop', () => {
    const dt = new FakeDataTransfer();
    setAssetDragData(dt as unknown as DataTransfer, chair());
    expect(ASSET_DRAG_TYPE).toBe('application/x-3d-editor-asset');
    expect(dt.types).toEqual([ASSET_DRAG_TYPE]);
    expect(dt.effectAllowed).toBe('copy');
    expect(hasAssetDrag(dt as unknown as DataTransfer)).toBe(true);
    const data = getAssetDragData(dt as unknown as DataTransfer)!;
    expect(data).toMatchObject({ v: 1, model: 'builtin:chair', provider: 'builtin', name: chair().name });
    expect(data.result).toEqual(chair());
  });

  it('ignores other drags and data that is not a model', () => {
    const files = new FakeDataTransfer();
    files.setData('Files', '');
    expect(hasAssetDrag(files as unknown as DataTransfer)).toBe(false);
    expect(getAssetDragData(files as unknown as DataTransfer)).toBeNull();
    expect(hasAssetDrag(null)).toBe(false);
    const bad = (value: string) => {
      const dt = new FakeDataTransfer();
      dt.setData(ASSET_DRAG_TYPE, value);
      return getAssetDragData(dt as unknown as DataTransfer);
    };
    expect(bad('not json')).toBeNull();
    expect(bad(JSON.stringify({ v: 2, model: 'builtin:chair', result: chair() }))).toBeNull();
    // the result must be the model named
    expect(bad(JSON.stringify({ v: 1, model: 'builtin:table', result: chair() }))).toBeNull();
    expect(bad(JSON.stringify({ v: 1, model: 'builtin:chair', result: { id: 'builtin:chair' } }))).toBeNull();
  });

  it('marks a model drag over the viewport as a copy', () => {
    const dt = new FakeDataTransfer();
    setAssetDragData(dt as unknown as DataTransfer, chair());
    expect(assetDragOver({ dataTransfer: dt } as unknown as DragEvent)).toBe(true);
    expect(dt.dropEffect).toBe('copy');
    const other = new FakeDataTransfer();
    expect(assetDragOver({ dataTransfer: other } as unknown as DragEvent)).toBe(false);
    expect(other.dropEffect).toBe('none');
  });
});

describe('drop location', () => {
  it('lands on the surface under the pointer', () => {
    const { target } = scene();
    const r = dropLocation(target, W / 2, H / 2, [9, 9, 9]);
    expect(r.source).toBe('hit');
    // the centre ray meets the box's front face (y = -1) at z = 0.5
    expect(r.location[0]).toBeCloseTo(0, 6);
    expect(r.location[1]).toBeCloseTo(-1, 6);
    expect(r.location[2]).toBeCloseTo(0.5, 6);
  });

  it('lands on the ground plane where nothing is hit, and skips pick proxies', () => {
    const { target, box } = scene();
    const r = dropLocation(target, 10, H - 5, [9, 9, 9]);
    expect(r.source).toBe('ground');
    expect(r.location[2]).toBe(0);
    expect(r.location[0]).toBeLessThan(-1);
    // a helper's pick proxy is not a surface
    box.userData.pickProxy = true;
    expect(dropLocation(target, W / 2, H / 2, [9, 9, 9]).source).toBe('ground');
  });

  it('falls back to the 3D cursor when the ground is out of reach or behind', () => {
    // the top edge's ray meets the ground ~180 m away: beyond a 100 m far clip
    const near = scene(100);
    expect(dropLocation(near.target, W / 2, 0, [1, 2, 3])).toEqual({ location: [1, 2, 3], source: 'cursor' });
    // looking up: the ground is behind the camera
    const up = scene();
    up.camera.lookAt(0, 0, 50);
    up.camera.updateMatrixWorld();
    up.box.visible = false;
    expect(dropLocation({ ...up.target, objects: { pickables: () => [] } }, W / 2, H / 2, [4, 5, 6])).toEqual(
      {
        location: [4, 5, 6],
        source: 'cursor',
      },
    );
  });
});

describe('dropping a card on the viewport', () => {
  function dropEvent(dt: FakeDataTransfer, x: number, y: number) {
    let prevented = false;
    const e = {
      dataTransfer: dt,
      clientX: 10 + x,
      clientY: 20 + y,
      preventDefault: () => (prevented = true),
    } as unknown as DragEvent;
    return { e, prevented: () => prevented };
  }

  it('inserts the model where it is dropped, as one undo step', () => {
    const s = fakeSession();
    sessionSignal.value = s;
    const { target } = scene();
    viewport.engine = {
      ...target,
      camera: target.camera,
      canvas: { getBoundingClientRect: () => ({ left: 10, top: 20, width: W, height: H }) },
    } as unknown as ViewportEngine;
    const dt = new FakeDataTransfer();
    setAssetDragData(dt as unknown as DataTransfer, chair());
    const { e, prevented } = dropEvent(dt, W / 2, H / 2);
    expect(dropAsset(e)).toBe(true);
    expect(prevented()).toBe(true);
    const root = s.doc.listObjects().find((o) => o.type === 'EMPTY' && !o.parent)!;
    expect(root.location[1]).toBeCloseTo(-1, 6);
    expect(root.location[2]).toBeCloseTo(0.5, 6);
    expect(s.undo.undoStack).toHaveLength(1);
  });

  it('uses the 3D cursor without a viewport, and leaves other drops to the viewport', () => {
    const s = fakeSession();
    sessionSignal.value = s;
    s.state.cursorLocation = [3, 4, 0];
    const dt = new FakeDataTransfer();
    setAssetDragData(dt as unknown as DataTransfer, chair());
    expect(dropAsset(dropEvent(dt, 0, 0).e)).toBe(true);
    expect(s.doc.listObjects().find((o) => o.type === 'EMPTY' && !o.parent)!.location).toEqual([3, 4, 0]);

    const files = new FakeDataTransfer();
    files.setData('Files', '');
    const other = dropEvent(files, 0, 0);
    expect(dropAsset(other.e)).toBe(false);
    expect(other.prevented()).toBe(false);
  });
});
