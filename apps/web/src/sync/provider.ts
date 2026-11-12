import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import { signal } from '@preact/signals';
import {
  MSG_AWARENESS,
  MSG_CONTROL,
  MSG_QUERY_AWARENESS,
  MSG_RPC,
  MSG_SYNC,
  OUT_OF_MEMORY_CLOSE_CODE,
  PROJECT_DELETED_CLOSE_CODE,
  encodeFrame,
  encodeJsonFrame,
  readFrameType,
  readJsonPayload,
  type ControlMessage,
  type RpcMessage,
  type RpcRequest,
} from '@3d-editor/core';
import { telemetry } from '../telemetry/telemetry';

/**
 * `deleted`: the server closed the connection with {@link PROJECT_DELETED_CLOSE_CODE}; `refused`:
 * with {@link OUT_OF_MEMORY_CLOSE_CODE}, after an error that says why (SyncProvider.refusal: it did
 * not apply this browser's changes, or cannot load the project, for memory). The provider does not
 * connect again by itself after either (see {@link SyncProvider.reconnect}).
 */
export type SyncStatus = 'disabled' | 'connecting' | 'connected' | 'offline' | 'deleted' | 'refused';

/**
 * Why the server refused (its error with code OUT_OF_MEMORY): `load`, it cannot load the stored
 * project (no room of it held the connection); else it did not apply this browser's changes.
 */
export interface SyncRefusal {
  message: string;
  load: boolean;
}

/** Unanswered pings a connection keeps for {@link SyncProvider.serverHolds} (the oldest go first). */
const MAX_PINGS = 64;

export type RpcHandler = (method: string, params: unknown) => Promise<unknown> | unknown;

/**
 * Real-time sync for one project:
 *  - WebSocket to the editor server (Yjs sync + awareness + RPC), reconnecting with backoff, except
 *    after the server said that the project was deleted there (status `deleted`)
 *  - BroadcastChannel between tabs of the same browser (works offline)
 */
export class SyncProvider {
  readonly status = signal<SyncStatus>('disabled');
  readonly peers = signal(0);
  readonly latencyMs = signal<number | null>(null);
  /** Set once the first full sync with the server completed. */
  readonly synced = signal(false);
  /**
   * A room of the server holds this connection: from the server's hello until the connection
   * closes. The server closes a connection to a project it deleted without a hello.
   */
  readonly joined = signal(false);
  /**
   * Why the server refused this browser's changes or the project (its error with code
   * OUT_OF_MEMORY), from that error until a room of the server takes a connection again.
   */
  readonly refusal = signal<SyncRefusal | null>(null);
  private ws: WebSocket | null = null;
  private bc: BroadcastChannel | null = null;
  private retries = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private destroyed = false;
  /** The server closed the connection because it deleted the project: no reconnecting by itself. */
  private deletedOnServer = false;
  /** The server closed the connection for memory (status `refused`): no reconnecting by itself. */
  private refusedOnServer = false;
  private rpcHandler: RpcHandler | null = null;
  private connectSpan: ReturnType<typeof telemetry.startSpan> | null = null;
  /** Counts the connections (see serverHolds). */
  private connection = 0;
  /** This connection sent the server its sync step 2: all of this document the server lacked. */
  private sentState = false;
  /**
   * The pings of this connection the server has not answered yet, each with this document's state
   * vector when it was sent after the step 2 (null before).
   */
  private pings: { t: number; state: Map<number, number> | null }[] = [];
  /** The state vector the server answered that it holds on this connection (see serverHolds). */
  private held: Map<number, number> | null = null;
  /** Calls of serverHolds waiting for an answer, told of every answer, step 2 and close. */
  private readonly holdWaiters = new Set<() => void>();

  constructor(
    readonly projectId: string,
    readonly doc: Y.Doc,
    readonly awareness: awarenessProtocol.Awareness,
    private url: (() => string) | null,
    private readonly capabilities: string[] = ['render', 'ui'],
  ) {
    doc.on('update', this.onDocUpdate);
    awareness.on('update', this.onAwarenessUpdate);
    if (typeof BroadcastChannel !== 'undefined') {
      this.bc = new BroadcastChannel(`3d-editor:${projectId}`);
      this.bc.onmessage = (e) => this.onBroadcast(e.data as Uint8Array);
      // announce ourselves to other tabs: send our state vector and awareness
      this.bcSend(encodeFrame(MSG_SYNC, (enc) => syncProtocol.writeSyncStep1(enc, doc)));
      this.bcSend(
        encodeFrame(MSG_AWARENESS, (enc) =>
          encoding.writeVarUint8Array(
            enc,
            awarenessProtocol.encodeAwarenessUpdate(awareness, [doc.clientID]),
          ),
        ),
      );
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('online', this.onOnline);
      window.addEventListener('offline', this.onOffline);
    }
    if (url) this.connect();
  }

  /** Starts using a server (e.g. after it became reachable). No-op if already configured. */
  enable(url: () => string): void {
    if (this.url || this.destroyed) return;
    this.url = url;
    this.retries = 0;
    this.connect();
  }

  get enabled(): boolean {
    return !!this.url;
  }

  setRpcHandler(h: RpcHandler | null): void {
    this.rpcHandler = h;
  }

  private onOnline = () => {
    if (!this.ws && this.url && !this.deletedOnServer && !this.refusedOnServer) {
      this.retries = 0;
      this.connect();
    }
  };
  private onOffline = () => {
    this.ws?.close();
  };

  connect(): void {
    if (this.destroyed || !this.url) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.status.value = 'connecting';
    this.connectSpan = telemetry.startSpan('sync.connect', { 'sync.retries': this.retries });
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url());
    } catch {
      this.scheduleReconnect();
      return;
    }
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    this.connection++;
    ws.onopen = () => {
      this.retries = 0;
      this.status.value = 'connected';
      this.connectSpan?.setOk().end();
      this.connectSpan = null;
      this.send(encodeFrame(MSG_SYNC, (enc) => syncProtocol.writeSyncStep1(enc, this.doc)));
      const states = [...this.awareness.getStates().keys()];
      if (states.length)
        this.send(
          encodeFrame(MSG_AWARENESS, (enc) =>
            encoding.writeVarUint8Array(
              enc,
              awarenessProtocol.encodeAwarenessUpdate(this.awareness, [this.doc.clientID]),
            ),
          ),
        );
      this.send(
        encodeJsonFrame(MSG_CONTROL, {
          kind: 'client-info',
          app: '3d-editor-web',
          version: typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'dev',
          capabilities: this.capabilities,
        }),
      );
      this.pingTimer = setInterval(() => this.ping(), 10_000);
      this.ping();
    };
    ws.onmessage = (e) => this.onMessage(new Uint8Array(e.data as ArrayBuffer), 'ws');
    ws.onclose = (e?: CloseEvent) => {
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = null;
      this.ws = null;
      this.joined.value = false;
      this.sentState = false;
      this.pings = [];
      this.held = null;
      this.connectSpan?.setError('closed').end();
      this.connectSpan = null;
      // remove awareness of remote peers (they will be re-sent on reconnect)
      const remote = [...this.awareness.getStates().keys()].filter((id) => id !== this.doc.clientID);
      awarenessProtocol.removeAwarenessStates(this.awareness, remote, 'connection-closed');
      this.peers.value = 0;
      if (this.destroyed) return;
      if (e?.code === PROJECT_DELETED_CLOSE_CODE) {
        // every new connection would be closed the same way (for an hour, unless the server's
        // storage holds the project again): local edits, the IndexedDB copy, other tabs and WebDAV
        // syncing go on without it
        this.deletedOnServer = true;
        this.status.value = 'deleted';
      } else if (e?.code === OUT_OF_MEMORY_CLOSE_CODE) {
        // the server did not apply this browser's changes (or cannot load the project): every new
        // connection would send them again, so the browser keeps them (IndexedDB, other tabs,
        // WebDAV) and connects again on Save, once the person made the project smaller
        this.refusedOnServer = true;
        this.status.value = 'refused';
      } else {
        this.status.value = navigator.onLine ? 'connecting' : 'offline';
        this.scheduleReconnect();
      }
      this.wakeHoldWaiters();
    };
    ws.onerror = () => {
      /* onclose follows */
    };
  }

  /**
   * Connects again after the server deleted the project (status `deleted`) or refused this browser's
   * changes for memory (status `refused`): on an action of the person (Save), and after a deletion
   * when WebDAV through the server finds the project stored there again (see ProjectSession); a
   * reload of the page connects again too. The server closes the connection again while it has the
   * project deleted (unless its storage holds the project again), or while the project would still
   * not fit.
   */
  reconnect(): void {
    if (!this.deletedOnServer && !this.refusedOnServer) return;
    this.deletedOnServer = false;
    this.refusedOnServer = false;
    this.retries = 0;
    this.connect();
  }

  /**
   * Resolves with whether the server holds all of a state of this document (`stateVector`, Yjs
   * encoded: of what a WebDAV sync writes, see ProjectSession): this connection sent it before a
   * ping the server answered. The server handles a connection's messages in order, and answers none
   * once it refused its changes. Sends that ping once the connection sent its sync step 2 (also
   * after connecting again), and waits for the answer at most `timeoutMs`; false when the server
   * refuses or deletes the project meanwhile, or does not answer in time.
   */
  serverHolds(stateVector: Uint8Array, timeoutMs: number): Promise<boolean> {
    const wanted = Y.decodeStateVector(stateVector);
    const holds = () => {
      const held = this.held;
      if (!held) return false;
      for (const [client, clock] of wanted) if (clock > (held.get(client) ?? 0)) return false;
      return true;
    };
    if (holds()) return Promise.resolve(true);
    return new Promise((resolve) => {
      let askedOn = -1;
      const done = (holding: boolean) => {
        clearTimeout(timer);
        this.holdWaiters.delete(check);
        resolve(holding);
      };
      const check = () => {
        const st = this.status.value;
        if (holds()) done(true);
        else if (this.destroyed || st === 'refused' || st === 'deleted') done(false);
        else if (this.sentState && askedOn !== this.connection) {
          askedOn = this.connection;
          this.ping();
        }
      };
      const timer = setTimeout(() => done(false), timeoutMs);
      this.holdWaiters.add(check);
      check();
    });
  }

  private wakeHoldWaiters(): void {
    for (const check of [...this.holdWaiters]) check();
  }

  /** A ping; after the step 2 with this document's state vector, which its answer confirms. */
  private ping(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const t = Date.now();
    this.pings.push({ t, state: this.sentState ? Y.decodeStateVector(Y.encodeStateVector(this.doc)) : null });
    if (this.pings.length > MAX_PINGS) this.pings.shift();
    this.send(encodeJsonFrame(MSG_CONTROL, { kind: 'ping', t }));
  }

  private scheduleReconnect(): void {
    if (this.destroyed || this.reconnectTimer) return;
    const delay = Math.min(30_000, 500 * 2 ** Math.min(this.retries++, 6)) * (0.75 + Math.random() * 0.5);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (navigator.onLine) this.connect();
      else this.status.value = 'offline';
    }, delay);
  }

  private send(data: Uint8Array): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(data as Uint8Array<ArrayBuffer>);
  }

  private bcSend(data: Uint8Array): void {
    try {
      this.bc?.postMessage(data);
    } catch {
      /* closed */
    }
  }

  private onDocUpdate = (update: Uint8Array, origin: unknown) => {
    if (origin === this) return;
    const frame = encodeFrame(MSG_SYNC, (enc) => syncProtocol.writeUpdate(enc, update));
    this.send(frame);
    if (origin !== 'broadcast') this.bcSend(frame);
    telemetry.histogram(
      'editor.sync.update_bytes',
      update.byteLength,
      {},
      'By',
      [64, 256, 1024, 4096, 16384, 65536, 262144, 1048576],
    );
  };

  private onAwarenessUpdate = (
    { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ) => {
    if (origin === this || origin === 'broadcast') return;
    const changed = [...added, ...updated, ...removed];
    const frame = encodeFrame(MSG_AWARENESS, (enc) =>
      encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(this.awareness, changed)),
    );
    this.send(frame);
    this.bcSend(frame);
  };

  private onBroadcast(data: Uint8Array): void {
    if (!(data instanceof Uint8Array)) return;
    this.onMessage(data, 'bc');
  }

  private onMessage(data: Uint8Array, via: 'ws' | 'bc'): void {
    const { type, decoder } = readFrameType(data);
    switch (type) {
      case MSG_SYNC: {
        const enc = encoding.createEncoder();
        encoding.writeVarUint(enc, MSG_SYNC);
        const origin = via === 'ws' ? this : 'broadcast';
        const kind = syncProtocol.readSyncMessage(decoder, enc, this.doc, origin);
        if (via === 'ws' && kind === syncProtocol.messageYjsSyncStep2) this.synced.value = true;
        if (encoding.length(enc) > 1) {
          if (via === 'ws') this.send(encoding.toUint8Array(enc));
          else this.bcSend(encoding.toUint8Array(enc));
        }
        // the answer to the server's step 1 is this connection's step 2; every later change of the
        // document goes to the server as it happens
        if (
          via === 'ws' &&
          kind === syncProtocol.messageYjsSyncStep1 &&
          this.ws?.readyState === WebSocket.OPEN
        ) {
          this.sentState = true;
          this.wakeHoldWaiters();
        }
        break;
      }
      case MSG_AWARENESS:
        awarenessProtocol.applyAwarenessUpdate(
          this.awareness,
          decoding.readVarUint8Array(decoder),
          via === 'ws' ? this : 'broadcast',
        );
        break;
      case MSG_QUERY_AWARENESS:
        this.send(
          encodeFrame(MSG_AWARENESS, (enc) =>
            encoding.writeVarUint8Array(
              enc,
              awarenessProtocol.encodeAwarenessUpdate(this.awareness, [...this.awareness.getStates().keys()]),
            ),
          ),
        );
        break;
      case MSG_RPC:
        if (via === 'ws') void this.onRpc(readJsonPayload<RpcMessage>(decoder));
        break;
      case MSG_CONTROL:
        this.onControl(readJsonPayload<ControlMessage>(decoder));
        break;
      default:
        break;
    }
  }

  private onControl(msg: ControlMessage): void {
    // (control frames come from the server only: other tabs send sync and awareness frames)
    if (msg.kind === 'hello') {
      this.joined.value = true;
      this.refusal.value = null;
    }
    if (msg.kind === 'hello' || msg.kind === 'peers')
      this.peers.value = msg.kind === 'hello' ? msg.peers : msg.count;
    else if (msg.kind === 'pong') {
      const rtt = Date.now() - msg.t;
      this.latencyMs.value = rtt;
      telemetry.histogram('editor.sync.latency_ms', rtt);
      // the server holds what this connection sent before that ping
      const i = this.pings.findIndex((p) => p.t === msg.t);
      if (i >= 0) {
        const { state } = this.pings[i];
        this.pings.splice(0, i + 1);
        if (state) {
          this.held = state;
          this.wakeHoldWaiters();
        }
      }
    } else if (msg.kind === 'ping') this.send(encodeJsonFrame(MSG_CONTROL, { kind: 'pong', t: msg.t }));
    else if (msg.kind === 'error') {
      telemetry.log('WARN', `sync server error: ${msg.message}`);
      // the reason of the close that follows (OUT_OF_MEMORY_CLOSE_CODE); a connection no room held
      // is one to a stored project the server cannot load
      if (msg.code === 'OUT_OF_MEMORY')
        this.refusal.value = { message: msg.message, load: !this.joined.value };
    }
  }

  private async onRpc(msg: RpcMessage): Promise<void> {
    if (msg.kind !== 'req') return;
    const req = msg as RpcRequest;
    const span = telemetry.startSpan(`rpc ${req.method}`, { 'rpc.method': req.method });
    try {
      if (!this.rpcHandler) throw new Error('editor does not accept RPC calls');
      const result = await this.rpcHandler(req.method, req.params);
      this.send(encodeJsonFrame(MSG_RPC, { kind: 'res', id: req.id, result }));
      span.setOk();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.send(encodeJsonFrame(MSG_RPC, { kind: 'res', id: req.id, error: { message } }));
      span.setError(message);
    } finally {
      span.end();
    }
  }

  destroy(): void {
    this.destroyed = true;
    this.wakeHoldWaiters();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.doc.off('update', this.onDocUpdate);
    this.awareness.off('update', this.onAwarenessUpdate);
    if (typeof window !== 'undefined') {
      window.removeEventListener('online', this.onOnline);
      window.removeEventListener('offline', this.onOffline);
    }
    // tell other tabs/peers we left
    awarenessProtocol.removeAwarenessStates(this.awareness, [this.doc.clientID], 'destroy');
    this.ws?.close();
    this.bc?.close();
    this.status.value = 'disabled';
  }
}

export { Y };
