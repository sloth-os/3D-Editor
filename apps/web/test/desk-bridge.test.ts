import { describe, expect, it, vi } from 'vitest';
import { DeskBridge, isHostOrigin, type BridgeHandler, type PortLike } from '../src/embed/bridge';

/*
 * The desk's side of the connection (embed/bridge.ts) with a fake window, parent and ports: hello
 * to the parent only inside a frame, one connect only from the parent with a version the desk
 * speaks (another version answered on its port and refused), nothing on window afterwards, and the
 * port's messages validated (unknown types ignored, bad ones answered when they carry an id).
 */

class FakePort implements PortLike {
  posted: { message: any; transfer?: Transferable[] }[] = [];
  closed = false;
  started = false;
  private listeners: ((e: MessageEvent) => void)[] = [];
  postMessage(message: unknown, transfer?: Transferable[]) {
    this.posted.push({ message, transfer });
  }
  addEventListener(_type: 'message', listener: (e: MessageEvent) => void) {
    this.listeners.push(listener);
  }
  start() {
    this.started = true;
  }
  close() {
    this.closed = true;
  }
  emit(data: unknown) {
    for (const l of this.listeners) l({ data } as MessageEvent);
  }
}

function setup(opts: { framed?: boolean } = {}) {
  const parent = { posted: [] as { message: any; origin: string }[], postMessage(m: unknown, o: string) {
    this.posted.push({ message: m, origin: o });
  } };
  const listeners = new Set<(e: MessageEvent) => void>();
  const win: any = {
    addEventListener: (_t: string, l: (e: MessageEvent) => void) => listeners.add(l),
    removeEventListener: (_t: string, l: (e: MessageEvent) => void) => listeners.delete(l),
  };
  win.parent = opts.framed === false ? win : parent;
  const dispatch = (e: Partial<MessageEvent> & { data: unknown }) => {
    for (const l of [...listeners]) l(e as MessageEvent);
  };
  const handler: BridgeHandler & { connected: ReturnType<typeof vi.fn>; message: ReturnType<typeof vi.fn> } = {
    connected: vi.fn(),
    message: vi.fn(),
  };
  const log = { info: vi.fn(), warn: vi.fn() };
  const bridge = new DeskBridge(win, handler, log);
  const connect = (o: { version?: number; source?: unknown; origin?: string; port?: FakePort | null; data?: unknown } = {}) => {
    const port = o.port === undefined ? new FakePort() : o.port;
    dispatch({
      data: o.data ?? { protocol: '3d-desk', type: 'connect', version: o.version ?? 1 },
      source: (o.source ?? parent) as MessageEventSource,
      origin: o.origin ?? 'https://host.example',
      ports: port ? [port as unknown as MessagePort] : [],
    });
    return port;
  };
  return { bridge, parent, win, listeners, dispatch, handler, log, connect };
}

describe('the desk bridge', () => {
  it('says hello to its parent, only inside a frame', () => {
    const t = setup();
    expect(t.bridge.framed).toBe(true);
    expect(t.bridge.start()).toBe(true);
    expect(t.parent.posted).toEqual([{ message: { protocol: '3d-desk', type: 'hello', versions: [1] }, origin: '*' }]);
    expect(t.bridge.start()).toBe(false);
    expect(t.parent.posted).toHaveLength(1);

    const alone = setup({ framed: false });
    expect(alone.bridge.framed).toBe(false);
    expect(alone.bridge.start()).toBe(false);
    expect(alone.listeners.size).toBe(0);
  });

  it("accepts one connect from its parent and records the host's origin", () => {
    const t = setup();
    t.bridge.start();
    const port = t.connect()!;
    expect(t.handler.connected).toHaveBeenCalledWith('https://host.example');
    expect(t.bridge.connected).toBe(true);
    expect(t.bridge.origin).toBe('https://host.example');
    expect(port.started).toBe(true);
    // a second connect, even from the parent, is ignored
    const second = t.connect({ origin: 'https://other.example' })!;
    expect(t.handler.connected).toHaveBeenCalledTimes(1);
    expect(second.posted).toEqual([]);
    expect(t.bridge.origin).toBe('https://host.example');
  });

  it('ignores a connect that is not from its parent, not 3d-desk, without a port or from no origin', () => {
    const t = setup();
    t.bridge.start();
    t.connect({ source: {} });
    t.connect({ data: { protocol: 'other', type: 'connect', version: 1 } });
    t.connect({ data: { protocol: '3d-desk', type: 'hello', versions: [1] } });
    t.connect({ port: null });
    t.connect({ origin: 'null' });
    t.connect({ origin: 'file://' });
    t.dispatch({ data: 'connect', source: t.parent as unknown as MessageEventSource, origin: 'https://h.example' });
    expect(t.handler.connected).not.toHaveBeenCalled();
    // then a valid one works
    t.connect();
    expect(t.handler.connected).toHaveBeenCalledTimes(1);
  });

  it('refuses a version it does not speak on that port, and stays open for another connect', () => {
    const t = setup();
    t.bridge.start();
    const old = t.connect({ version: 2 })!;
    expect(old.posted).toHaveLength(1);
    expect(old.posted[0].message).toMatchObject({ type: 'error', code: 'unsupported_version' });
    expect(old.closed).toBe(true);
    expect(t.handler.connected).not.toHaveBeenCalled();
    t.connect({ version: 1 });
    expect(t.handler.connected).toHaveBeenCalledTimes(1);
  });

  it('passes valid messages on, ignores unknown ones and answers bad ones that carry an id', () => {
    const t = setup();
    t.bridge.start();
    const port = t.connect()!;
    port.emit({ type: 'save', id: 's-1' });
    expect(t.handler.message).toHaveBeenCalledWith({ type: 'save', id: 's-1' });
    port.emit({ type: 'frobnicate', id: 'x' });
    port.emit('save');
    port.emit({ type: 'save' });
    expect(port.posted).toEqual([]);
    port.emit({ type: 'export', id: 'e-1', modes: ['smell'] });
    expect(port.posted.map((p) => p.message)).toEqual([
      expect.objectContaining({ type: 'error', id: 'e-1', code: 'bad_message' }),
    ]);
    expect(t.handler.message).toHaveBeenCalledTimes(1);
    expect(t.log.info).toHaveBeenCalledWith(expect.stringContaining('frobnicate'));
  });

  it('sends on the port with its transfer list, and checks what it sends', () => {
    const t = setup();
    expect(t.bridge.send({ type: 'close', reason: 'done' })).toBe(false);
    t.bridge.start();
    const port = t.connect()!;
    const data = new ArrayBuffer(4);
    const state = { type: 'state', sceneId: 's', shots: 1, state: { format: '3d-editor.desk-state', version: 1, data } } as const;
    expect(t.bridge.send(state, [data])).toBe(true);
    expect(port.posted[0]).toEqual({ message: state, transfer: [data] });
    expect(t.log.warn).not.toHaveBeenCalled();
    t.bridge.send({ type: 'close', reason: 'later' } as never);
    expect(t.log.warn).toHaveBeenCalledWith(expect.stringContaining('not valid'));
    expect(port.posted).toHaveLength(2);
  });

  it('stops listening and closes the port', () => {
    const t = setup();
    t.bridge.start();
    const port = t.connect()!;
    expect(t.listeners.size).toBe(1);
    t.bridge.stop();
    expect(t.listeners.size).toBe(0);
    expect(port.closed).toBe(true);
    expect(t.bridge.connected).toBe(false);
  });

  it('takes http(s) origins as host origins', () => {
    expect(isHostOrigin('https://rideo.example')).toBe(true);
    expect(isHostOrigin('http://localhost:5173')).toBe(true);
    for (const o of ['null', '', 'file://', 'https://a.example/', 'chrome-extension://abc', 42]) expect(isHostOrigin(o)).toBe(false);
  });
});
