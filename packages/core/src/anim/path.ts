/*
 * Blender-style data paths for animation, drivers and generic property access:
 *
 *   location                              → obj.location
 *   pose.bones["Arm.L"].rotation_euler    → obj.pose.bones["Arm.L"].rotation_euler
 *   constraints["Track To"].influence     → element of obj.constraints whose name is "Track To"
 *   modifiers["Wave"].height              → modifier "Wave", parameter `height` (stored in .params)
 *   shape_keys["Smile"].value             → mesh shape key "Smile"
 *   textures.base_color.procedural.scale  → nested plain objects
 *
 * Array elements can be addressed by name (`["name"]`, matching the element's `name`) or by
 * index (`[2]`). When a property is not found on an element but exists in its `params` or
 * `settings` bag (modifiers, constraints, particle systems), the bag is used transparently.
 */

export type PathSegment =
  { kind: 'prop'; name: string } | { kind: 'key'; key: string } | { kind: 'index'; index: number };

const cache = new Map<string, PathSegment[]>();

export class DataPathError extends Error {}

export function parseDataPath(path: string): PathSegment[] {
  const hit = cache.get(path);
  if (hit) return hit;
  const out: PathSegment[] = [];
  let i = 0;
  const n = path.length;
  while (i < n) {
    const c = path[i];
    if (c === '.') {
      i++;
      continue;
    }
    if (c === '[') {
      i++;
      if (path[i] === '"' || path[i] === "'") {
        const q = path[i++];
        let key = '';
        while (i < n && path[i] !== q) {
          if (path[i] === '\\' && i + 1 < n) i++;
          key += path[i++];
        }
        if (path[i] !== q) throw new DataPathError(`unterminated string in data path '${path}'`);
        i++;
        out.push({ kind: 'key', key });
      } else {
        let num = '';
        while (i < n && /[0-9-]/.test(path[i])) num += path[i++];
        if (!num) throw new DataPathError(`expected index or quoted key in data path '${path}'`);
        out.push({ kind: 'index', index: Number(num) });
      }
      if (path[i] !== ']') throw new DataPathError(`expected ']' in data path '${path}'`);
      i++;
      continue;
    }
    let name = '';
    while (i < n && /[A-Za-z0-9_]/.test(path[i])) name += path[i++];
    if (!name) throw new DataPathError(`unexpected '${c}' in data path '${path}'`);
    out.push({ kind: 'prop', name });
  }
  if (out.length === 0) throw new DataPathError('empty data path');
  if (cache.size > 2000) cache.clear();
  cache.set(path, out);
  return out;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Uint8Array);
}

const BAGS = ['params', 'settings'] as const;

/** Resolves one segment on a container; returns [value, accessor key info] or undefined. */
function step(
  container: unknown,
  seg: PathSegment,
): { value: unknown; via?: string; key: string | number } | undefined {
  if (seg.kind === 'index') {
    if (!Array.isArray(container)) return undefined;
    return { value: container[seg.index], key: seg.index };
  }
  if (seg.kind === 'key') {
    if (Array.isArray(container)) {
      const i = container.findIndex((e) => isRecord(e) && e.name === seg.key);
      return i < 0 ? undefined : { value: container[i], key: i };
    }
    if (isRecord(container))
      return seg.key in container ? { value: container[seg.key], key: seg.key } : undefined;
    return undefined;
  }
  if (!isRecord(container)) return undefined;
  if (seg.name in container) return { value: container[seg.name], key: seg.name };
  for (const bag of BAGS) {
    const b = container[bag];
    if (isRecord(b) && seg.name in b) return { value: b[seg.name], via: bag, key: seg.name };
  }
  return undefined;
}

/** Reads the value at a data path (undefined when the path does not resolve). */
export function getPathValue(root: unknown, path: string): unknown {
  let cur: unknown = root;
  for (const seg of parseDataPath(path)) {
    const r = step(cur, seg);
    if (!r) return undefined;
    cur = r.value;
  }
  return cur;
}

/**
 * Returns a copy of `root` with the value at `path` replaced (copy-on-write along the path; the
 * input is not mutated). Throws DataPathError when the path does not resolve (no implicit
 * creation, except plain-object keys at the last segment).
 */
export function setPathValue<T>(root: T, path: string, value: unknown): T {
  const segs = parseDataPath(path);
  const rec = (container: unknown, i: number): unknown => {
    const seg = segs[i];
    const last = i === segs.length - 1;
    const r = step(container, seg);
    if (!r) {
      if (last && seg.kind !== 'index' && isRecord(container)) {
        const name = seg.kind === 'prop' ? seg.name : seg.key;
        return { ...container, [name]: value };
      }
      throw new DataPathError(`data path '${path}' does not resolve`);
    }
    const next = last ? value : rec(r.value, i + 1);
    if (Array.isArray(container)) {
      const copy = container.slice();
      copy[r.key as number] = next;
      return copy;
    }
    const obj = container as Record<string, unknown>;
    if (r.via) return { ...obj, [r.via]: { ...(obj[r.via] as Record<string, unknown>), [r.key]: next } };
    return { ...obj, [r.key]: next };
  };
  return rec(root, 0) as T;
}

/** First property name of a path (the top-level field it lives in). */
export function pathRoot(path: string): string {
  const s = parseDataPath(path)[0];
  return s.kind === 'prop' ? s.name : s.kind === 'key' ? s.key : String(s.index);
}
