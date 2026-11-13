import { WebSocket } from 'ws';
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import {
  MSG_AWARENESS,
  MSG_CONTROL,
  MSG_QUERY_AWARENESS,
  MSG_RPC,
  MSG_SYNC,
  SceneDoc,
  encodeFrame,
  encodeJsonFrame,
  readFrameType,
  readJsonPayload,
  type ControlMessage,
  type PresenceState,
  type RpcMessage,
  type RpcRequest,
} from '@3d-editor/core';

export type HelloMessage = Extract<ControlMessage, { kind: 'hello' }>;
export type RpcHandler = (method: string, params: unknown) => unknown | Promise<unknown>;

export interface SyncClientOptions {
  /** Server base URL, e.g. http://127.0.0.1:1234 */
  baseUrl: string;
  projectId: string;
  token?: string;
  /** Name published in awareness (user.name) and client-info. */
  name?: string;
  kind?: 'human' | 'agent';
  /** Capabilities advertised via `client-info` (e.g. ['render', 'ui']). */
  capabilities?: string[];
  /** Answers RPC requests from the server. */
  rpcHandler?: RpcHandler;
  /** Use an existing document (e.g. to simulate a device with local data). */
  doc?: Y.Doc;
}

/**
 * Minimal Node implementation of the editor's sync protocol (the same frames the browser
 * SyncProvider sends): Yjs sync, awareness, client-info / ping and RPC answers.
 */
export class SyncTestClient {
  readonly doc: Y.Doc;
  readonly scene: SceneDoc;
  readonly awareness: awarenessProtocol.Awareness;
  ws: WebSocket | null = null;
  hello: HelloMessage | null = null;
  peers = 0;
  /** True once the server answered our SyncStep1 (initial sync complete). */
  synced = false;
  readonly controls: ControlMessage[] = [];
  readonly rpcRequests: RpcRequest[] = [];
  rpcHandler: RpcHandler | null;
  closeCode: number | null = null;

  constructor(readonly opts: SyncClientOptions) {
    this.doc = opts.doc ?? new Y.Doc();
    this.scene = new SceneDoc(this.doc, { type: 'test-client', name: opts.name ?? 'client' });
    this.awareness = new awarenessProtocol.Awareness(this.doc);
    this.rpcHandler = opts.rpcHandler ?? null;
    const name = opts.name ?? 'Test User';
    this.awareness.setLocalState({
      user: { name, color: '#ff8800', kind: opts.kind ?? 'human' },
      mode: 'OBJECT',
      selection: [],
    });
    this.doc.on('update', this.onDocUpdate);
    this.awareness.on('update', this.onAwarenessUpdate);
  }

  get url(): string {
    const u = new URL(`/sync/${encodeURIComponent(this.opts.projectId)}`, this.opts.baseUrl);
    u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
    if (this.opts.token) u.searchParams.set('token', this.opts.token);
    return u.toString();
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /** Connects and resolves after the hello message and the initial sync. */
  connect(timeoutMs = 5000): Promise<void> {
    this.synced = false;
    this.hello = null;
    this.closeCode = null;
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      const timer = setTimeout(() => reject(new Error('sync client: connect timed out')), timeoutMs);
      const done = () => {
        if (this.synced && this.hello) {
          clearTimeout(timer);
          resolve();
        }
      };
      ws.binaryType = 'nodebuffer';
      ws.on('open', () => {
        this.send(encodeFrame(MSG_SYNC, (enc) => syncProtocol.writeSyncStep1(enc, this.doc)));
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
            app: 'sync-test-client',
            version: '0',
            capabilities: this.opts.capabilities ?? [],
            name: this.opts.name,
          }),
        );
      });
      ws.on('message', (data) => {
        const buf = Array.isArray(data)
          ? Buffer.concat(data)
          : Buffer.isBuffer(data)
            ? data
            : Buffer.from(data as ArrayBuffer);
        this.onMessage(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
        done();
      });
      ws.on('unexpected-response', (_req, res) => {
        clearTimeout(timer);
        reject(new Error(`sync client: upgrade rejected with HTTP ${res.statusCode}`));
      });
      ws.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      ws.on('close', (code) => {
        this.closeCode = code;
        clearTimeout(timer);
        const remote = [...this.awareness.getStates().keys()].filter((id) => id !== this.doc.clientID);
        awarenessProtocol.removeAwarenessStates(this.awareness, remote, 'closed');
        reject(new Error(`sync client: closed (${code})`));
      });
    });
  }

  /** Closes the WebSocket (local document and awareness are kept, like going offline). */
  disconnect(): Promise<void> {
    const ws = this.ws;
    if (!ws || ws.readyState === WebSocket.CLOSED) return Promise.resolve();
    return new Promise((resolve) => {
      ws.once('close', () => resolve());
      ws.close();
    });
  }

  destroy(): Promise<void> {
    this.doc.off('update', this.onDocUpdate);
    this.awareness.off('update', this.onAwarenessUpdate);
    const p = this.disconnect();
    this.awareness.destroy();
    this.scene.destroy();
    return p;
  }

  send(frame: Uint8Array): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(frame);
  }

  setPresence(patch: Partial<PresenceState> & Record<string, unknown>): void {
    this.awareness.setLocalState({ ...(this.awareness.getLocalState() ?? {}), ...patch });
  }

  queryAwareness(): void {
    this.send(encodeFrame(MSG_QUERY_AWARENESS, () => {}));
  }

  ping(t = Date.now()): void {
    this.send(encodeJsonFrame(MSG_CONTROL, { kind: 'ping', t }));
  }

  /** Awareness states of everybody else in the room. */
  remoteStates(): (Partial<PresenceState> & Record<string, unknown>)[] {
    return [...this.awareness.getStates().entries()]
      .filter(([id]) => id !== this.doc.clientID)
      .map(([, s]) => s as Partial<PresenceState> & Record<string, unknown>);
  }

  /** Polls until `predicate` is true. */
  async waitFor(predicate: () => boolean, timeoutMs = 5000, what = 'condition'): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error(`sync client: timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 15));
    }
  }

  private readonly onDocUpdate = (update: Uint8Array, origin: unknown) => {
    if (origin === this) return;
    this.send(encodeFrame(MSG_SYNC, (enc) => syncProtocol.writeUpdate(enc, update)));
  };

  private readonly onAwarenessUpdate = (
    { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ) => {
    if (origin === this || origin === 'closed') return;
    const changed = [...added, ...updated, ...removed];
    this.send(
      encodeFrame(MSG_AWARENESS, (enc) =>
        encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(this.awareness, changed)),
      ),
    );
  };

  private onMessage(data: Uint8Array): void {
    const { type, decoder } = readFrameType(data);
    switch (type) {
      case MSG_SYNC: {
        const enc = encoding.createEncoder();
        encoding.writeVarUint(enc, MSG_SYNC);
        const kind = syncProtocol.readSyncMessage(decoder, enc, this.doc, this);
        if (kind === syncProtocol.messageYjsSyncStep2) this.synced = true;
        if (encoding.length(enc) > 1) this.send(encoding.toUint8Array(enc));
        break;
      }
      case MSG_AWARENESS:
        awarenessProtocol.applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(decoder), this);
        break;
      case MSG_CONTROL: {
        const msg = readJsonPayload<ControlMessage>(decoder);
        this.controls.push(msg);
        if (msg.kind === 'hello') {
          this.hello = msg;
          this.peers = msg.peers;
        } else if (msg.kind === 'peers') this.peers = msg.count;
        else if (msg.kind === 'ping') this.send(encodeJsonFrame(MSG_CONTROL, { kind: 'pong', t: msg.t }));
        break;
      }
      case MSG_RPC: {
        const msg = readJsonPayload<RpcMessage>(decoder);
        if (msg.kind === 'req') void this.answerRpc(msg);
        break;
      }
      default:
        break;
    }
  }

  private async answerRpc(req: RpcRequest): Promise<void> {
    this.rpcRequests.push(req);
    try {
      if (!this.rpcHandler) throw new Error('no RPC handler');
      const result = await this.rpcHandler(req.method, req.params);
      this.send(encodeJsonFrame(MSG_RPC, { kind: 'res', id: req.id, result }));
    } catch (err) {
      this.send(
        encodeJsonFrame(MSG_RPC, {
          kind: 'res',
          id: req.id,
          error: { message: err instanceof Error ? err.message : String(err) },
        }),
      );
    }
  }
}
