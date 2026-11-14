import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/*
 * SceneSettings.shots and SceneSettings.desk are read and written only through desk/shots.ts
 * (getShots, setShots, getDeskSettings, setDeskSettings): its reads sanitize what other clients
 * stored and are cached, and getScene() deep-copies every scene setting (spec §2). This scan fails
 * when another source file of the core or the apps reads them off getScene().
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const allowed = path.join(root, 'packages/core/src/desk/shots.ts');

/** TypeScript sources under `dir` (no node_modules, no build output). */
function sources(dir: string, out: string[] = []): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue;
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) sources(p, out);
    else if (/\.(ts|tsx|mts|cts)$/.test(name) && !name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

const FORBIDDEN: { what: string; re: RegExp }[] = [
  { what: 'getScene().shots / getScene().desk', re: /getScene\(\s*\)\s*\??\.\s*(shots|desk)\b/ },
  { what: "getScene()['shots'] / ['desk']", re: /getScene\(\s*\)\s*\??\.?\[\s*['"`](shots|desk)['"`]\s*\]/ },
  {
    what: 'a destructuring of shots or desk from getScene()',
    re: /\{[^{}]*\b(shots|desk)\b[^{}]*\}\s*=\s*[\w.$?]*getScene\(\s*\)/,
  },
];

describe('shots and desk settings', () => {
  it('are read off getScene() nowhere but desk/shots.ts', () => {
    const files = [
      ...sources(path.join(root, 'packages/core/src')),
      ...readdirSync(path.join(root, 'apps')).flatMap((app) => sources(path.join(root, 'apps', app, 'src'))),
    ];
    expect(files.length).toBeGreaterThan(100);
    expect(files).toContain(allowed);
    const found: string[] = [];
    for (const file of files) {
      if (file === allowed) continue;
      const text = readFileSync(file, 'utf8');
      for (const { what, re } of FORBIDDEN) {
        const m = re.exec(text);
        if (m) {
          const line = text.slice(0, m.index).split('\n').length;
          found.push(`${path.relative(root, file)}:${line}: ${what}`);
        }
      }
    }
    expect(found).toEqual([]);
  });

  it('are caught by the scan in every form it forbids', () => {
    const hits = (text: string) => FORBIDDEN.filter(({ re }) => re.test(text)).length;
    expect(hits('const s = doc.getScene().shots;')).toBe(1);
    expect(hits('ctx.doc.getScene().desk.aspect')).toBe(1);
    expect(hits("doc.getScene()['shots']")).toBe(1);
    expect(hits('const { fps, shots } = doc.getScene();')).toBe(1);
    expect(hits('const { desk } = ctx.doc.getScene()')).toBe(1);
    expect(hits('const { fps, frame_start } = doc.getScene();')).toBe(0);
    expect(hits('const shots = getShots(doc);')).toBe(0);
  });
});
