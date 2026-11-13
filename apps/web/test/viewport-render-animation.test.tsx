import { afterEach, beforeEach, expect, it } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/preact';
import * as Y from 'yjs';
import { signal } from '@preact/signals';
import { SceneDoc, SceneEvaluator } from '@3d-editor/core';
import { closeDialog, openDialog, session as sessionSignal } from '../src/app/store';
import { viewport } from '../src/editor/editor';
import { EditorStateSignals, ViewState } from '../src/editor/state';
import type { ProjectSession } from '../src/project/session';
import type { RenderImageOptions, ViewportEngine } from '../src/viewport/engine';
import { DialogHost } from '../src/ui/dialogs/Dialogs';

/*
 * How the Render Animation window asks the viewport engine for its rasterized frames.
 */

function fakeSession(): ProjectSession {
  const doc = SceneDoc.create();
  const undo = new Y.UndoManager(doc.sharedTypes(), {
    trackedOrigins: new Set([doc.origin]),
    captureTimeout: 0,
  });
  const revision = signal(0);
  doc.onChange(() => revision.value++);
  return {
    id: 'render-animation-test',
    doc,
    undo,
    state: new EditorStateSignals(),
    view: new ViewState(),
    evaluator: new SceneEvaluator(doc),
    revision,
    undoRevision: signal(0),
    peers: signal([]),
    currentOperator: null,
  } as unknown as ProjectSession;
}

let s: ProjectSession;
beforeEach(() => {
  localStorage.clear();
  s = fakeSession();
  sessionSignal.value = s;
});
afterEach(() => {
  cleanup();
  closeDialog();
  viewport.engine = null;
  sessionSignal.value = null;
});

it('renders every rasterized frame of Render Animation as an animation frame: multisampled, the same anti-aliasing in all', async () => {
  // regression: the frames were final renders like F12's, anti-aliased by what the viewport drew
  // and, without samples, by how long each frame's first picture took: supersampled or smoothed
  // with SMAA from one frame to the next (ViewportEngine.finalSampling)
  s.doc.updateScene({ frame_start: 1, frame_end: 3 });
  s.doc.updateRender({ engine: 'RASTER', resolution_x: 40, resolution_y: 20, resolution_percentage: 50 });
  const asked: RenderImageOptions[] = [];
  viewport.engine = {
    renderPixels: (o: RenderImageOptions) => {
      asked.push(o);
      return { width: o.width!, height: o.height!, data: new Uint8ClampedArray(o.width! * o.height! * 4) };
    },
  } as unknown as ViewportEngine;
  openDialog('render', { animation: true });
  const { container } = render(<DialogHost />);
  fireEvent.click(container.querySelector('[data-testid="render-animation-start"]')!);
  await waitFor(
    () => expect(container.querySelector('[data-testid="render-animation-result"]')).not.toBeNull(),
    {
      timeout: 10_000,
    },
  );
  expect(asked).toEqual([1, 2, 3].map((frame) => ({ frame, width: 20, height: 10, animation: true })));
});
