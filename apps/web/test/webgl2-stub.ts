/*
 * A stand-in WebGL2 context that three.js's own WebGLRenderer runs on (the test environment has no
 * WebGL): it draws nothing, but three.js's bookkeeping runs as in a browser (shader program cache
 * and release, renderer.info, render targets, textures), and it counts the shader programs linked
 * and deleted. Constants are distinct numbers per name; queries answer like a capable GPU.
 */

/** What the stand-in recorded. */
export interface WebGL2Stub {
  gl: WebGL2RenderingContext;
  /** Shader programs linked (gl.linkProgram) and deleted (gl.deleteProgram). */
  links: number;
  deletes: number;
}

const FLOAT_EXTENSIONS = [
  'EXT_color_buffer_float',
  'EXT_color_buffer_half_float',
  'OES_texture_float_linear',
];

const LIMITS: Record<string, number> = {
  MAX_SAMPLES: 4,
  MAX_TEXTURE_IMAGE_UNITS: 16,
  MAX_VERTEX_TEXTURE_IMAGE_UNITS: 16,
  MAX_COMBINED_TEXTURE_IMAGE_UNITS: 32,
  MAX_VERTEX_ATTRIBS: 16,
  MAX_DRAW_BUFFERS: 8,
  MAX_COLOR_ATTACHMENTS: 8,
  MAX_UNIFORM_BUFFER_BINDINGS: 24,
};

export function createWebGL2Stub(canvas: HTMLCanvasElement): WebGL2Stub {
  const names = new Map<string, number>();
  const byValue = new Map<number, string>();
  /** The value of a constant: distinct per name (three.js only compares and passes them on). */
  const constant = (name: string) => {
    let v = names.get(name);
    if (v === undefined) {
      v = 0x8000 + names.size;
      names.set(name, v);
      byValue.set(v, name);
    }
    return v;
  };
  const stub: WebGL2Stub = { gl: null as unknown as WebGL2RenderingContext, links: 0, deletes: 0 };
  const object = () => ({});
  const target: Record<string, unknown> = {
    canvas,
    drawingBufferWidth: 1,
    drawingBufferHeight: 1,
    drawingBufferColorSpace: 'srgb',
    getContextAttributes: () => ({
      alpha: true,
      antialias: true,
      depth: true,
      stencil: false,
      premultipliedAlpha: true,
      preserveDrawingBuffer: true,
      powerPreference: 'default',
      failIfMajorPerformanceCaveat: false,
    }),
    isContextLost: () => false,
    getError: () => 0,
    // float render targets (three.js warns without them); no parallel shader compile (three.js then
    // links on first use, as SwiftShader does in effect)
    getExtension: (name: string) => (FLOAT_EXTENSIONS.includes(name) ? {} : null),
    getSupportedExtensions: () => [],
    getParameter(p: number) {
      const name = byValue.get(p) ?? '';
      if (name === 'VERSION') return 'WebGL 2.0';
      if (name === 'SHADING_LANGUAGE_VERSION') return 'WebGL GLSL ES 3.00';
      if (name === 'VIEWPORT' || name === 'SCISSOR_BOX') return new Int32Array([0, 0, 1, 1]);
      if (name in LIMITS) return LIMITS[name];
      if (name.startsWith('MAX_')) return 4096;
      return 0;
    },
    getShaderPrecisionFormat: () => ({ precision: 23, rangeMin: 127, rangeMax: 127 }),
    createShader: object,
    createProgram: object,
    createTexture: object,
    createBuffer: object,
    createFramebuffer: object,
    createRenderbuffer: object,
    createVertexArray: object,
    createQuery: object,
    fenceSync: object,
    getSyncParameter: () => constant('SIGNALED'),
    clientWaitSync: () => constant('ALREADY_SIGNALED'),
    getShaderParameter: () => true,
    getShaderInfoLog: () => '',
    getShaderSource: () => '',
    getProgramParameter: () => 0,
    getProgramInfoLog: () => '',
    getActiveUniform: () => null,
    getActiveAttrib: () => null,
    getUniformLocation: object,
    getAttribLocation: () => -1,
    checkFramebufferStatus: () => constant('FRAMEBUFFER_COMPLETE'),
    linkProgram() {
      stub.links++;
    },
    deleteProgram() {
      stub.deletes++;
    },
  };
  // a program links (LINK_STATUS) and has no active uniforms or attributes
  target.getProgramParameter = (_p: unknown, pname: number) =>
    byValue.get(pname) === 'LINK_STATUS' ? true : 0;
  const noop = () => undefined;
  stub.gl = new Proxy(target, {
    get(t, name) {
      if (typeof name !== 'string') return undefined;
      if (name in t) return t[name];
      if (/^[A-Z][A-Z0-9_]*$/.test(name)) return constant(name);
      return noop;
    },
  }) as unknown as WebGL2RenderingContext;
  return stub;
}
