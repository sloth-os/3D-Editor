import type { Vec3 } from '../math/types';
import type { SceneDoc } from '../doc/scene-doc';
import type { MeshSelection, SelectMode } from '../mesh/selection';
import { emptySelection } from '../mesh/selection';

export type EditorMode = 'OBJECT' | 'EDIT' | 'SCULPT' | 'VERTEX_PAINT';
export type PivotPoint =
  'MEDIAN_POINT' | 'BOUNDING_BOX_CENTER' | 'CURSOR' | 'INDIVIDUAL_ORIGINS' | 'ACTIVE_ELEMENT';
export type TransformOrientation = 'GLOBAL' | 'LOCAL' | 'NORMAL' | 'VIEW';

/**
 * Per-user editor state (never stored in the shared document). The web UI implements this
 * interface with reactive signals; the server keeps one plain object per MCP session.
 *
 * IMPORTANT: treat values as immutable — always assign new arrays/sets/objects instead of
 * mutating them in place, so reactive implementations notice the change.
 */
export interface EditorState {
  mode: EditorMode;
  /** Selected object ids (object mode selection). */
  selectedIds: string[];
  /** Active object id (last selected / the one being edited). */
  activeId: string | null;
  /** Current frame. */
  frame: number;
  cursorLocation: Vec3;
  cursorRotation: Vec3;
  /** Mesh select mode in edit mode. */
  selectMode: SelectMode;
  /** Edit-mode selection of the active object's mesh. */
  meshSelection: MeshSelection;
  pivotPoint: PivotPoint;
  transformOrientation: TransformOrientation;
  /** Proportional editing (edit mode). */
  proportionalEditing: boolean;
  proportionalSize: number;
  proportionalFalloff: 'SMOOTH' | 'SPHERE' | 'ROOT' | 'SHARP' | 'LINEAR' | 'CONSTANT';
  /** Auto keying: transforms insert keyframes automatically. */
  autoKeying: boolean;
}

export function createEditorState(init: Partial<EditorState> = {}): EditorState {
  return {
    mode: 'OBJECT',
    selectedIds: [],
    activeId: null,
    frame: 1,
    cursorLocation: [0, 0, 0],
    cursorRotation: [0, 0, 0],
    selectMode: 'VERT',
    meshSelection: emptySelection(),
    pivotPoint: 'MEDIAN_POINT',
    transformOrientation: 'GLOBAL',
    proportionalEditing: false,
    proportionalSize: 1,
    proportionalFalloff: 'SMOOTH',
    autoKeying: false,
    ...init,
  };
}

export type ReportLevel = 'INFO' | 'WARNING' | 'ERROR';

/** Where an operator invocation came from (recorded in telemetry and the info log). */
export type OperatorSource =
  'ui' | 'menu' | 'hotkey' | 'toolbar' | 'palette' | 'redo' | 'console' | 'mcp' | 'api' | 'test';

export interface OperatorContext {
  doc: SceneDoc;
  state: EditorState;
  /** Transaction origin used for document changes (tracked by the caller's undo manager). */
  origin: unknown;
  source: OperatorSource;
  report(level: ReportLevel, message: string): void;
  /** Optional UI services (only present in the browser). */
  ui?: unknown;
}

export class OperatorError extends Error {
  constructor(
    message: string,
    readonly code: 'POLL_FAILED' | 'INVALID_PARAMS' | 'NOT_FOUND' | 'FAILED' = 'FAILED',
  ) {
    super(message);
    this.name = 'OperatorError';
  }
}
