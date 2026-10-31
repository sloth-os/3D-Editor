import { useEffect, useRef, useState } from 'preact/hooks';
import type { ProjectSession } from '../project/session';
import { MenuButton } from './Menu';
import { UV_MENU } from '../editor/menus';

/** UV Editor: shows the UV layout of the edited mesh (selected faces highlighted) over its texture. */
export function UVEditor({ session: s }: { session: ProjectSession }) {
  void s.revision.value;
  const sel = s.state.$meshSelection.value;
  const mode = s.state.$mode.value;
  const ref = useRef<HTMLCanvasElement>(null);
  const [img, setImg] = useState<ImageBitmap | null>(null);
  const o = s.state.activeId ? s.doc.getObject(s.state.activeId) : null;
  const mesh = o?.type === 'MESH' && o.data ? s.doc.getMesh(o.data) : null;
  const mat = o?.material_slots[0] ? s.doc.getMaterial(o.material_slots[0]) : null;
  const texId = mat?.textures.base_color?.image ?? null;
  useEffect(() => {
    setImg(null);
    if (!texId) return;
    const bytes = s.doc.getImageBytes(texId);
    const info = s.doc.getImage(texId);
    if (!bytes || !info) return;
    let cancelled = false;
    void createImageBitmap(new Blob([bytes as BlobPart], { type: info.mime })).then(
      (b) => !cancelled && setImg(b),
    );
    return () => {
      cancelled = true;
    };
  }, [texId]);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    c.width = c.clientWidth * devicePixelRatio;
    c.height = c.clientHeight * devicePixelRatio;
    const g = c.getContext('2d');
    if (!g) return;
    g.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    const W = c.clientWidth;
    const H = c.clientHeight;
    g.fillStyle = '#2a2a2a';
    g.fillRect(0, 0, W, H);
    const size = Math.min(W, H) - 24;
    const ox = (W - size) / 2;
    const oy = (H - size) / 2;
    if (img) g.drawImage(img, ox, oy, size, size);
    else {
      for (let i = 0; i < 8; i++)
        for (let j = 0; j < 8; j++) {
          g.fillStyle = (i + j) % 2 ? '#3a3a3a' : '#333';
          g.fillRect(ox + (i * size) / 8, oy + (j * size) / 8, size / 8, size / 8);
        }
    }
    g.strokeStyle = '#666';
    g.strokeRect(ox, oy, size, size);
    if (!mesh?.uvs) {
      g.fillStyle = '#999';
      g.font = '12px system-ui';
      g.fillText(
        mesh ? 'No UV map — use UV › Unwrap in Edit Mode' : 'Select a mesh object',
        ox + 10,
        oy + 20,
      );
      return;
    }
    const onlySel = mode === 'EDIT' && sel.faces.size > 0;
    const P = (u: number, v: number) => [ox + u * size, oy + (1 - v) * size] as const;
    mesh.faces.forEach((f, fi) => {
      const uv = mesh.uvs![fi];
      if (!uv) return;
      const isSel = sel.faces.has(fi);
      if (onlySel && !isSel) return;
      g.beginPath();
      for (let i = 0; i < f.length; i++) {
        const [x, y] = P(uv[i * 2], uv[i * 2 + 1]);
        if (i === 0) g.moveTo(x, y);
        else g.lineTo(x, y);
      }
      g.closePath();
      if (isSel) {
        g.fillStyle = 'rgba(241,126,42,0.18)';
        g.fill();
      }
      g.strokeStyle = isSel ? '#f17e2a' : 'rgba(220,220,220,0.75)';
      g.lineWidth = 1;
      g.stroke();
    });
  });
  return (
    <div class="column" style={{ height: '100%' }} onPointerDown={(e) => e.stopPropagation()}>
      <div class="area-header">
        <MenuButton label="UV" items={UV_MENU} />
        <span class="hint">{mesh?.uvs ? `${mesh.faces.length} faces` : ''}</span>
      </div>
      <canvas ref={ref} style={{ flex: 1, width: '100%', minHeight: 0 }} data-testid="uv-editor" />
    </div>
  );
}
