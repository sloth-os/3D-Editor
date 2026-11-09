import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';
import { MSG_CONTROL, encodeJsonFrame } from '@3d-editor/core';
import { PROJECT_DELETED_CLOSE_CODE, SyncProvider } from '../src/sync/provider';

/** A WebSocket the test opens and closes as the editor server would. */
class FakeSocket {
  static readonly OPEN = 1;
  static created: FakeSocket[] = [];
  readyState = 0;
  binaryType = 'blob';
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: ArrayBuffer }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.created.push(this);
  }
  send(): void {}
  close(): void {
    this.readyState = 3;
  }
  /** A frame from the server. */
  receive(frame: Uint8Array): void {
    this.onmessage?.({ data: frame.slice().buffer });
  }
  /** The server accepts the connection. */
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  /** The server closes the connection with `code` (1006: it went away, as browsers report it). */
  closedBy(code: number): void {
    this.readyState = 3;
    this.onclose?.({ code });
  }
}

const providers: SyncProvider[] = [];

function connected() {
  FakeSocket.created = [];
  vi.stubGlobal('WebSocket', FakeSocket);
  const doc = new Y.Doc();
  const provider = new SyncProvider('p-sync', doc, new Awareness(doc), () => 'ws://server.test/sync/p-sync');
  providers.push(provider);
  expect(FakeSocket.created).toHaveLength(1);
  FakeSocket.created[0].open();
  expect(provider.status.value).toBe('connected');
  return { provider, doc, socket: FakeSocket.created[0] };
}

afterEach(() => {
  for (const p of providers.splice(0)) p.destroy();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('SyncProvider', () => {
  it('connects again with backoff when the connection is lost', () => {
    vi.useFakeTimers();
    const { provider, socket } = connected();
    socket.closedBy(1006);
    expect(provider.status.value).toBe('connecting');
    vi.advanceTimersByTime(30_000);
    expect(FakeSocket.created).toHaveLength(2);
  });

  /*
   * The server closes the connection with 4404 when it deletes the project, and every new
   * connection to the project the same way (apps/server/src/sync/ws-server.ts): the provider used to
   * connect again and again (every 30 s at last), and the status said 'Connecting…'.
   */
  it('does not connect again by itself after the server deleted the project', () => {
    vi.useFakeTimers();
    const { provider, doc, socket } = connected();
    socket.closedBy(PROJECT_DELETED_CLOSE_CODE);
    expect(provider.status.value).toBe('deleted');
    vi.advanceTimersByTime(10 * 60_000);
    window.dispatchEvent(new Event('online'));
    expect(FakeSocket.created).toHaveLength(1);
    expect(provider.status.value).toBe('deleted');
    // local edits go on (other tabs of the browser, IndexedDB and WebDAV get them as before)
    doc.getMap('m').set('k', 1);
    expect(doc.getMap('m').get('k')).toBe(1);
  });

  it('connects again on reconnect() (an action of the person), and stops again if refused', () => {
    vi.useFakeTimers();
    const { provider, socket } = connected();
    provider.reconnect(); // connected: nothing to do
    expect(FakeSocket.created).toHaveLength(1);
    socket.closedBy(PROJECT_DELETED_CLOSE_CODE);
    provider.reconnect();
    expect(FakeSocket.created).toHaveLength(2);
    expect(provider.status.value).toBe('connecting');
    // the server still has the project deleted: it accepts the connection and closes it at once
    FakeSocket.created[1].open();
    FakeSocket.created[1].closedBy(PROJECT_DELETED_CLOSE_CODE);
    expect(provider.status.value).toBe('deleted');
    vi.advanceTimersByTime(10 * 60_000);
    expect(FakeSocket.created).toHaveLength(2);
    // once the server has it again (its storage holds it again), the connection stays
    provider.reconnect();
    FakeSocket.created[2].open();
    expect(provider.status.value).toBe('connected');
  });

  /*
   * A room of the server greets each connection it takes (hello); the server closes a connection to
   * a project it deleted without one. The session tells of a deletion again only after a room took a
   * connection again.
   */
  it('says whether a room of the server holds the connection', () => {
    const { provider, socket } = connected();
    expect(provider.joined.value).toBe(false);
    socket.receive(
      encodeJsonFrame(MSG_CONTROL, {
        kind: 'hello',
        connectionId: 'c1',
        room: 'p-sync',
        serverVersion: 'test',
        protocol: 1,
        peers: 1,
      }),
    );
    expect(provider.joined.value).toBe(true);
    expect(provider.peers.value).toBe(1);
    socket.closedBy(PROJECT_DELETED_CLOSE_CODE);
    expect(provider.joined.value).toBe(false);
    // a connection the server closes at once (the project is still deleted there) never joins
    provider.reconnect();
    FakeSocket.created[1].open();
    expect(provider.joined.value).toBe(false);
    FakeSocket.created[1].closedBy(PROJECT_DELETED_CLOSE_CODE);
    expect(provider.joined.value).toBe(false);
  });
});
