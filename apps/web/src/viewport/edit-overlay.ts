import * as THREE from 'three';
import {
  buildTopology,
  edgeKey,
  faceCenter,
  triangulateMesh,
  vertexCount,
  type MeshData,
  type MeshSelection,
  type SelectMode,
} from '@3d-editor/core';

const C_VERT = new THREE.Color(0x000000);
const C_SEL = new THREE.Color(0xf17e2a);
const C_EDGE = new THREE.Color(0x000000);
const C_FACE_DOT = new THREE.Color(0x111111);

/**
 * Edit-mode overlay: vertices, edges, selected-face tint and face dots for the edited mesh, plus
 * an invisible "cage" mesh used for raycasting and occlusion tests.
 */
export class EditOverlay {
  readonly group = new THREE.Group();
  readonly cage: THREE.Mesh;
  private points: THREE.Points;
  private lines: THREE.LineSegments;
  private faces: THREE.Mesh;
  private faceDots: THREE.Points;
  private key = '';
  triFace: number[] = [];
  edges: [number, number][] = [];

  constructor() {
    this.group.matrixAutoUpdate = false;
    this.group.renderOrder = 10;
    this.cage = new THREE.Mesh(
      new THREE.BufferGeometry(),
      new THREE.MeshBasicMaterial({ visible: false, side: THREE.DoubleSide }),
    );
    this.points = new THREE.Points(
      new THREE.BufferGeometry(),
      new THREE.PointsMaterial({ size: 6, sizeAttenuation: false, vertexColors: true, depthTest: true }),
    );
    this.lines = new THREE.LineSegments(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ vertexColors: true, depthTest: true }),
    );
    this.faces = new THREE.Mesh(
      new THREE.BufferGeometry(),
      new THREE.MeshBasicMaterial({
        color: C_SEL,
        transparent: true,
        opacity: 0.22,
        depthWrite: false,
        side: THREE.DoubleSide,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -1,
      }),
    );
    this.faceDots = new THREE.Points(
      new THREE.BufferGeometry(),
      new THREE.PointsMaterial({ size: 5, sizeAttenuation: false, vertexColors: true }),
    );
    this.points.renderOrder = 12;
    this.lines.renderOrder = 11;
    this.faceDots.renderOrder = 12;
    this.group.add(this.cage, this.faces, this.lines, this.points, this.faceDots);
    this.group.visible = false;
  }

  hide(): void {
    this.group.visible = false;
    this.key = '';
  }

  update(
    mesh: MeshData,
    sel: MeshSelection,
    mode: SelectMode,
    world: number[],
    xray: boolean,
    meshToken: string,
  ): void {
    this.group.visible = true;
    this.group.matrix.fromArray(world);
    this.group.matrixWorldNeedsUpdate = true;
    for (const m of [this.points.material, this.lines.material, this.faceDots.material] as THREE.Material[])
      m.depthTest = !xray;
    const key = `${meshToken}|${mode}|${sel.verts.size}|${sel.edges.size}|${sel.faces.size}|${hashSel(sel)}`;
    if (key === this.key) return;
    const geometryChanged = !this.key.startsWith(`${meshToken}|`);
    this.key = key;
    const n = vertexCount(mesh);
    const P = mesh.positions;
    if (geometryChanged) {
      const { indices, triFace } = triangulateMesh(mesh);
      this.triFace = triFace;
      const cg = new THREE.BufferGeometry();
      cg.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
      cg.setIndex(indices);
      cg.computeBoundingSphere();
      this.cage.geometry.dispose();
      this.cage.geometry = cg;
      this.edges = buildTopology(mesh).edges;
    }
    // vertices
    const vcol = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) (sel.verts.has(i) ? C_SEL : C_VERT).toArray(vcol, i * 3);
    const pg = new THREE.BufferGeometry();
    pg.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
    pg.setAttribute('color', new THREE.BufferAttribute(vcol, 3));
    this.points.geometry.dispose();
    this.points.geometry = pg;
    this.points.visible = mode === 'VERT';
    // edges
    const epos = new Float32Array(this.edges.length * 6);
    const ecol = new Float32Array(this.edges.length * 6);
    this.edges.forEach(([a, b], i) => {
      epos.set([P[a * 3], P[a * 3 + 1], P[a * 3 + 2], P[b * 3], P[b * 3 + 1], P[b * 3 + 2]], i * 6);
      const selected = sel.edges.has(edgeKey(a, b));
      if (mode === 'VERT') {
        (sel.verts.has(a) ? C_SEL : C_EDGE).toArray(ecol, i * 6);
        (sel.verts.has(b) ? C_SEL : C_EDGE).toArray(ecol, i * 6 + 3);
      } else {
        (selected ? C_SEL : C_EDGE).toArray(ecol, i * 6);
        (selected ? C_SEL : C_EDGE).toArray(ecol, i * 6 + 3);
      }
    });
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.BufferAttribute(epos, 3));
    lg.setAttribute('color', new THREE.BufferAttribute(ecol, 3));
    this.lines.geometry.dispose();
    this.lines.geometry = lg;
    // selected faces
    const fpos: number[] = [];
    for (let t = 0; t < this.triFace.length; t++) {
      if (!sel.faces.has(this.triFace[t])) continue;
      const idx = this.cage.geometry.index!;
      for (let k = 0; k < 3; k++) {
        const v = idx.getX(t * 3 + k);
        fpos.push(P[v * 3], P[v * 3 + 1], P[v * 3 + 2]);
      }
    }
    const fg = new THREE.BufferGeometry();
    fg.setAttribute('position', new THREE.Float32BufferAttribute(fpos, 3));
    this.faces.geometry.dispose();
    this.faces.geometry = fg;
    // face dots
    if (mode === 'FACE') {
      const dpos = new Float32Array(mesh.faces.length * 3);
      const dcol = new Float32Array(mesh.faces.length * 3);
      for (let f = 0; f < mesh.faces.length; f++) {
        dpos.set(faceCenter(mesh, f), f * 3);
        (sel.faces.has(f) ? C_SEL : C_FACE_DOT).toArray(dcol, f * 3);
      }
      const dg = new THREE.BufferGeometry();
      dg.setAttribute('position', new THREE.BufferAttribute(dpos, 3));
      dg.setAttribute('color', new THREE.BufferAttribute(dcol, 3));
      this.faceDots.geometry.dispose();
      this.faceDots.geometry = dg;
      this.faceDots.visible = true;
    } else this.faceDots.visible = false;
  }

  dispose(): void {
    for (const o of [this.cage, this.points, this.lines, this.faces, this.faceDots]) {
      o.geometry.dispose();
      (o.material as THREE.Material).dispose();
    }
  }
}

function hashSel(sel: MeshSelection): number {
  let h = 0;
  for (const v of sel.verts) h = (h * 31 + v) | 0;
  for (const f of sel.faces) h = (h * 17 + f) | 0;
  for (const e of sel.edges) for (let i = 0; i < e.length; i++) h = (h * 7 + e.charCodeAt(i)) | 0;
  return h;
}
