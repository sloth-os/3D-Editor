import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import { Awareness } from 'y-protocols/awareness';
import {
  MSG_CONTROL,
  MSG_SYNC,
  OUT_OF_MEMORY_CLOSE_CODE,
  PROJECT_DELETED_CLOSE_CODE,
  encodeFrame,
  encodeJsonFrame,
  readFrameType,
  readJsonPayload,
  type ControlMessage,
} from '@3d-editor/core';
import { SyncProvider } from '../src/sync/provider';

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
  readonly sent: Uint8Array[] = [];
  constructor(readonly url: string) {
    FakeSocket.created.push(this);
  }
  send(data: Uint8Array): void {
    this.sent.push(data);
  }
  /** The `t` of the pings the provider sent. */
  pings(): number[] {
    return this.sent.flatMap((frame) => {
      const { type, decoder } = readFrameType(frame);
      if (type !== MSG_CONTROL) return [];
      const msg = readJsonPayload<ControlMessage>(decoder);
      return msg.kind === 'ping' ? [msg.t] : [];
    });
  }
  /** The server's answer to the ping `t`. */
  pong(t: number): void {
    this.receive(encodeJsonFrame(MSG_CONTROL, { kind: 'pong', t }));
  }
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

  /*
   * The server closes a connection whose changes the project cannot take (or a connection to a
   * stored project it cannot load) with 4507, after an error with code OUT_OF_MEMORY that says why
   * (apps/server/src/sync/room.ts, ws-server.ts): every new connection would send the same changes
   * again, so the browser keeps them and connects again only on Save (reconnect).
   */
  it('keeps the changes the server did not take and connects again only on reconnect()', () => {
    vi.useFakeTimers();
    const { provider, doc, socket } = connected();
    const hello = encodeJsonFrame(MSG_CONTROL, {
      kind: 'hello',
      connectionId: 'c1',
      room: 'p-sync',
      serverVersion: 'test',
      protocol: 1,
      peers: 1,
    });
    socket.receive(hello);
    socket.receive(
      encodeJsonFrame(MSG_CONTROL, {
        kind: 'error',
        code: 'OUT_OF_MEMORY',
        message: 'changes not applied (test)',
      }),
    );
    socket.closedBy(OUT_OF_MEMORY_CLOSE_CODE);
    expect(provider.status.value).toBe('refused');
    expect(provider.refusal.value).toEqual({ message: 'changes not applied (test)', load: false });
    vi.advanceTimersByTime(10 * 60_000);
    window.dispatchEvent(new Event('online'));
    expect(FakeSocket.created).toHaveLength(1);
    expect(provider.status.value).toBe('refused');
    doc.getMap('m').set('k', 1);
    expect(doc.getMap('m').get('k')).toBe(1);
    // Save: it connects again; refused again, it stops again
    provider.reconnect();
    expect(FakeSocket.created).toHaveLength(2);
    FakeSocket.created[1].open();
    FakeSocket.created[1].receive(hello);
    FakeSocket.created[1].receive(
      encodeJsonFrame(MSG_CONTROL, {
        kind: 'error',
        code: 'OUT_OF_MEMORY',
        message: 'still too large (test)',
      }),
    );
    FakeSocket.created[1].closedBy(OUT_OF_MEMORY_CLOSE_CODE);
    expect(provider.status.value).toBe('refused');
    expect(provider.refusal.value).toEqual({ message: 'still too large (test)', load: false });
    vi.advanceTimersByTime(10 * 60_000);
    expect(FakeSocket.created).toHaveLength(2);
    // the project fits now: the connection stays, and the reason is gone
    provider.reconnect();
    FakeSocket.created[2].open();
    FakeSocket.created[2].receive(hello);
    expect(provider.status.value).toBe('connected');
    expect(provider.refusal.value).toBeNull();
  });

  /* A stored project the server cannot load: it accepts the connection, says why and closes it, with no room. */
  it('tells a refusal of the project at its load from one of its changes', () => {
    const { provider, socket } = connected();
    socket.receive(
      encodeJsonFrame(MSG_CONTROL, {
        kind: 'error',
        code: 'OUT_OF_MEMORY',
        message: "project 'Huge' was not loaded on the server (test)",
      }),
    );
    socket.closedBy(OUT_OF_MEMORY_CLOSE_CODE);
    expect(provider.status.value).toBe('refused');
    expect(provider.refusal.value).toEqual({
      message: "project 'Huge' was not loaded on the server (test)",
      load: true,
    });
  });

  /*
   * WebDAV through the server writes into the server's storage only what the server holds
   * (ProjectSession): the server handles a connection's messages in order and answers no ping once
   * it refused its changes, so the answer to a ping sent after the connection's sync step 2 says
   * that the server holds what the document held then.
   */
  it('says that the server holds a state once it answered a ping sent after the sync step 2', async () => {
    FakeSocket.created = [];
    vi.stubGlobal('WebSocket', FakeSocket);
    // a change made before the connection: the server has it only after this browser's step 2
    const doc = new Y.Doc();
    doc.getMap('m').set('k', 1);
    const provider = new SyncProvider(
      'p-sync',
      doc,
      new Awareness(doc),
      () => 'ws://server.test/sync/p-sync',
    );
    providers.push(provider);
    const socket = FakeSocket.created[0];
    socket.open();
    const state = Y.encodeStateVector(doc);
    // the ping of the connection's opening came before this browser sent the server its state
    const opening = socket.pings();
    expect(opening).toHaveLength(1);
    let holds: boolean | null = null;
    const asked = provider.serverHolds(state, 5000).then((h) => (holds = h));
    socket.pong(opening[0]);
    await Promise.resolve();
    expect(holds).toBeNull();
    // the server's step 1: this browser answers with its step 2, then pings
    socket.receive(encodeFrame(MSG_SYNC, (enc) => syncProtocol.writeSyncStep1(enc, new Y.Doc())));
    const pings = socket.pings();
    expect(pings).toHaveLength(2);
    socket.pong(pings[1]);
    await asked;
    expect(holds).toBe(true);
    expect(await provider.serverHolds(state, 5000)).toBe(true);
    // a later change: held once the server answered again
    doc.getMap('m').set('k', 2);
    const later = provider.serverHolds(Y.encodeStateVector(doc), 5000);
    expect(socket.pings()).toHaveLength(3);
    socket.pong(socket.pings()[2]);
    expect(await later).toBe(true);
  });

  it('says that the server does not hold a state it refused, or did not answer for in time', async () => {
    vi.useFakeTimers();
    const { provider, doc, socket } = connected();
    socket.receive(encodeFrame(MSG_SYNC, (enc) => syncProtocol.writeSyncStep1(enc, new Y.Doc())));
    doc.getMap('m').set('k', 1);
    const late = provider.serverHolds(Y.encodeStateVector(doc), 1000);
    vi.advanceTimersByTime(1000);
    expect(await late).toBe(false);
    doc.getMap('m').set('k', 2);
    const refused = provider.serverHolds(Y.encodeStateVector(doc), 60_000);
    socket.receive(
      encodeJsonFrame(MSG_CONTROL, { kind: 'error', code: 'OUT_OF_MEMORY', message: 'too large (test)' }),
    );
    socket.closedBy(OUT_OF_MEMORY_CLOSE_CODE);
    expect(await refused).toBe(false);
  });

  it('keeps other errors of the server as they were (no refusal)', () => {
    const { provider, socket } = connected();
    socket.receive(encodeJsonFrame(MSG_CONTROL, { kind: 'error', code: 'BAD_MESSAGE', message: 'bad' }));
    expect(provider.refusal.value).toBeNull();
    socket.closedBy(1006);
    expect(provider.status.value).toBe('connecting');
  });
});
