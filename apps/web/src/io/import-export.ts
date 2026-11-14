import { base64Encode, detectFormat, exportScene, type ExportFormat } from '@3d-editor/core';
import { session, toast } from '../app/store';
import { runResult } from '../editor/editor';
import { pageGuard } from '../editor/page-guard';
import { telemetry } from '../telemetry/telemetry';

/** Lets the user pick model files and imports them through the import operators (undoable). */
export async function importFromFilePicker(): Promise<void> {
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  input.accept = '.glb,.gltf,.obj,.stl,.ply';
  input.onchange = () => {
    void importFiles([...(input.files ?? [])]);
  };
  input.click();
}

const IMPORT_OPS: Record<string, string> = {
  glb: 'import_scene.gltf',
  gltf: 'import_scene.gltf',
  obj: 'import_scene.obj',
  stl: 'import_mesh.stl',
  ply: 'import_mesh.ply',
};

/**
 * Imports model files (a drop on the viewport, the file picker, files opened through the OS) through
 * the import operators only: what refuses them (their Object Mode check, a page that refuses every
 * change to the scene, such as the read-only embeddable desk) refuses the import, and says why.
 * Nothing writes the document past the operator. A file the page refuses is not even read.
 */
export async function importFiles(files: File[]): Promise<void> {
  if (!session.value) return;
  // what the page refuses, said once for all the files it refuses it for
  const told = new Set<string>();
  for (const file of files) {
    const fmt = detectFormat(file.name);
    if (!fmt) {
      toast(`Unsupported file type: ${file.name}`, 'error');
      continue;
    }
    const op = IMPORT_OPS[fmt];
    const span = telemetry.startSpan(`import ${fmt}`, { 'file.format': fmt, 'file.size': file.size });
    try {
      const refused = pageGuard.refusal(op);
      if (refused !== null) {
        if (!told.has(refused)) toast(refused, 'error');
        told.add(refused);
        span.setError(refused);
        continue;
      }
      const bytes = new Uint8Array(await file.arrayBuffer());
      const name = file.name.replace(/\.[^.]+$/, '');
      const res = runResult(op, { data_base64: base64Encode(bytes), name }, 'ui');
      if (!res?.ok) {
        span.setError(res?.error ?? 'no project open');
        continue;
      }
      toast(`Imported ${file.name}`);
      span.setOk();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast(`Import failed: ${msg}`, 'error');
      span.setError(msg);
    } finally {
      span.end();
    }
  }
}

export function downloadBytes(bytes: Uint8Array, filename: string, mime: string): void {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function exportAndDownload(
  format: ExportFormat,
  opts: { selectedOnly: boolean; applyModifiers: boolean },
): void {
  const s = session.value;
  if (!s) return;
  const span = telemetry.startSpan(`export ${format}`, { 'file.format': format });
  try {
    const res = exportScene(s.doc, format, {
      objectIds: opts.selectedOnly ? s.state.selectedIds : undefined,
      applyModifiers: opts.applyModifiers,
      frame: s.state.frame,
    });
    const base = (s.doc.name || 'scene').replace(/[^\w.-]+/g, '_');
    downloadBytes(res.data, `${base}.${res.extension}`, res.mime);
    span.setAttribute('file.size', res.data.length).setOk();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    toast(`Export failed: ${msg}`, 'error');
    span.setError(msg);
  } finally {
    span.end();
  }
}
