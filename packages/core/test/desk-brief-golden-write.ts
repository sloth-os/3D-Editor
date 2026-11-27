import { writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import {
  DESK_EMBED_FIXTURES,
  GOLDEN_FILE,
  goldenBriefs,
  stageGolden,
  type GoldenFile,
} from './desk-brief-golden-helpers';

/*
 * Writes fixtures/desk-embed/staged-golden.json (desk-brief-golden-helpers.ts): stages every golden
 * brief twice, checks the two fingerprints agree (staging is deterministic apart from its ids), and
 * writes them. Run it only on a commit whose staging is the reference (it was written before library
 * units changed staging), from packages/core:
 *   node --import tsx test/desk-brief-golden-write.ts
 * (GOLDEN_COMMIT names the commit when the tree is not a git checkout), then format the file
 * (npx prettier --write test/fixtures/desk-embed/staged-golden.json).
 */

let commit = process.env.GOLDEN_COMMIT ?? 'unknown';
if (!process.env.GOLDEN_COMMIT)
  try {
    commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {}

const briefs: GoldenFile['briefs'] = {};
for (const [name, brief] of Object.entries(goldenBriefs())) {
  const t0 = performance.now();
  const a = stageGolden(brief);
  const ms = performance.now() - t0;
  const b = stageGolden(brief);
  if (!isDeepStrictEqual(a, b))
    throw new Error(`${name}: two stagings differ; the fingerprint is not deterministic`);
  briefs[name] = a;
  console.log(`${name}: staged in ${ms.toFixed(0)} ms, ${Object.keys(a.fingerprint.objects).length} objects`);
}
const golden: GoldenFile = {
  about: `Briefs staged as the desk staged them at ${commit}, before library units (desk-brief-golden-write.ts).`,
  briefs,
};
writeFileSync(new URL(GOLDEN_FILE, DESK_EMBED_FIXTURES), `${JSON.stringify(golden, null, 2)}\n`);
console.log(`wrote ${GOLDEN_FILE}`);
