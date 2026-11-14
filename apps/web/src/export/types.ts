/*
 * The public types of the browser video export (index.ts exports them): what an export is asked
 * for, its progress and its files.
 */

export interface BrowserExportRequest {
  /** Y.encodeStateAsUpdate of the project document, taken when the export starts (its snapshot). */
  update: Uint8Array;
  /** The export's parameters, validated with core's schema (videoExportParamsSchema). */
  params: unknown;
  /** Also a PNG of each shot's first frame in the export's look (its beauty image), kind 'still'. */
  stills?: boolean;
  /** The project the manifest names (default: no id, the snapshot's project name). */
  project?: { id: string; name?: string };
}

export type BrowserExportFileKind =
  'sequence' | 'clip' | 'poster' | 'still' | 'contact_sheet' | 'manifest' | 'frames';

export interface BrowserExportFile {
  name: string;
  kind: BrowserExportFileKind;
  /** The pass of a video or frame archive (beauty, depth …), else null. */
  pass: string | null;
  /** The planned shot of a shot's file (a desk shot id; 'range' for a frame range export), else null. */
  shot: string | null;
  mime: string;
  size: number;
  /** SHA-256 of the file (hex), computed while it was written. */
  sha256: string;
  frames: number | null;
  duration_s: number | null;
  blob(): Promise<Blob>;
}

export interface BrowserExportResult {
  id: string;
  files: BrowserExportFile[];
  /** The manifest (as manifest.json holds it). */
  manifest: unknown;
  /** The planned shots in export order: id, file name base, output frames. */
  shots: { id: string; slug: string; frames: number }[];
  /** The export's warnings (as the manifest lists them). */
  warnings: string[];
}

export interface BrowserExportProgress {
  phase: 'prepare' | 'render' | 'encode' | 'finish';
  done: number;
  total: number;
  /** The planned shot being rendered (render phase). */
  shot?: string;
}

export interface BrowserExportHooks {
  onProgress?: (p: BrowserExportProgress) => void;
  /** Cancels the export: its workers stop, its encoders close and its partial files are deleted. */
  signal?: AbortSignal;
}
