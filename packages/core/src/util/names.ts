/**
 * Blender-style unique naming: "Cube", "Cube.001", "Cube.002", ...
 * If `base` already carries a numeric suffix it is stripped before searching. `next` keeps the
 * suffix to try first for each stem, for callers that name many datablocks while none of their
 * names is freed: the lowest free suffix is then found without trying the taken ones again.
 */
export function uniqueName(base: string, existing: Iterable<string>, next?: Map<string, number>): string {
  const taken = existing instanceof Set ? (existing as Set<string>) : new Set(existing);
  const clean = (base || 'Unnamed').trim() || 'Unnamed';
  if (!taken.has(clean)) return clean;
  const stem = clean.replace(/\.\d{3,}$/, '');
  for (let i = next?.get(stem) ?? 1; i < 100000; i++) {
    const candidate = `${stem}.${String(i).padStart(3, '0')}`;
    if (!taken.has(candidate)) {
      next?.set(stem, i + 1);
      return candidate;
    }
  }
  return `${stem}.${Date.now()}`;
}
