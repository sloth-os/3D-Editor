import { signal, type Signal } from '@preact/signals';
import {
  emptySelection,
  type EditorMode,
  type EditorState,
  type MeshSelection,
  type PivotPoint,
  type SelectMode,
  type TransformOrientation,
  type Vec3,
} from '@3d-editor/core';

/** EditorState backed by Preact signals so the UI re-renders on change. */
export class EditorStateSignals implements EditorState {
  readonly $mode = signal<EditorMode>('OBJECT');
  readonly $selectedIds = signal<string[]>([]);
  readonly $activeId = signal<string | null>(null);
  readonly $frame = signal(1);
  readonly $cursorLocation = signal<Vec3>([0, 0, 0]);
  readonly $cursorRotation = signal<Vec3>([0, 0, 0]);
  readonly $selectMode = signal<SelectMode>('VERT');
  readonly $meshSelection = signal<MeshSelection>(emptySelection());
  readonly $pivotPoint = signal<PivotPoint>('MEDIAN_POINT');
  readonly $transformOrientation = signal<TransformOrientation>('GLOBAL');
  readonly $proportionalEditing = signal(false);
  readonly $proportionalSize = signal(1);
  readonly $proportionalFalloff = signal<EditorState['proportionalFalloff']>('SMOOTH');
  readonly $autoKeying = signal(false);

  get mode() {
    return this.$mode.value;
  }
  set mode(v) {
    this.$mode.value = v;
  }
  get selectedIds() {
    return this.$selectedIds.value;
  }
  set selectedIds(v) {
    this.$selectedIds.value = v;
  }
  get activeId() {
    return this.$activeId.value;
  }
  set activeId(v) {
    this.$activeId.value = v;
  }
  get frame() {
    return this.$frame.value;
  }
  set frame(v) {
    this.$frame.value = v;
  }
  get cursorLocation() {
    return this.$cursorLocation.value;
  }
  set cursorLocation(v) {
    this.$cursorLocation.value = v;
  }
  get cursorRotation() {
    return this.$cursorRotation.value;
  }
  set cursorRotation(v) {
    this.$cursorRotation.value = v;
  }
  get selectMode() {
    return this.$selectMode.value;
  }
  set selectMode(v) {
    this.$selectMode.value = v;
  }
  get meshSelection() {
    return this.$meshSelection.value;
  }
  set meshSelection(v) {
    this.$meshSelection.value = v;
  }
  get pivotPoint() {
    return this.$pivotPoint.value;
  }
  set pivotPoint(v) {
    this.$pivotPoint.value = v;
  }
  get transformOrientation() {
    return this.$transformOrientation.value;
  }
  set transformOrientation(v) {
    this.$transformOrientation.value = v;
  }
  get proportionalEditing() {
    return this.$proportionalEditing.value;
  }
  set proportionalEditing(v) {
    this.$proportionalEditing.value = v;
  }
  get proportionalSize() {
    return this.$proportionalSize.value;
  }
  set proportionalSize(v) {
    this.$proportionalSize.value = v;
  }
  get proportionalFalloff() {
    return this.$proportionalFalloff.value;
  }
  set proportionalFalloff(v) {
    this.$proportionalFalloff.value = v;
  }
  get autoKeying() {
    return this.$autoKeying.value;
  }
  set autoKeying(v) {
    this.$autoKeying.value = v;
  }
}

export type ShadingMode = 'WIREFRAME' | 'SOLID' | 'MATERIAL' | 'RENDERED';
export type ToolId = 'select' | 'cursor' | 'move' | 'rotate' | 'scale' | 'sculpt_draw' | 'sculpt_smooth' | 'sculpt_grab' | 'sculpt_inflate' | 'sculpt_flatten' | 'paint';

/** Per-session viewport/UI state (local only). */
export class ViewState {
  readonly shading = signal<ShadingMode>('SOLID');
  readonly xray = signal(false);
  readonly overlays = signal(true);
  readonly showGrid = signal(true);
  readonly showWireframe = signal(false);
  readonly showStats = signal(true);
  readonly tool = signal<ToolId>('select');
  readonly sidebar = signal(false);
  readonly toolbar = signal(true);
  readonly playing = signal(false);
  readonly snapping = signal(false);
  readonly snapIncrement = signal(1);
  /** Viewing through the scene camera (Numpad 0). */
  readonly cameraView = signal(false);
  readonly ortho = signal(false);
  /** Id of the awareness client whose view we follow, or null. */
  readonly following = signal<number | null>(null);
  readonly brush = signal({ radius: 50, strength: 0.5, color: [1, 0.2, 0.2, 1] as [number, number, number, number], symmetryX: false });
  /** Status text shown in the viewport header during modal operations. */
  readonly hud = signal<string | null>(null);
  readonly viewLabel = signal('User Perspective');
}

export function sig<T>(s: Signal<T>): T {
  return s.value;
}
