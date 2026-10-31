import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import type { Vec3 } from '../math/types';
import type { EditorMode } from '../operators/context';

/*
 * Real-time sync wire protocol (binary WebSocket frames), compatible in spirit with
 * y-websocket: every frame starts with a varuint message type.
 *
 *   SYNC (0)            y-protocols/sync payload (step1 / step2 / update)
 *   AWARENESS (1)       y-protocols/awareness update (presence: user, selection, view, ...)
 *   QUERY_AWARENESS (3) ask the peer to send its full awareness state
 *   RPC (4)             JSON RPC request/response routed between server and editor clients
 *                       (used by MCP tools that need a live editor, e.g. rendering screenshots)
 *   CONTROL (5)         JSON control messages (hello, client-info, ping/pong, errors)
 *
 * WebSocket URL: /sync/<projectId>?token=<optional auth token>
 */

export const MSG_SYNC = 0;
export const MSG_AWARENESS = 1;
export const MSG_QUERY_AWARENESS = 3;
export const MSG_RPC = 4;
export const MSG_CONTROL = 5;

export const PROTOCOL_VERSION = 1;

export interface RpcRequest {
  kind: 'req';
  id: string;
  method: string;
  params?: unknown;
  /** W3C trace context of the caller (for distributed tracing). */
  traceparent?: string;
}

export interface RpcResponse {
  kind: 'res';
  id: string;
  result?: unknown;
  error?: { message: string; code?: string };
}

export type RpcMessage = RpcRequest | RpcResponse;

export type ControlMessage =
  | {
      kind: 'hello';
      connectionId: string;
      room: string;
      serverVersion: string;
      protocol: number;
      peers: number;
    }
  | { kind: 'client-info'; app: string; version: string; capabilities: string[]; name?: string }
  | { kind: 'peers'; count: number }
  | { kind: 'ping'; t: number }
  | { kind: 'pong'; t: number }
  | { kind: 'error'; message: string; code?: string };

/** Presence published through awareness by every connected editor (and MCP agents). */
export interface PresenceState {
  user: { name: string; color: string; kind: 'human' | 'agent' };
  device?: string;
  mode?: EditorMode;
  selection?: string[];
  active?: string | null;
  frame?: number;
  /** Viewport camera pose so other devices can "follow" this user's view. */
  view?: { position: Vec3; target: Vec3; up: Vec3; fov: number; ortho: boolean };
  cursor3d?: Vec3;
  /** e.g. ['render', 'ui'] for browser editors that accept RPC calls. */
  capabilities?: string[];
}

export function encodeFrame(type: number, write: (enc: encoding.Encoder) => void): Uint8Array {
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, type);
  write(enc);
  return encoding.toUint8Array(enc);
}

export function encodeJsonFrame(
  type: typeof MSG_RPC | typeof MSG_CONTROL,
  payload: RpcMessage | ControlMessage,
): Uint8Array {
  return encodeFrame(type, (enc) => encoding.writeVarString(enc, JSON.stringify(payload)));
}

export function readFrameType(data: Uint8Array): { type: number; decoder: decoding.Decoder } {
  const decoder = decoding.createDecoder(data);
  return { type: decoding.readVarUint(decoder), decoder };
}

export function readJsonPayload<T>(decoder: decoding.Decoder): T {
  return JSON.parse(decoding.readVarString(decoder)) as T;
}

/** Deterministic pleasant color for a user/device name. */
export function colorForName(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  return `hsl(${hue}, 70%, 60%)`;
}
