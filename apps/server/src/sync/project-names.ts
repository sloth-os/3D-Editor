import type { RoomManager } from './room-manager';

/*
 * Project names are unique on a server, ignoring letter case. MCP tools and the REST API find
 * projects by id or by name (a case-insensitive match is tried when no exact one exists), so a
 * second project with the same name — or with one that differs only in case — would make every
 * by-name reference ambiguous ("Several projects are named …"). Every way the server creates or
 * renames a project (MCP create_project / rename_project, REST POST / PATCH /api/projects) checks
 * the name, and the check runs together with the change it guards, one at a time per server, so
 * two requests cannot take the same name at once.
 *
 * Browser editors create projects offline and upload them when they connect (a project is the
 * document the editor syncs), so those are not checked here.
 */

const locks = new WeakMap<RoomManager, Promise<void>>();

/**
 * Runs `fn` (a name check and the change it guards) after the earlier ones of this server (the
 * same RoomManager, whichever MCP session or HTTP request asks).
 */
export function withProjectNames<T>(rooms: RoomManager, fn: () => Promise<T>): Promise<T> {
  const run = (locks.get(rooms) ?? Promise.resolve()).then(fn);
  // the chain must not hold the result (a created room would stay reachable after its deletion)
  locks.set(
    rooms,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

/** The form two names are compared in: trimmed, Unicode-normalized, case-insensitive. */
export function projectNameKey(name: string): string {
  return name.trim().normalize('NFC').toLowerCase();
}

/** A project that already has a name another one asks for. */
export interface NameHolder {
  id: string;
  name: string;
}

/** A name another project already has (case-insensitively). */
export class ProjectNameTakenError extends Error {
  constructor(
    /** The name that was asked for. */
    readonly wanted: string,
    /** The projects that have it. */
    readonly holders: NameHolder[],
  ) {
    const names = holders.map((h) => `'${h.name}' (id ${h.id})`).join(', ');
    super(`The project name '${wanted}' is taken: ${names}`);
    this.name = 'ProjectNameTakenError';
  }

  /** Ids of the projects with the name. */
  get ids(): string[] {
    return this.holders.map((h) => h.id);
  }

  /** Whether the name only differs from the existing one in letter case (or surrounding spaces). */
  get differsInCase(): boolean {
    return this.holders.every((h) => h.name !== this.wanted.trim());
  }
}

/** The projects other than `self` whose name equals `name` ignoring case. */
export async function projectsNamed(rooms: RoomManager, name: string, self?: string): Promise<NameHolder[]> {
  const key = projectNameKey(name);
  return (await rooms.listProjects())
    .filter((p) => p.id !== self && projectNameKey(p.name) === key)
    .map((p) => ({ id: p.id, name: p.name }));
}

/**
 * Throws a {@link ProjectNameTakenError} when another project than `self` has `name` (ignoring
 * case). Call it inside {@link withProjectNames}, together with the change.
 */
export async function requireFreeProjectName(rooms: RoomManager, name: string, self?: string): Promise<void> {
  const holders = await projectsNamed(rooms, name, self);
  if (holders.length) throw new ProjectNameTakenError(name, holders);
}

/**
 * The first name of `base`, `base.001`, `base.002` … that no project has (Blender's naming), for
 * projects created without a name. Call it inside {@link withProjectNames}.
 */
export async function freeProjectName(rooms: RoomManager, base: string): Promise<string> {
  const taken = new Set((await rooms.listProjects()).map((p) => projectNameKey(p.name)));
  if (!taken.has(projectNameKey(base))) return base;
  for (let i = 1; ; i++) {
    const candidate = `${base}.${String(i).padStart(3, '0')}`;
    if (!taken.has(projectNameKey(candidate))) return candidate;
  }
}
