import type { Vec2 } from '../math/types';
import type { SceneDoc } from '../doc/scene-doc';
import type { MaterialData, MaterialTextureChannel } from '../doc/types';
import type { MeshData } from '../mesh/types';
import { createMesh, edgeKey } from '../mesh/types';
import { linearToSrgb, srgbToLinear } from '../render/color';
import { toYUp, toZUp } from './axes';
import { forEachLine, fmtNum, lookupFile, restOfLine, splitWs, utf8Decode, utf8Encode } from './bytes';
import { bakeWorldMesh, collectExport, cornerNormals } from './common';
import { readImageInfo } from './image-info';
import type { ExportOptions, ExportResult, ImportOptions, ImportResult } from './types';

/*
 * Wavefront OBJ. Files are Y-up (converted to/from the editor's Z-up like Blender's default
 * "forward −Z, up Y"). Import turns every `o`/`g` block into its own object; `usemtl` creates
 * material slots (materials are created by name, with MTL properties when the library is supplied
 * through `ImportOptions.files`); `s` drives smooth shading; `l` lines become loose edges.
 * Export writes world-space evaluated meshes with UVs, split normals and `usemtl` per object.
 */

interface ObjGroup {
  name: string;
  nameSource: 'default' | 'o' | 'g';
  faceStart: number[];
  cornerV: number[];
  cornerT: number[];
  cornerN: number[];
  faceMat: number[];
  faceSmooth: number[];
  lines: number[];
  points: number[];
}

interface ParsedObj {
  groups: ObjGroup[];
  positions: number[];
  /** RGBA per vertex as written in the file (sRGB), or null when the file has no vertex colors. */
  colors: number[] | null;
  texcoords: number[];
  normals: number[];
  materials: string[];
  mtllibs: string[];
  smoothingSeen: boolean;
  warnings: string[];
}

function newGroup(name: string, nameSource: ObjGroup['nameSource']): ObjGroup {
  return {
    name,
    nameSource,
    faceStart: [],
    cornerV: [],
    cornerT: [],
    cornerN: [],
    faceMat: [],
    faceSmooth: [],
    lines: [],
    points: [],
  };
}

function hasGeometry(g: ObjGroup): boolean {
  return g.faceStart.length > 0 || g.lines.length > 0 || g.points.length > 0;
}

/** Resolves a 1-based (or negative, relative) OBJ index; returns -1 when invalid. */
function resolveIndex(tok: string, count: number): number {
  const i = parseInt(tok, 10);
  if (!Number.isFinite(i) || i === 0) return -1;
  const r = i < 0 ? count + i : i - 1;
  return r >= 0 && r < count ? r : -1;
}

function parseOBJ(text: string, defaultName: string): ParsedObj {
  const out: ParsedObj = {
    groups: [],
    positions: [],
    colors: null,
    texcoords: [],
    normals: [],
    materials: [],
    mtllibs: [],
    smoothingSeen: false,
    warnings: [],
  };
  const matIndex = new Map<string, number>();
  let group = newGroup(defaultName, 'default');
  let curMat = -1;
  let curSmooth = 0;
  let badFaces = 0;
  const unsupported = new Set<string>();
  const tok: string[] = [];
  let pending = '';

  const startGroup = (name: string, source: 'o' | 'g') => {
    if (hasGeometry(group)) {
      out.groups.push(group);
      group = newGroup(name || defaultName, source);
    } else if (source === 'o' || group.nameSource !== 'o') {
      if (name) group.name = name;
      group.nameSource = source;
    }
  };

  forEachLine(text, (raw) => {
    let line = raw;
    if (pending) {
      line = pending + line;
      pending = '';
    }
    if (line.endsWith('\\')) {
      pending = line.slice(0, -1) + ' ';
      return;
    }
    const n = splitWs(line, tok);
    if (n === 0) return;
    const key = tok[0];
    if (key.charCodeAt(0) === 35) return; // '#'
    switch (key) {
      case 'v': {
        out.positions.push(parseFloat(tok[1]) || 0, parseFloat(tok[2]) || 0, parseFloat(tok[3]) || 0);
        if (n >= 7) {
          if (!out.colors) out.colors = new Array((out.positions.length / 3 - 1) * 4).fill(1);
          out.colors.push(
            parseFloat(tok[4]) || 0,
            parseFloat(tok[5]) || 0,
            parseFloat(tok[6]) || 0,
            n >= 8 ? parseFloat(tok[7]) || 0 : 1,
          );
        } else if (out.colors) out.colors.push(1, 1, 1, 1);
        break;
      }
      case 'vt':
        out.texcoords.push(parseFloat(tok[1]) || 0, n > 2 ? parseFloat(tok[2]) || 0 : 0);
        break;
      case 'vn':
        out.normals.push(parseFloat(tok[1]) || 0, parseFloat(tok[2]) || 0, parseFloat(tok[3]) || 0);
        break;
      case 'f':
      case 'fo': {
        const nv = out.positions.length / 3;
        const nt = out.texcoords.length / 2;
        const nn = out.normals.length / 3;
        const v: number[] = [];
        const t: number[] = [];
        const nr: number[] = [];
        let ok = n >= 4;
        for (let i = 1; i < n && ok; i++) {
          const s = tok[i];
          const a = s.indexOf('/');
          const vi = resolveIndex(a < 0 ? s : s.slice(0, a), nv);
          let ti = -1;
          let ni = -1;
          if (a >= 0) {
            const b = s.indexOf('/', a + 1);
            const ts = b < 0 ? s.slice(a + 1) : s.slice(a + 1, b);
            if (ts) ti = resolveIndex(ts, nt);
            if (b >= 0 && b + 1 < s.length) ni = resolveIndex(s.slice(b + 1), nn);
            if ((ts && ti < 0) || (b >= 0 && b + 1 < s.length && ni < 0)) ok = false;
          }
          if (vi < 0) ok = false;
          v.push(vi);
          t.push(ti);
          nr.push(ni);
        }
        if (!ok) {
          badFaces++;
          break;
        }
        group.faceStart.push(group.cornerV.length);
        for (let i = 0; i < v.length; i++) {
          group.cornerV.push(v[i]);
          group.cornerT.push(t[i]);
          group.cornerN.push(nr[i]);
        }
        group.faceMat.push(curMat);
        group.faceSmooth.push(curSmooth);
        break;
      }
      case 'l': {
        const nv = out.positions.length / 3;
        let prev = -1;
        for (let i = 1; i < n; i++) {
          const s = tok[i];
          const a = s.indexOf('/');
          const vi = resolveIndex(a < 0 ? s : s.slice(0, a), nv);
          if (vi < 0) {
            prev = -1;
            continue;
          }
          if (prev >= 0 && prev !== vi) group.lines.push(prev, vi);
          else if (n === 2) group.points.push(vi);
          prev = vi;
        }
        break;
      }
      case 'p': {
        const nv = out.positions.length / 3;
        for (let i = 1; i < n; i++) {
          const vi = resolveIndex(tok[i], nv);
          if (vi >= 0) group.points.push(vi);
        }
        break;
      }
      case 'o':
        startGroup(restOfLine(line), 'o');
        break;
      case 'g':
        startGroup(restOfLine(line), 'g');
        break;
      case 's': {
        out.smoothingSeen = true;
        const v = (tok[1] ?? 'off').toLowerCase();
        curSmooth = v === 'off' || v === '0' ? 0 : v === 'on' ? 1 : Math.max(0, parseInt(v, 10) || 0);
        break;
      }
      case 'usemtl': {
        const name = restOfLine(line);
        if (!name || name === 'None' || name === '(null)') curMat = -1;
        else {
          let i = matIndex.get(name);
          if (i === undefined) {
            i = out.materials.length;
            out.materials.push(name);
            matIndex.set(name, i);
          }
          curMat = i;
        }
        break;
      }
      case 'mtllib':
        out.mtllibs.push(restOfLine(line));
        break;
      case 'vp':
      case 'cstype':
      case 'curv':
      case 'curv2':
      case 'surf':
        unsupported.add('free-form curves/surfaces');
        break;
      default:
        break;
    }
  });
  if (hasGeometry(group)) out.groups.push(group);
  if (badFaces) out.warnings.push(`${badFaces} face(s) with invalid indices skipped`);
  for (const u of unsupported) out.warnings.push(`OBJ ${u} are not supported and were skipped`);
  return out;
}

interface BuiltGroup {
  name: string;
  mesh: MeshData;
  /** Global material index per slot (null = empty slot). */
  slots: (number | null)[];
}

function buildGroups(p: ParsedObj): { built: BuiltGroup[]; skipped: number } {
  const nPos = p.positions.length / 3;
  const localOf = new Int32Array(nPos).fill(-1);
  const built: BuiltGroup[] = [];
  let skipped = 0;
  for (const g of p.groups) {
    const F = g.faceStart.length;
    const hasUV = g.cornerT.some((t) => t >= 0);
    const faces: number[][] = [];
    const uvs: number[][] = [];
    const faceSmooth: boolean[] = [];
    const faceMatGlobal: number[] = [];
    for (let f = 0; f < F; f++) {
      const s = g.faceStart[f];
      const e = f + 1 < F ? g.faceStart[f + 1] : g.cornerV.length;
      // drop repeated corners (consecutive and closing)
      const cs: number[] = [];
      for (let c = s; c < e; c++) if (!cs.length || g.cornerV[cs[cs.length - 1]] !== g.cornerV[c]) cs.push(c);
      while (cs.length > 1 && g.cornerV[cs[0]] === g.cornerV[cs[cs.length - 1]]) cs.pop();
      if (cs.length < 3 || new Set(cs.map((c) => g.cornerV[c])).size !== cs.length) {
        skipped++;
        continue;
      }
      faces.push(cs.map((c) => g.cornerV[c]));
      if (hasUV) {
        const uv: number[] = [];
        for (const c of cs) {
          const t = g.cornerT[c];
          uv.push(t >= 0 ? p.texcoords[t * 2] : 0, t >= 0 ? p.texcoords[t * 2 + 1] : 0);
        }
        uvs.push(uv);
      }
      let smooth: boolean;
      if (p.smoothingSeen) smooth = g.faceSmooth[f] > 0;
      else {
        // No smoothing groups: faces whose corner normals differ were exported smooth.
        smooth = false;
        const n0 = g.cornerN[cs[0]];
        if (n0 >= 0) {
          for (const c of cs) {
            const ni = g.cornerN[c];
            if (ni < 0) break;
            if (
              Math.abs(p.normals[ni * 3] - p.normals[n0 * 3]) > 1e-4 ||
              Math.abs(p.normals[ni * 3 + 1] - p.normals[n0 * 3 + 1]) > 1e-4 ||
              Math.abs(p.normals[ni * 3 + 2] - p.normals[n0 * 3 + 2]) > 1e-4
            ) {
              smooth = true;
              break;
            }
          }
        }
      }
      faceSmooth.push(smooth);
      faceMatGlobal.push(g.faceMat[f]);
    }
    // referenced vertices keep their file order
    const local: number[] = [];
    const use = (gi: number) => {
      if (localOf[gi] < 0) {
        localOf[gi] = 0;
        local.push(gi);
      }
    };
    for (const face of faces) for (const v of face) use(v);
    for (const v of g.lines) use(v);
    for (const v of g.points) use(v);
    local.sort((a, b) => a - b);
    for (let i = 0; i < local.length; i++) localOf[local[i]] = i;
    for (const face of faces) for (let i = 0; i < face.length; i++) face[i] = localOf[face[i]];
    // loose edges (not coinciding with face edges)
    const faceEdges = new Set<string>();
    for (const face of faces)
      for (let i = 0; i < face.length; i++) faceEdges.add(edgeKey(face[i], face[(i + 1) % face.length]));
    const looseEdges: number[] = [];
    for (let i = 0; i < g.lines.length; i += 2) {
      const a = localOf[g.lines[i]];
      const b = localOf[g.lines[i + 1]];
      const k = edgeKey(a, b);
      if (a === b || faceEdges.has(k)) continue;
      faceEdges.add(k);
      looseEdges.push(a, b);
    }
    // material slots in order of first use
    const slotOf = new Map<number, number>();
    for (const m of faceMatGlobal) if (!slotOf.has(m)) slotOf.set(m, slotOf.size);
    const onlyNone = slotOf.size === 0 || (slotOf.size === 1 && slotOf.has(-1));
    const slots: (number | null)[] = onlyNone ? [] : [...slotOf.keys()].map((m) => (m < 0 ? null : m));
    const positions = new Array<number>(local.length * 3);
    for (let i = 0; i < local.length; i++) {
      const gi = local[i];
      const z = toZUp([p.positions[gi * 3], p.positions[gi * 3 + 1], p.positions[gi * 3 + 2]]);
      positions[i * 3] = z[0];
      positions[i * 3 + 1] = z[1];
      positions[i * 3 + 2] = z[2];
    }
    let colors: number[] | null = null;
    if (p.colors) {
      colors = new Array<number>(local.length * 4);
      for (let i = 0; i < local.length; i++) {
        const gi = local[i];
        for (let k = 0; k < 3; k++)
          colors[i * 4 + k] = srgbToLinear(Math.min(1, Math.max(0, p.colors[gi * 4 + k])));
        colors[i * 4 + 3] = p.colors[gi * 4 + 3];
      }
    }
    for (const gi of local) localOf[gi] = -1;
    if (local.length === 0) continue;
    built.push({
      name: g.name,
      slots,
      mesh: createMesh({
        positions,
        faces,
        faceMaterials: onlyNone ? faces.map(() => 0) : faceMatGlobal.map((m) => slotOf.get(m)!),
        faceSmooth,
        uvs: hasUV ? uvs : null,
        colors,
        looseEdges,
      }),
    });
  }
  return { built, skipped };
}

// ------------------------------------------------------------------ MTL

interface MtlDef {
  props: Partial<MaterialData>;
  maps: { channel: MaterialTextureChannel; file: string; scale: Vec2; offset: Vec2 }[];
}

function parseMTL(text: string): Map<string, MtlDef> {
  const out = new Map<string, MtlDef>();
  let cur: MtlDef | null = null;
  let hasD = false;
  const tok: string[] = [];
  forEachLine(text, (line) => {
    const n = splitWs(line, tok);
    if (n === 0 || tok[0].startsWith('#')) return;
    const key = tok[0].toLowerCase();
    if (key === 'newmtl') {
      cur = { props: {}, maps: [] };
      hasD = false;
      out.set(restOfLine(line), cur);
      return;
    }
    if (!cur) return;
    const c: MtlDef = cur;
    const num = (i: number) => parseFloat(tok[i]) || 0;
    switch (key) {
      case 'kd':
        c.props.base_color = [num(1), num(2), num(3), 1];
        break;
      case 'ke': {
        const e: [number, number, number] = [num(1), num(2), num(3)];
        if (e[0] > 0 || e[1] > 0 || e[2] > 0) {
          c.props.emission_color = e;
          c.props.emission_strength = 1;
        }
        break;
      }
      case 'ns':
        if (c.props.roughness === undefined)
          c.props.roughness = 1 - Math.sqrt(Math.min(1000, Math.max(0, num(1))) / 1000);
        break;
      case 'pr':
        c.props.roughness = Math.min(1, Math.max(0, num(1)));
        break;
      case 'pm':
        c.props.metallic = Math.min(1, Math.max(0, num(1)));
        break;
      case 'ni':
        if (num(1) > 0) c.props.ior = num(1);
        break;
      case 'd':
        hasD = true;
        c.props.alpha = Math.min(1, Math.max(0, num(1)));
        break;
      case 'tr':
        if (!hasD) c.props.alpha = 1 - Math.min(1, Math.max(0, num(1)));
        break;
      default: {
        const channel: Partial<Record<string, MaterialTextureChannel>> = {
          map_kd: 'base_color',
          map_ke: 'emission',
          map_bump: 'normal',
          bump: 'normal',
          norm: 'normal',
          map_pr: 'roughness',
          map_pm: 'metallic',
          map_d: 'alpha',
        };
        const ch = channel[key];
        if (!ch) break;
        const scale: Vec2 = [1, 1];
        const offset: Vec2 = [0, 0];
        let i = 1;
        while (i < n && tok[i].startsWith('-')) {
          const opt = tok[i].toLowerCase();
          if (opt === '-s') {
            scale[0] = parseFloat(tok[i + 1]) || 1;
            scale[1] = parseFloat(tok[i + 2]) || 1;
            i += 4;
          } else if (opt === '-o') {
            offset[0] = parseFloat(tok[i + 1]) || 0;
            offset[1] = parseFloat(tok[i + 2]) || 0;
            i += 4;
          } else if (opt === '-bm') {
            c.props.normal_strength = parseFloat(tok[i + 1]) || 1;
            i += 2;
          } else if (
            opt === '-clamp' ||
            opt === '-blendu' ||
            opt === '-blendv' ||
            opt === '-imfchan' ||
            opt === '-texres' ||
            opt === '-type'
          )
            i += 2;
          else if (opt === '-mm') i += 3;
          else i += 1;
        }
        // Option arguments may be fewer than assumed (e.g. "-s 2 2"); keep at least the last token.
        const file = tok.slice(Math.min(i, n - 1), n).join(' ');
        if (file) c.maps.push({ channel: ch, file, scale, offset });
      }
    }
  });
  for (const def of out.values())
    if (def.props.alpha !== undefined && def.props.alpha < 1) def.props.blend_method = 'BLEND';
  return out;
}

// ------------------------------------------------------------------ import

export function importOBJ(doc: SceneDoc, data: Uint8Array, opts: ImportOptions = {}): ImportResult {
  const parsed = parseOBJ(utf8Decode(data), opts.name ?? 'Mesh');
  const warnings = [...parsed.warnings];
  const { built, skipped } = buildGroups(parsed);
  if (skipped) warnings.push(`${skipped} degenerate face(s) skipped`);
  // material libraries (only when supplied as companion files)
  const mtl = new Map<string, MtlDef>();
  for (const lib of parsed.mtllibs) {
    const bytes = lookupFile(opts.files, lib);
    if (!bytes) {
      warnings.push(`Material library '${lib}' not provided; materials were created by name only`);
      continue;
    }
    for (const [k, v] of parseMTL(utf8Decode(bytes))) mtl.set(k, v);
  }
  if (built.length === 0) {
    warnings.push('OBJ file contains no geometry');
    return { objects: [], warnings };
  }
  const offset = opts.location ?? [0, 0, 0];
  return doc.transact(() => {
    const matIds = new Map<number, string>();
    const images = new Map<Uint8Array, string>();
    const material = (gi: number): string => {
      let id = matIds.get(gi);
      if (id) return id;
      const name = parsed.materials[gi];
      const def = mtl.get(name);
      const textures: MaterialData['textures'] = {};
      for (const map of def?.maps ?? []) {
        const bytes = lookupFile(opts.files, map.file);
        if (!bytes) {
          warnings.push(`Texture '${map.file}' not provided`);
          continue;
        }
        let img = images.get(bytes);
        if (!img) {
          const info = readImageInfo(bytes);
          if (!info) warnings.push(`Texture '${map.file}' has an unrecognised image format`);
          img = doc.addImage({
            name: map.file.replace(/\\/g, '/').split('/').pop() || 'Image',
            mime: info?.mime ?? 'application/octet-stream',
            width: info?.width ?? 0,
            height: info?.height ?? 0,
            data: bytes,
          });
          images.set(bytes, img);
        }
        textures[map.channel] = { image: img, scale: map.scale, offset: map.offset };
      }
      id = doc.addMaterial({ ...(def?.props ?? {}), name, textures });
      matIds.set(gi, id);
      return id;
    };
    const objects: string[] = [];
    for (const b of built) {
      const meshId = doc.addMesh(b.name, b.mesh);
      const id = doc.addObject({
        type: 'MESH',
        name: b.name,
        data: meshId,
        location: [offset[0], offset[1], offset[2]],
        material_slots: b.slots.map((s) => (s === null ? null : material(s))),
      });
      objects.push(id);
    }
    return { objects, warnings };
  });
}

// ------------------------------------------------------------------ export

function objName(s: string): string {
  return s.replace(/[\r\n]+/g, ' ').trim() || 'Object';
}

function mtlName(s: string): string {
  return s.replace(/\s+/g, '_') || 'Material';
}

export function exportOBJ(doc: SceneDoc, opts: ExportOptions = {}): ExportResult {
  const { items } = collectExport(doc, opts);
  const lines: string[] = ['# 3D-Editor OBJ export', `# ${doc.name}`];
  let vBase = 0;
  let tBase = 0;
  let nBase = 0;
  let written: string | null = null;
  let smoothState: boolean | null = null;
  let count = 0;
  for (const it of items) {
    if (!it.mesh || it.mesh.positions.length === 0) continue;
    const mesh = bakeWorldMesh(it.mesh, it.ev.worldMatrix);
    if (mesh.faces.length === 0 && mesh.looseEdges.length === 0) continue;
    count++;
    lines.push(`o ${objName(it.ev.name)}`);
    const p = mesh.positions;
    const nv = p.length / 3;
    const colors = mesh.colors && mesh.colors.length === nv * 4 ? mesh.colors : null;
    for (let i = 0; i < nv; i++) {
      const y = toYUp([p[i * 3], p[i * 3 + 1], p[i * 3 + 2]]);
      let s = `v ${fmtNum(y[0])} ${fmtNum(y[1])} ${fmtNum(y[2])}`;
      if (colors)
        s += ` ${fmtNum(linearToSrgb(colors[i * 4]), 4)} ${fmtNum(linearToSrgb(colors[i * 4 + 1]), 4)} ${fmtNum(linearToSrgb(colors[i * 4 + 2]), 4)}`;
      lines.push(s);
    }
    // texture coordinates (deduplicated)
    const tIndex = new Map<string, number>();
    const faceT: number[][] = [];
    if (mesh.uvs) {
      for (const uv of mesh.uvs) {
        const ids: number[] = [];
        for (let i = 0; i < uv.length; i += 2) {
          const k = `${fmtNum(uv[i])} ${fmtNum(uv[i + 1])}`;
          let t = tIndex.get(k);
          if (t === undefined) {
            t = tIndex.size;
            tIndex.set(k, t);
            lines.push(`vt ${k}`);
          }
          ids.push(t);
        }
        faceT.push(ids);
      }
    }
    // split normals (deduplicated)
    const cn = cornerNormals(mesh);
    const nIndex = new Map<string, number>();
    const faceN: number[][] = [];
    let c = 0;
    for (const face of mesh.faces) {
      const ids: number[] = [];
      for (let i = 0; i < face.length; i++, c++) {
        const y = toYUp([cn[c * 3], cn[c * 3 + 1], cn[c * 3 + 2]]);
        const k = `${fmtNum(y[0], 4)} ${fmtNum(y[1], 4)} ${fmtNum(y[2], 4)}`;
        let n = nIndex.get(k);
        if (n === undefined) {
          n = nIndex.size;
          nIndex.set(k, n);
          lines.push(`vn ${k}`);
        }
        ids.push(n);
      }
      faceN.push(ids);
    }
    for (let f = 0; f < mesh.faces.length; f++) {
      const mat = it.materials[mesh.faceMaterials[f]] ?? null;
      const name = mat ? mtlName(mat.name) : null;
      if (name !== written) {
        lines.push(`usemtl ${name ?? 'None'}`);
        written = name;
      }
      const smooth = !!mesh.faceSmooth[f];
      if (smooth !== smoothState) {
        lines.push(smooth ? 's 1' : 's 0');
        smoothState = smooth;
      }
      const face = mesh.faces[f];
      let s = 'f';
      for (let i = 0; i < face.length; i++) {
        const v = face[i] + vBase + 1;
        const n = faceN[f][i] + nBase + 1;
        s += mesh.uvs ? ` ${v}/${faceT[f][i] + tBase + 1}/${n}` : ` ${v}//${n}`;
      }
      lines.push(s);
    }
    for (let i = 0; i < mesh.looseEdges.length; i += 2)
      lines.push(`l ${mesh.looseEdges[i] + vBase + 1} ${mesh.looseEdges[i + 1] + vBase + 1}`);
    vBase += nv;
    tBase += tIndex.size;
    nBase += nIndex.size;
  }
  lines.splice(2, 0, `# ${count} object(s)`);
  lines.push('');
  const warnings = count ? [] : ['No mesh objects to export'];
  return { data: utf8Encode(lines.join('\n')), mime: 'model/obj', extension: 'obj', warnings };
}
