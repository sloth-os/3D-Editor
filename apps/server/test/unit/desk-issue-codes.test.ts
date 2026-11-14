import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DESK_ISSUE_CODES,
  DESK_ISSUE_SEVERITY,
  createOperatorRegistry,
  type DeskIssueCode,
  type DeskIssueSeverity,
} from '@3d-editor/core';
import { DESK_CHECK_ERRORS, MCP_INSTRUCTIONS } from '../../src/mcp/instructions';

/*
 * desk.check's issue codes where the server's texts name them: the errors the MCP instructions tell
 * agents to fix are core's (DESK_ISSUE_SEVERITY), as are the lists of docs/mcp.md,
 * docs/rideo.md and docs/agent-guide.md, and the kite and water codes are among them with the
 * severity core gives them. docs/video-export.md's troubleshooting names those codes and the
 * severity of subject_revealed. Every code of core, under the severity core gives it: in the
 * desk.check operator's description, in docs/director-desk.md's table of checks, and in words in
 * docs/features.md's Continuity checks row.
 */

/** A doc without its fenced code blocks. */
function doc(name: string): string {
  const text = readFileSync(fileURLToPath(new URL(`../../../../docs/${name}`, import.meta.url)), 'utf8');
  let fence = false;
  return text
    .split('\n')
    .filter((line) => {
      if (/^\s*```/.test(line)) fence = !fence;
      return !fence && !/^\s*```/.test(line);
    })
    .join('\n');
}
/** Prose with its line breaks as spaces (the docs are wrapped at 100 columns). */
const flat = (s: string) => s.replace(/\s+/g, ' ');
/** The code spans of a text, in order. */
const spans = (s: string) => [...s.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
/** A text without its parenthesized asides (which may name other codes), innermost first. */
function withoutAsides(s: string): string {
  for (let prev = ''; prev !== s;) {
    prev = s;
    s = s.replace(/\([^()]*\)/g, '');
  }
  return s;
}
/** The cells of a Markdown table row. */
const cells = (line: string) =>
  line
    .split('|')
    .slice(1, -1)
    .map((c) => c.trim());
/** Expects the same codes, in any order and each once. */
const sameCodes = (actual: readonly string[], expected: readonly string[]) =>
  expect([...actual].sort()).toEqual([...expected].sort());

/** Core's codes of a severity, in core's order. */
const ofSeverity = (severity: DeskIssueSeverity) =>
  DESK_ISSUE_CODES.filter((code) => DESK_ISSUE_SEVERITY[code] === severity);
const errors = ofSeverity('error');

/**
 * How docs/features.md's Continuity checks row names each code, in core's order (a code core adds
 * needs its words here, and in the row).
 */
const FEATURE_WORDS: Readonly<Record<DeskIssueCode, string>> = {
  line_crossed: 'line crossed',
  subject_out_of_frame: 'subject out of frame',
  camera_inside: 'camera inside a set piece',
  missing_camera: 'missing camera',
  plan_mismatch: 'plan mismatch',
  screen_direction: 'screen direction',
  jump_cut: 'jump cut',
  absent_in_frame: 'absent in frame',
  subject_hidden: 'hidden subject',
  subject_revealed: 'subject revealed by a pan or tilt',
  occluded_subject: 'occluded subject',
  tether_detached: 'kite string left behind',
  walks_on_water: 'actor standing on water',
  body_in_water: 'body in water it does not float on',
  actors_overlap: 'actors overlapping',
  outside_set: 'outside the set',
  empty_shot: 'empty shot',
  duration_clamped: 'take length',
  physics_unbaked: 'unbaked physics',
  shot_gap: 'gaps',
};

describe("desk.check's issue codes in the server's texts", () => {
  it('are core codes; the kite and water ones with the severity the texts give them', () => {
    expect(DESK_ISSUE_SEVERITY).toMatchObject({
      tether_detached: 'error',
      walks_on_water: 'error',
      subject_revealed: 'warning',
      body_in_water: 'warning',
    });
    expect(errors).toEqual(expect.arrayContaining(['tether_detached', 'walks_on_water']));
  });

  it('the instructions tell agents to fix exactly the errors of core', () => {
    expect(DESK_CHECK_ERRORS).toEqual(errors);
    expect(MCP_INSTRUCTIONS).toContain(`desk.check (fix its errors: ${errors.join(', ')})`);
    // a warning is never given as an error to fix
    const listed = /desk\.check \(fix its errors: ([^)]*)\)/.exec(MCP_INSTRUCTIONS)![1].split(', ');
    for (const code of ['subject_revealed', 'body_in_water', 'plan_mismatch', 'physics_unbaked'])
      expect(listed).not.toContain(code);
  });

  it('the instructions say when to fly a kite, and what tether_detached reports', () => {
    expect(MCP_INSTRUCTIONS).toContain(
      "Fly kites with desk.tether_fly after the anchor actor's moves, poses and mounts (the string is tied where the hand is then): desk.check's tether_detached reports a string left behind, fly it again.",
    );
  });

  it('docs/mcp.md and docs/rideo.md list the errors of core', () => {
    const mcp = flat(doc('mcp.md'));
    const list = /The errors `desk\.check` reports are (.+?): fix them before exporting the shots\./.exec(
      mcp,
    );
    expect(list).not.toBeNull();
    expect(spans(list![1])).toEqual(errors);
    expect(/A kite is flown with .*?fly it again\./.exec(mcp)?.[0]).toBe(
      "A kite is flown with `desk.tether_fly` after its anchor actor's moves, poses and mounts, since its string starts where the hand is then; `tether_detached` reports a string left behind, so fly it again.",
    );
    const rideo = /Fix the check's errors \(([^)]+)\) and `plan_mismatch`/.exec(flat(doc('rideo.md')));
    expect(rideo).not.toBeNull();
    expect(spans(rideo![1])).toEqual(errors);
  });

  it("docs/agent-guide.md's director workflow lists the errors of core, and only warnings as warnings", () => {
    const check = /`desk\.check \{\}` returns the issues \(errors (.+?); warnings such as (.+?)\) and/.exec(
      flat(doc('agent-guide.md')),
    );
    expect(check).not.toBeNull();
    sameCodes(spans(check![1]), errors);
    const warnings = spans(check![2]);
    expect(warnings.length).toBeGreaterThan(0);
    for (const code of warnings) expect(DESK_ISSUE_SEVERITY[code as DeskIssueCode], code).toBe('warning');
  });

  it("the desk.check operator's description names every code of core under its severity", () => {
    const description = createOperatorRegistry().get('desk.check')!.description;
    // "…: line_crossed, …, walks_on_water (…) (errors); plan_mismatch, … (warnings); … (info). Returns…"
    const parts = description.split(/\((errors|warnings|info)\)/);
    const named: Record<string, string[]> = {};
    for (let i = 1; i < parts.length; i += 2)
      named[parts[i]] = [...withoutAsides(parts[i - 1]).matchAll(/\b[a-z]+(?:_[a-z]+)+\b/g)].map((m) => m[0]);
    expect(Object.keys(named)).toEqual(['errors', 'warnings', 'info']);
    sameCodes(named.errors, ofSeverity('error'));
    sameCodes(named.warnings, ofSeverity('warning'));
    sameCodes(named.info, ofSeverity('info'));
  });

  it("docs/director-desk.md's table of checks gives every code of core the severity core gives it", () => {
    const text = doc('director-desk.md');
    const start = text.indexOf('\n### Continuity checks\n');
    expect(start).toBeGreaterThanOrEqual(0);
    const lines = text.slice(start).split('\n');
    const head = lines.findIndex((line) => line.startsWith('|'));
    expect(cells(lines[head])).toEqual(['Severity', 'Codes']);
    const rows: Record<string, string[]> = {};
    for (const line of lines.slice(head + 2)) {
      if (!line.startsWith('|')) break;
      const [severity, codes] = cells(line);
      expect(rows[severity], severity).toBeUndefined();
      rows[severity] = spans(withoutAsides(codes));
    }
    expect(Object.keys(rows)).toEqual(['error', 'warning', 'info']);
    for (const severity of ['error', 'warning', 'info'] as const)
      sameCodes(rows[severity], ofSeverity(severity));
  });

  it("docs/features.md's Continuity checks row names every code of core", () => {
    expect(Object.keys(FEATURE_WORDS).sort()).toEqual([...DESK_ISSUE_CODES].sort());
    const row = doc('features.md')
      .split('\n')
      .find((line) => line.startsWith('| Continuity checks '));
    expect(row).toBeDefined();
    const list = /`desk\.check`: (.+?); rideo's blocking sentence per shot/.exec(cells(row!)[2]);
    expect(list).not.toBeNull();
    expect(list![1].split(', ')).toEqual(DESK_ISSUE_CODES.map((code) => FEATURE_WORDS[code]));
  });

  it("docs/video-export.md's troubleshooting names the kite and water issues as core reports them", () => {
    const rows = doc('video-export.md')
      .split('\n')
      .filter((line) => line.startsWith('| '));
    const row = (symptom: string) => rows.find((line) => line.startsWith(`| ${symptom} `)) ?? '';
    const framing = row('a subject out of frame in a clip');
    const kite = row("a kite's string runs from where the hand was");
    const water = row('an actor walks on water, or a body rolls on it');
    expect(spans(framing)).toEqual(expect.arrayContaining(['subject_out_of_frame', 'subject_revealed']));
    expect(framing).toContain(`\`subject_revealed\`, a ${DESK_ISSUE_SEVERITY.subject_revealed})`);
    expect(spans(kite)).toContain('tether_detached');
    expect(spans(water)).toEqual(expect.arrayContaining(['walks_on_water', 'body_in_water']));
    // every code the rows name is one desk.check reports
    for (const code of [framing, kite, water].flatMap(spans).filter((s) => /^[a-z]+(?:_[a-z]+)+$/.test(s)))
      expect(DESK_ISSUE_CODES, code).toContain(code);
  });
});
