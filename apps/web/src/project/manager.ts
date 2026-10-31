import { SceneDoc, newUuid, type ProjectInfo } from '@3d-editor/core';
import { localIndex } from './local-index';
import { ProjectSession } from './session';
import { resolveWebDAV } from '../storage/webdav';
import { serverConfig, session, toast } from '../app/store';
import { apiUrl, authHeaders } from '../app/server-config';
import { telemetry } from '../telemetry/telemetry';

export type ProjectSource = 'local' | 'webdav' | 'server';

export interface ProjectListEntry extends ProjectInfo {
  sources: ProjectSource[];
  /** Devices/agents currently connected to the project on the server. */
  peers?: number;
  last_opened?: string;
}

interface ServerProject extends Partial<ProjectInfo> {
  id: string;
  name?: string;
  peers?: number;
}

async function serverProjects(): Promise<ServerProject[]> {
  if (!serverConfig.value) return [];
  try {
    const res = await fetch(apiUrl('/api/projects'), { headers: authHeaders(), cache: 'no-store' });
    if (!res.ok) return [];
    const json = (await res.json()) as { projects?: ServerProject[] } | ServerProject[];
    return Array.isArray(json) ? json : (json.projects ?? []);
  } catch {
    return [];
  }
}

/** Lists projects from every reachable source, merged by id. */
export async function listProjects(): Promise<{ projects: ProjectListEntry[]; errors: string[] }> {
  const errors: string[] = [];
  const target = resolveWebDAV();
  const [local, remote, server] = await Promise.all([
    localIndex.list().catch(() => []),
    target && navigator.onLine
      ? target.store.listProjects().catch((e: unknown) => {
          errors.push(`WebDAV: ${e instanceof Error ? e.message : String(e)}`);
          return [] as ProjectInfo[];
        })
      : Promise.resolve([] as ProjectInfo[]),
    serverProjects(),
  ]);
  const map = new Map<string, ProjectListEntry>();
  const merge = (p: Partial<ProjectListEntry> & { id: string }, source: ProjectSource) => {
    const cur = map.get(p.id);
    if (!cur) {
      map.set(p.id, {
        id: p.id,
        name: p.name ?? 'Untitled',
        created_at: p.created_at ?? '',
        updated_at: p.updated_at ?? '',
        schema_version: p.schema_version ?? 1,
        thumbnail: p.thumbnail,
        stats: p.stats,
        sources: [source],
        peers: p.peers,
        last_opened: p.last_opened,
      });
      return;
    }
    if (!cur.sources.includes(source)) cur.sources.push(source);
    if ((p.updated_at ?? '') > cur.updated_at) {
      cur.updated_at = p.updated_at!;
      if (p.name) cur.name = p.name;
      if (p.stats) cur.stats = p.stats;
    }
    cur.thumbnail ??= p.thumbnail;
    if (p.peers !== undefined) cur.peers = p.peers;
    cur.last_opened ??= p.last_opened;
  };
  for (const p of local) merge(p, 'local');
  for (const p of remote) merge(p, 'webdav');
  for (const p of server) merge(p, 'server');
  const projects = [...map.values()].sort((a, b) =>
    (b.last_opened ?? b.updated_at ?? '').localeCompare(a.last_opened ?? a.updated_at ?? ''),
  );
  return { projects, errors };
}

export async function openProject(id: string): Promise<ProjectSession> {
  const prev = session.value;
  if (prev?.id === id) return prev;
  session.value = null;
  prev?.close();
  const s = await ProjectSession.open(id);
  session.value = s;
  setProjectInUrl(id);
  return s;
}

export async function createProject(
  name = 'Untitled',
  opts: { empty?: boolean } = {},
): Promise<ProjectSession> {
  const id = newUuid();
  telemetry.count('editor.project.created', 1, { empty: !!opts.empty });
  const prev = session.value;
  session.value = null;
  prev?.close();
  const initial = SceneDoc.create({ name, empty: opts.empty, generator: `3d-editor-web ${__APP_VERSION__}` });
  const s = await ProjectSession.open(id, { initial });
  initial.destroy();
  session.value = s;
  setProjectInUrl(id);
  return s;
}

export async function deleteProject(entry: ProjectListEntry): Promise<void> {
  if (session.value?.id === entry.id) closeProject();
  await ProjectSession.deleteLocal(entry.id).catch(() => undefined);
  const target = resolveWebDAV();
  if (target && entry.sources.includes('webdav'))
    await target.store.deleteProject(entry.id).catch((e) => toast(`WebDAV delete failed: ${e}`, 'error'));
  if (serverConfig.value && entry.sources.includes('server'))
    await fetch(apiUrl(`/api/projects/${entry.id}`), { method: 'DELETE', headers: authHeaders() }).catch(
      () => undefined,
    );
  telemetry.count('editor.project.deleted');
}

export function closeProject(): void {
  const s = session.value;
  session.value = null;
  s?.close();
  setProjectInUrl(null);
}

function setProjectInUrl(id: string | null): void {
  const url = new URL(location.href);
  if (id) url.searchParams.set('project', id);
  else url.searchParams.delete('project');
  history.replaceState(null, '', url);
}

export function projectFromUrl(): string | null {
  return new URL(location.href).searchParams.get('project');
}

/** Shareable link that opens the same project on another device. */
export function shareLink(id: string): string {
  const url = new URL(location.origin + location.pathname);
  url.searchParams.set('project', id);
  return url.toString();
}
