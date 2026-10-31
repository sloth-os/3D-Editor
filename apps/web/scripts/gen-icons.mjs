// Generates the PWA PNG icons (an original isometric-cube logo) without external dependencies.
// Usage: node apps/web/scripts/gen-icons.mjs
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const crcTable = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
const hex = (s) => [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16), 255];
function inside(poly, x, y) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}
function roundedRect(x, y, r, size) {
  const cx = Math.min(Math.max(x, r), size - r);
  const cy = Math.min(Math.max(y, r), size - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}
function render(size, { maskable }) {
  const s = size / 512;
  const scale = maskable ? 0.72 : 1;
  const off = maskable ? (512 * (1 - scale)) / 2 : 0;
  const P = (pts) => pts.map(([x, y]) => [(x * scale + off) * s, (y * scale + off) * s]);
  const shapes = [
    [P([[256, 88], [400, 171], [256, 254], [112, 171]]), hex('#f5a04a')],
    [P([[112, 171], [256, 254], [256, 420], [112, 337]]), hex('#e87d0d')],
    [P([[400, 171], [256, 254], [256, 420], [400, 337]]), hex('#b35f0a')],
  ];
  const bg = hex('#232323');
  const out = Buffer.alloc(size * size * 4);
  const SS = 4;
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const acc = [0, 0, 0, 0];
      for (let sy = 0; sy < SS; sy++)
        for (let sx = 0; sx < SS; sx++) {
          const px = x + (sx + 0.5) / SS;
          const py = y + (sy + 0.5) / SS;
          let col = maskable || roundedRect(px, py, 96 * s, size) ? bg : [0, 0, 0, 0];
          for (const [poly, c] of shapes) if (inside(poly, px, py)) col = c;
          for (let k = 0; k < 4; k++) acc[k] += col[k];
        }
      for (let k = 0; k < 4; k++) out[(y * size + x) * 4 + k] = Math.round(acc[k] / (SS * SS));
    }
  return png(size, size, out);
}
const dir = new URL('../public/icons/', import.meta.url);
writeFileSync(new URL('icon-192.png', dir), render(192, { maskable: false }));
writeFileSync(new URL('icon-512.png', dir), render(512, { maskable: false }));
writeFileSync(new URL('icon-maskable-512.png', dir), render(512, { maskable: true }));
console.log('icons written');
