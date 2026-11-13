import 'fake-indexeddb/auto';

// happy-dom lacks a few browser APIs used by the editor
if (!('matchMedia' in globalThis)) {
  Object.assign(globalThis, {
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  });
}
(globalThis as unknown as { __APP_VERSION__: string }).__APP_VERSION__ = 'test';
