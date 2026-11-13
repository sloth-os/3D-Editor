import { ToolError } from '../mcp/agent';
import type { ServiceContext } from '../services';
import type { PassName } from '../render/protocol';
import type { VideoExportParams } from './params';

/*
 * Video export jobs (SPEC §9): background jobs that render the shots of a snapshot of a project in
 * the render processes and encode them with ffmpeg (start → poll). This is the FOUNDATION stub:
 * the public names are fixed, every operation answers UNAVAILABLE until the video export lands.
 */

export type { VideoExportParams } from './params';

export type ExportStatus = 'queued' | 'running' | 'encoding' | 'done' | 'failed' | 'cancelled';

export type ExportFileKind = 'sequence' | 'clip' | 'poster' | 'manifest' | 'contact_sheet' | 'pass';

/** A file an export wrote (job.json `files`). */
export interface ExportFile {
  name: string;
  kind: ExportFileKind;
  pass?: PassName;
  /** Shot id (clips, posters). */
  shot?: string;
  /** The shot's id in rideo (imported shots). */
  external_shot?: string;
  bytes: number;
  frames?: number;
  duration_s?: number;
  /** Download path (GET /api/projects/:id/video-exports/:export/files/<name>; links carry no token). */
  url: string;
  sha256: string;
}

export interface ExportProgress {
  frames_done: number;
  frames_total: number;
  /** 0–1. */
  fraction: number;
  /** Frames rendered per second (0 before the first frame). */
  fps: number;
  /** Seconds left (null while unknown). */
  eta_s: number | null;
  /** The shot being rendered (id), or null. */
  shot: string | null;
}

/** Results of pushing an export's clips to rideo (rideo_push). */
export interface ExportPush {
  status: 'running' | 'done' | 'failed';
  shots: { rideo_shot: string; resource: string | null; error: string | null }[];
}

/** An export job (persisted as `<EXPORT_DIR>/<project>/<job>/job.json`). */
export interface ExportJob {
  id: string;
  /** Project id. */
  project: string;
  label: string | null;
  status: ExportStatus;
  params: VideoExportParams;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  progress: ExportProgress;
  error: string | null;
  warnings: string[];
  files: ExportFile[];
  push?: ExportPush;
}

/** A file of an export on disk (served with Range and ETag by the REST route). */
export interface ExportFileRef {
  path: string;
  bytes: number;
  contentType: string;
  etag: string;
}

/** Options of {@link VideoExports.status}. */
export interface ExportStatusOptions {
  /** The project the export must belong to (REST: the route's project). */
  project?: string;
  /** Wait up to this many seconds (0–50) for the job to finish or change (long poll). */
  waitS?: number;
  /** Stops waiting (the request ended); never cancels the job. */
  signal?: AbortSignal;
}

/** Options of {@link VideoExports.cancel}. */
export interface ExportCancelOptions {
  project?: string;
  /** Also delete the files written so far (and the job). */
  deleteFiles?: boolean;
}

function unavailable(): ToolError {
  return new ToolError('Video export is not available yet on this server.', 'UNAVAILABLE');
}

/** The video export jobs of the server (FIFO, one renders at a time). */
export class VideoExports {
  constructor(protected readonly ctx: ServiceContext) {}

  /**
   * Queues an export of project `project` (id or name) and returns its job (status `queued`).
   * Refuses with FFMPEG_UNAVAILABLE without ffmpeg, UNAVAILABLE in main-thread render mode,
   * QUEUE_FULL when EXPORT_MAX_QUEUED jobs wait.
   */
  async start(_project: string, _params: VideoExportParams): Promise<ExportJob> {
    throw unavailable();
  }

  /** The job `exportId` (NOT_FOUND when unknown), after waiting up to `waitS` for a change. */
  async status(_exportId: string, _opts: ExportStatusOptions = {}): Promise<ExportJob> {
    throw unavailable();
  }

  /** Cancels a queued or running job (a finished one stays); returns the job. */
  async cancel(_exportId: string, _opts: ExportCancelOptions = {}): Promise<ExportJob> {
    throw unavailable();
  }

  /** The jobs of a project (id), newest first, or of every project. */
  async list(_project?: string): Promise<ExportJob[]> {
    throw unavailable();
  }

  /** A file of an export (NOT_FOUND when the job or file is unknown). */
  async file(_exportId: string, _name: string, _opts: { project?: string } = {}): Promise<ExportFileRef> {
    throw unavailable();
  }

  /** Cancels running jobs and stops ffmpeg (server shutdown). */
  async close(): Promise<void> {}
}
