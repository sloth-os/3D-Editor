import { useEffect, useRef, useState } from 'preact/hooks';
import { infoLog, logInfo } from '../editor/runner';
import { registry, run } from '../editor/editor';
import { session } from '../app/store';
import * as core from '@3d-editor/core';
import { telemetry } from '../telemetry/telemetry';
import { fps, frameTimeMs } from '../telemetry/perf';

export function InfoLog() {
  const lines = infoLog.value;
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.scrollTo(0, ref.current.scrollHeight);
  }, [lines.length]);
  return (
    <div class="area-body log" ref={ref} data-testid="info-log">
      {lines.map((l) => (
        <div key={l.id} class={`line ${l.level}`}>
          <span class="src">{new Date(l.at).toLocaleTimeString()} </span>
          {l.message}
          {l.source && <span class="src"> · {l.source}</span>}
        </div>
      ))}
      {lines.length === 0 && <div class="hint">Operator reports appear here.</div>}
    </div>
  );
}

/**
 * JavaScript console with the editor API in scope (like Blender's Python console):
 *   ops('mesh.primitive_cube_add', { size: 1 })   doc.listObjects()   state.selectedIds   core.*
 */
export function Console() {
  const [history, setHistory] = useState<string[]>([]);
  const [hIndex, setHIndex] = useState(-1);
  const [input, setInput] = useState('');
  const lines = infoLog.value.filter((l) => l.source === 'console');
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => ref.current?.scrollTo(0, ref.current.scrollHeight), [lines.length]);
  const exec = () => {
    const code = input.trim();
    if (!code) return;
    setHistory([...history, code]);
    setHIndex(-1);
    setInput('');
    logInfo('INFO', `>>> ${code}`, 'console');
    const s = session.value;
    const scope = {
      doc: s?.doc,
      state: s?.state,
      session: s,
      core,
      registry,
      ops: (id: string, params?: unknown) => {
        const ok = run(id, params, 'console');
        return ok;
      },
      help: () =>
        'ops(id, params) runs an operator · registry.describe() lists operators · doc / state / core are available',
    };
    const span = telemetry.startSpan('console.exec');
    try {
      const fn = new Function(...Object.keys(scope), `"use strict"; return (async () => { return (${code}); })();`);
      Promise.resolve(fn(...Object.values(scope)))
        .then((r: unknown) => {
          if (r !== undefined) logInfo('INFO', typeof r === 'string' ? r : safeStringify(r), 'console');
          span.setOk().end();
        })
        .catch((err: unknown) => {
          logInfo('ERROR', String(err), 'console');
          span.setError(String(err)).end();
        });
    } catch (err) {
      logInfo('ERROR', String(err), 'console');
      span.setError(String(err)).end();
    }
  };
  return (
    <div class="column" style={{ height: '100%' }}>
      <div class="area-body log" ref={ref}>
        <div class="hint">JavaScript console — type help() · e.g. ops('mesh.primitive_torus_add', {'{'} major_radius: 2 {'}'})</div>
        {lines.map((l) => (
          <div key={l.id} class={`line ${l.level}`}>
            {l.message}
          </div>
        ))}
      </div>
      <div class="console-input">
        <input
          value={input}
          placeholder=">>> "
          data-testid="console-input"
          onInput={(e) => setInput((e.target as HTMLInputElement).value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') exec();
            if (e.key === 'ArrowUp' && history.length) {
              const i = hIndex < 0 ? history.length - 1 : Math.max(0, hIndex - 1);
              setHIndex(i);
              setInput(history[i]);
            }
            if (e.key === 'ArrowDown' && hIndex >= 0) {
              const i = hIndex + 1;
              if (i >= history.length) {
                setHIndex(-1);
                setInput('');
              } else {
                setHIndex(i);
                setInput(history[i]);
              }
            }
          }}
        />
      </div>
    </div>
  );
}

function safeStringify(v: unknown): string {
  try {
    const s = JSON.stringify(v, (_k, x) => (x instanceof Set ? [...x] : x instanceof Map ? Object.fromEntries(x) : x), 2);
    return s && s.length > 4000 ? `${s.slice(0, 4000)}…` : (s ?? String(v));
  } catch {
    return String(v);
  }
}

/** Live diagnostics: frame rate, recent telemetry spans, sync and storage status. */
export function Diagnostics() {
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const s = session.value;
  const recent = telemetry.recent.slice(-40).reverse();
  return (
    <div class="area-body log">
      <div>
        FPS {fps.value} · frame {frameTimeMs.value.toFixed(1)} ms · telemetry {telemetry.enabled ? 'on' : 'off'} · session {telemetry.sessionId}
      </div>
      {s && (
        <div>
          sync {s.provider?.status.value} · peers {s.peers.value.length} · latency {s.provider?.latencyMs.value ?? '–'} ms · storage{' '}
          {s.webdav ? `${s.webdav.status.value}${s.webdav.error.value ? ` (${s.webdav.error.value})` : ''}` : 'browser'}
        </div>
      )}
      <div class="hint" style={{ marginTop: '6px' }}>
        Recent spans
      </div>
      {recent.map((r, i) => (
        <div key={i} class={`line ${r.ok ? '' : 'ERROR'}`}>
          {new Date(r.at).toLocaleTimeString()} {r.name} — {r.durationMs.toFixed(1)} ms
        </div>
      ))}
    </div>
  );
}
