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
  encodeFrame,
  encodeJsonFrame,
  readFrameType,
  readJsonPayload,
  type ControlMessage,
  type RpcMessage,
  type RpcRequest,
} from '@3d-editor/core';
import { telemetry } from '../telemetry/telemetry';

export type SyncStatus = 'disabled' | 'connecting' | 'connected' | 'offline';

export type RpcHandler = (method: string, params: unknown) => Promise<unknown> | unknown;

/**
 * Real-time sync for one project:
 *  - WebSocket to the editor server (Yjs sync + awareness + RPC), reconnecting with backoff
 *  - BroadcastChannel between tabs of the same browser (works offline)
 */
export class SyncProvider {
  readonly status = signal<SyncStatus>('disabled');
  readonly peers = signal(0);
  readonly latencyMs = signal<number | null>(null);
  /** Set once the first full sync with the server completed. */
  readonly synced = signal(false);
  private ws: WebSocket | null = null;
  private bc: BroadcastChannel | null = null;
  private retries = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private destroyed = false;
  private rpcHandler: RpcHandler | null = null;
  private connectSpan: ReturnType<typeof telemetry.startSpan> | null = null;

  constructor(
    readonly projectId: string,
    readonly doc: Y.Doc,
    readonly awareness: awarenessProtocol.Awareness,
    private readonly url: (() => string) | null,
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
          encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(awareness, [doc.clientID])),
        ),
      );
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('online', this.onOnline);
      window.addEventListener('offline', this.onOffline);
    }
    if (url) this.connect();
  }

  setRpcHandler(h: RpcHandler | null): void {
    this.rpcHandler = h;
  }

  private onOnline = () => {
    if (!this.ws && this.url) {
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
            encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(this.awareness, [this.doc.clientID])),
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
      this.pingTimer = setInterval(() => this.send(encodeJsonFrame(MSG_CONTROL, { kind: 'ping', t: Date.now() })), 10_000);
      this.send(encodeJsonFrame(MSG_CONTROL, { kind: 'ping', t: Date.now() }));
    };
    ws.onmessage = (e) => this.onMessage(new Uint8Array(e.data as ArrayBuffer), 'ws');
    ws.onclose = () => {
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = null;
      this.ws = null;
      this.connectSpan?.setError('closed').end();
      this.connectSpan = null;
      // remove awareness of remote peers (they will be re-sent on reconnect)
      const remote = [...this.awareness.getStates().keys()].filter((id) => id !== this.doc.clientID);
      awarenessProtocol.removeAwarenessStates(this.awareness, remote, 'connection-closed');
      this.peers.value = 0;
      if (this.destroyed) return;
      this.status.value = navigator.onLine ? 'connecting' : 'offline';
      this.scheduleReconnect();
    };
    ws.onerror = () => {
      /* onclose follows */
    };
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
    telemetry.histogram('editor.sync.update_bytes', update.byteLength, {}, 'By', [64, 256, 1024, 4096, 16384, 65536, 262144, 1048576]);
  };

  private onAwarenessUpdate = ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
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
        break;
      }
      case MSG_AWARENESS:
        awarenessProtocol.applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(decoder), via === 'ws' ? this : 'broadcast');
        break;
      case MSG_QUERY_AWARENESS:
        this.send(
          encodeFrame(MSG_AWARENESS, (enc) =>
            encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(this.awareness, [...this.awareness.getStates().keys()])),
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
    if (msg.kind === 'hello' || msg.kind === 'peers') this.peers.value = msg.kind === 'hello' ? msg.peers : msg.count;
    else if (msg.kind === 'pong') {
      const rtt = Date.now() - msg.t;
      this.latencyMs.value = rtt;
      telemetry.histogram('editor.sync.latency_ms', rtt);
    } else if (msg.kind === 'ping') this.send(encodeJsonFrame(MSG_CONTROL, { kind: 'pong', t: msg.t }));
    else if (msg.kind === 'error') telemetry.log('WARN', `sync server error: ${msg.message}`);
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
