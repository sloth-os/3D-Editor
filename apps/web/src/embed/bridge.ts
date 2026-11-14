import {
  ConnectSchema,
  PROTOCOL,
  PROTOCOL_VERSIONS,
  deskMessageProblems,
  parseHostMessage,
  type DeskMessage,
  type HostMessage,
} from './protocol';

/*
 * The desk's side of the connection (docs/embedding.md, "Connection"):
 *
 * 1. Once loaded, and only inside a frame (window.parent !== window), it posts
 *    {protocol: '3d-desk', type: 'hello', versions: [1]} to window.parent, target origin '*'.
 * 2. It accepts one `connect`: only from window.parent (event.source), from a real origin (an http
 *    or https origin, not 'null'), with a version it speaks and a transferred MessagePort. It records
 *    event.origin as the host's origin. A connect it does not accept is ignored (one of another
 *    version is answered on its port with error unsupported_version, and that port is closed).
 * 3. Everything after that travels on the port; nothing more is read from or posted on window.
 *
 * On the port: messages of a type the desk does not know are ignored and logged; a known type that
 * does not validate is answered with error bad_message when it carried an id (an invalid `open`,
 * which carries none, with invalid_scene or bad_message without an id) and is otherwise ignored.
 * Valid messages go to the handler. What the host sends before the desk's `ready` waits until
 * `ready` is out (ready is always the first message on the port), then is handled in order. Every
 * message the desk sends is validated first (a problem is logged; the message goes all the same,
 * the host's validation decides).
 */

/** What the bridge needs of a port (a MessagePort, or a fake in tests). */
export interface PortLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: 'message', listener: (e: MessageEvent) => void): void;
  start?(): void;
  close(): void;
}

/** What the bridge needs of its window (the page's window, or a fake in tests). */
export interface WindowLike {
  readonly parent: unknown;
  addEventListener(type: 'message', listener: (e: MessageEvent) => void): void;
  removeEventListener(type: 'message', listener: (e: MessageEvent) => void): void;
}

export interface BridgeHandler {
  /** The host connected (its origin); the desk answers `ready` (within 2 s). */
  connected(hostOrigin: string): void;
  /** A valid message from the host. */
  message(message: HostMessage): void;
}

export interface BridgeLog {
  info(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
}

const consoleLog: BridgeLog = {
  info: (m, d) => console.info(`[desk] ${m}`, d ?? ''),
  warn: (m, d) => console.warn(`[desk] ${m}`, d ?? ''),
};

/** Whether an origin is one a host can have (http or https; not 'null', not a file). */
export function isHostOrigin(origin: unknown): origin is string {
  if (typeof origin !== 'string') return false;
  try {
    const u = new URL(origin);
    return (u.protocol === 'https:' || u.protocol === 'http:') && u.origin === origin;
  } catch {
    return false;
  }
}

export class DeskBridge {
  private port: PortLike | null = null;
  private hostOrigin: string | null = null;
  private started = false;
  /** Whether `ready` went out; until then the host's messages wait in `early`. */
  private readySent = false;
  private early: unknown[] = [];

  constructor(
    private readonly win: WindowLike,
    private readonly handler: BridgeHandler,
    private readonly log: BridgeLog = consoleLog,
  ) {}

  /** Whether the page runs inside a frame (a host can connect). */
  get framed(): boolean {
    return this.win.parent !== this.win && !!this.win.parent;
  }

  /** The host's origin once connected. */
  get origin(): string | null {
    return this.hostOrigin;
  }

  get connected(): boolean {
    return this.port !== null;
  }

  /** Listens for the host and posts hello to window.parent; false (and nothing posted) outside a frame. */
  start(): boolean {
    if (this.started || !this.framed) return false;
    this.started = true;
    this.win.addEventListener('message', this.onWindowMessage);
    (this.win.parent as { postMessage(m: unknown, origin: string): void }).postMessage(
      { protocol: PROTOCOL, type: 'hello', versions: [...PROTOCOL_VERSIONS] },
      '*',
    );
    return true;
  }

  /** Stops listening (window and port). */
  stop(): void {
    this.win.removeEventListener('message', this.onWindowMessage);
    this.win.removeEventListener('message', this.onLateWindowMessage);
    this.port?.close();
    this.port = null;
  }

  private readonly onWindowMessage = (e: MessageEvent): void => {
    const data = e.data as { protocol?: unknown; type?: unknown } | null;
    // window messages of other protocols (browser extensions, the host's own) are not ours
    if (!data || typeof data !== 'object' || data.protocol !== PROTOCOL) return;
    if (this.port) {
      this.log.info('ignored a window message: the desk is connected already', { type: data.type });
      return;
    }
    if (e.source !== this.win.parent) {
      this.log.warn('ignored a message that does not come from the parent window', { type: data.type });
      return;
    }
    const connect = ConnectSchema.safeParse(data);
    if (!connect.success) {
      this.log.warn('ignored a window message that is not a valid connect', { type: data.type });
      return;
    }
    if (!isHostOrigin(e.origin)) {
      this.log.warn('ignored a connect from an origin that is not http(s)', { origin: e.origin });
      return;
    }
    const port = (e.ports?.[0] ?? null) as PortLike | null;
    if (!port) {
      this.log.warn('ignored a connect without a MessagePort');
      return;
    }
    if (!(PROTOCOL_VERSIONS as readonly number[]).includes(connect.data.version)) {
      this.log.warn(`ignored a connect of protocol version ${connect.data.version}`);
      try {
        port.postMessage({
          type: 'error',
          code: 'unsupported_version',
          message: `This desk speaks protocol versions ${PROTOCOL_VERSIONS.join(', ')}, not ${connect.data.version}.`,
        });
        port.close();
      } catch {
        /* a port that cannot carry the answer */
      }
      return;
    }
    this.port = port;
    this.hostOrigin = e.origin;
    this.win.removeEventListener('message', this.onWindowMessage);
    // window messages after the connect are ignored: keep listening only to say so in the log
    this.win.addEventListener('message', this.onLateWindowMessage);
    port.addEventListener('message', this.onPortMessage);
    port.start?.();
    this.handler.connected(e.origin);
  };

  private readonly onLateWindowMessage = (e: MessageEvent): void => {
    const data = e.data as { protocol?: unknown; type?: unknown } | null;
    if (data && typeof data === 'object' && data.protocol === PROTOCOL)
      this.log.info('ignored a window message: the desk is connected already', { type: data.type });
  };

  private readonly onPortMessage = (e: MessageEvent): void => {
    // the host's requests are answered after ready (which goes within 2 s of the connect)
    if (!this.readySent) {
      this.early.push(e.data);
      return;
    }
    this.handle(e.data);
  };

  private handle(data: unknown): void {
    const parsed = parseHostMessage(data);
    if (parsed.kind === 'unknown') {
      this.log.info(`ignored a message of unknown type '${parsed.type ?? '(none)'}'`);
      return;
    }
    if (parsed.kind === 'invalid') {
      this.log.warn(`a ${parsed.type} message is not valid: ${parsed.problems}`);
      if (parsed.reply) this.send(parsed.reply);
      return;
    }
    this.handler.message(parsed.message);
  }

  /** Sends a message to the host (its ArrayBuffers in `transfer`); false when not connected. */
  send(message: DeskMessage, transfer: Transferable[] = []): boolean {
    if (!this.port) return false;
    const problem = deskMessageProblems(message);
    if (problem) this.log.warn(`the desk sends a ${message.type} message that is not valid: ${problem}`);
    this.port.postMessage(message, transfer);
    if (message.type === 'ready' && !this.readySent) {
      this.readySent = true;
      // what the host sent before ready, in its order
      for (const data of this.early.splice(0)) this.handle(data);
    }
    return true;
  }
}
