/**
 * Blender-style unique naming: "Cube", "Cube.001", "Cube.002", ...
 * If `base` already carries a numeric suffix it is stripped before searching.
 */
export function uniqueName(base: string, existing: Iterable<string>): string {
  const taken = existing instanceof Set ? (existing as Set<string>) : new Set(existing);
  const clean = (base || 'Unnamed').trim() || 'Unnamed';
  if (!taken.has(clean)) return clean;
  const stem = clean.replace(/\.\d{3,}$/, '');
  for (let i = 1; i < 100000; i++) {
    const candidate = `${stem}.${String(i).padStart(3, '0')}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${stem}.${Date.now()}`;
}
