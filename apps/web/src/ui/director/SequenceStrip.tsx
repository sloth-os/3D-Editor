import { useMemo, useRef } from 'preact/hooks';
import { getShots } from '@3d-editor/core';
import type { ProjectSession } from '../../project/session';
import { shotPin } from '../../viewport/follow-shots';
import { Icon } from '../icons';
import { selectedShot } from './state';
import {
  blockAt,
  sequenceBlocks,
  sequenceFrameAtX,
  sequenceFrameOf,
  sequenceTotal,
  timecode,
  xOfSequenceFrame,
} from './sequence';
import { sequencePlaying, showSequenceFrame, stopSequence, toggleSequence } from './playback';
import './director.css';

/*
 * The sequence strip (bottom tab "Sequence"): the cut as blocks proportional to the shots' lengths,
 * in cut order, with a playhead in sequence frames. Clicking or dragging scrubs: the scene frame and
 * the viewport's camera follow the shot under the pointer (Follow Shots, camera view). Play runs the
 * cut in real time through the shot cameras. Keys on the strip (its track and its buttons): ←/→ a
 * frame, Shift+←/→ a shot, Home/End, Space plays or stops; the editor's own keys for them (frame
 * steps, the timeline's playback) never see these.
 */

/** The strip's keys (without Ctrl, Alt or Meta), by KeyboardEvent.key. */
const STRIP_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'Home', 'End', ' ']);
export function SequenceStrip({ s }: { s: ProjectSession }) {
  const revision = s.revision.value;
  const frame = s.state.$frame.value;
  const pin = shotPin(s.view).value;
  const playing = sequencePlaying.value;
  const selected = selectedShot.value;
  const blocks = useMemo(() => sequenceBlocks(getShots(s.doc)), [s, revision]);
  const total = sequenceTotal(blocks);
  const fps = Math.max(1, s.doc.getScene().fps || 24);
  const current = sequenceFrameOf(blocks, frame, pin);
  const block = current === null ? null : blockAt(blocks, current);
  const track = useRef<HTMLDivElement>(null);
  const disabled = getShots(s.doc).length - blocks.length;

  /** Shows sequence frame k (selecting its shot) and stops the playback. */
  const show = (k: number) => {
    stopSequence();
    if (!total) return;
    const clamped = Math.max(0, Math.min(total - 1, k));
    showSequenceFrame(s, clamped);
    const b = blockAt(blocks, clamped);
    if (b) selectedShot.value = b.shot.id;
  };
  const scrub = (e: PointerEvent) => {
    const el = track.current;
    if (!el || !total) return;
    const r = el.getBoundingClientRect();
    show(sequenceFrameAtX(e.clientX - r.left, r.width, total));
  };
  const step = (delta: number) => show((current ?? -1) + delta);
  const jumpShot = (dir: 1 | -1) => {
    const i = block ? blocks.indexOf(block) : dir > 0 ? -1 : blocks.length;
    const next = blocks[i + dir];
    if (next) show(next.start);
  };
  const shotLabel = block
    ? `${blocks.indexOf(block) + 1}/${blocks.length} ${block.shot.name}`
    : total
      ? 'Frame outside the cut'
      : 'No shots';
  /**
   * The strip's keys, wherever the focus is in it: on the track, and on its buttons (a click leaves
   * the focus on Play, so Space must stop the cut rather than reach the editor's Space, which plays
   * the timeline in scene order; the default action, the button's own click, is cancelled).
   */
  const onKeyDown = (e: KeyboardEvent) => {
    if (!STRIP_KEYS.has(e.key) || e.ctrlKey || e.altKey || e.metaKey) return;
    e.preventDefault();
    e.stopPropagation();
    // a held Space would play and stop over and over; a held arrow steps on
    if (e.key === ' ' && e.repeat) return;
    if (e.key === ' ') toggleSequence(s);
    else if (e.key === 'Home') show(0);
    else if (e.key === 'End') show(total - 1);
    else if (e.shiftKey) jumpShot(e.key === 'ArrowLeft' ? -1 : 1);
    else step(e.key === 'ArrowLeft' ? -1 : 1);
  };
  return (
    <div
      class="sequence-strip"
      data-testid="sequence-strip"
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={onKeyDown}
    >
      <div class="area-header sequence-header">
        <button
          type="button"
          class="btn flat icon"
          title="Previous shot (Shift ←)"
          aria-label="Previous shot"
          data-testid="sequence-prev"
          disabled={!total}
          onClick={() => jumpShot(-1)}
        >
          <Icon name="prev" />
        </button>
        <button
          type="button"
          class={`btn flat icon ${playing ? 'active' : ''}`}
          title={playing ? 'Stop the sequence' : 'Play the sequence through the shot cameras'}
          aria-label={playing ? 'Stop' : 'Play the sequence'}
          aria-pressed={playing}
          data-testid="sequence-play"
          disabled={!total}
          onClick={() => toggleSequence(s)}
        >
          <Icon name={playing ? 'pause' : 'play'} />
        </button>
        <button
          type="button"
          class="btn flat icon"
          title="Next shot (Shift →)"
          aria-label="Next shot"
          data-testid="sequence-next"
          disabled={!total}
          onClick={() => jumpShot(1)}
        >
          <Icon name="next" />
        </button>
        <span
          class="time"
          data-testid="sequence-time"
          title="Sequence time / length (minutes:seconds:frames)"
        >
          {timecode(current ?? 0, fps)} / {timecode(total, fps)}
        </span>
        <span class="shot-name" data-testid="sequence-shot">
          {shotLabel}
        </span>
        <span class="hint hide-narrow" style={{ marginLeft: 'auto', whiteSpace: 'nowrap' }}>
          {current !== null ? `scene frame ${Math.round(frame)}` : ''}
          {disabled > 0 ? ` · ${disabled} shot${disabled === 1 ? '' : 's'} off` : ''}
        </span>
      </div>
      <div
        ref={track}
        class="sequence-track"
        data-testid="sequence-track"
        role="slider"
        tabIndex={0}
        aria-label="Sequence"
        aria-valuemin={0}
        aria-valuemax={Math.max(0, total - 1)}
        aria-valuenow={current ?? 0}
        aria-valuetext={block ? `${block.shot.name}, ${timecode(current ?? 0, fps)}` : 'outside the cut'}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
          scrub(e);
        }}
        onPointerMove={(e) => {
          if (e.buttons & 1) scrub(e);
        }}
      >
        {blocks.map((b, i) => (
          <div
            key={b.shot.id}
            class={`sequence-block ${i % 2 ? 'alt' : ''} ${b.shot.id === selected ? 'selected' : ''}`}
            style={{
              left: `${(xOfSequenceFrame(b.start, 1, total) * 100).toFixed(4)}%`,
              width: `${((b.frames / total) * 100).toFixed(4)}%`,
            }}
            data-testid={`sequence-block-${b.shot.name}`}
            data-start={b.start}
            data-frames={b.frames}
            title={`${b.shot.name}: frames ${b.shot.frame_start}–${b.shot.frame_end} (${b.frames} frames)`}
          >
            {b.shot.name}
            <span class="dur">{(b.frames / fps).toFixed(1)}s</span>
          </div>
        ))}
        {current !== null && total > 0 && (
          <div
            class="sequence-playhead"
            data-testid="sequence-playhead"
            data-frame={current}
            style={{ left: `${((xOfSequenceFrame(current, 1, total) + 0.5 / total) * 100).toFixed(4)}%` }}
          />
        )}
        {!total && (
          <div class="sequence-empty">
            No shots in the cut yet: add shots in the Director workspace (Shots › Add).
          </div>
        )}
      </div>
    </div>
  );
}
