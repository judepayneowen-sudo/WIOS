/*
 * Generates the WHOOP Core app/source icon as a 512×512 PNG — no native deps, just zlib,
 * so it runs the same locally and on the CI runner. Dark "void" background with a cyan
 * ECG pulse waveform, matching the in-app HUD palette.
 *   node tools/make-icon.mjs [outPath]   (default: dist/icon.png)
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const W = 512, H = 512;
const VOID = [0x04, 0x08, 0x0d], CYAN = [0x38, 0xe1, 0xff], BRIGHT = [0xbf, 0xf4, 0xff];
const px = new Uint8Array(W * H * 4);

function set(x, y, [r, g, b], a = 255) {
  x = x | 0; y = y | 0;
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 4;
  const ia = a / 255, ib = 1 - ia;
  px[i] = r * ia + px[i] * ib; px[i + 1] = g * ia + px[i + 1] * ib;
  px[i + 2] = b * ia + px[i + 2] * ib; px[i + 3] = 255;
}
function fill([r, g, b]) { for (let i = 0; i < W * H; i++) { px[i*4]=r; px[i*4+1]=g; px[i*4+2]=b; px[i*4+3]=255; } }
function disc(cx, cy, rad, col, a = 255) {
  for (let y = -rad; y <= rad; y++) for (let x = -rad; x <= rad; x++)
    if (x*x + y*y <= rad*rad) set(cx + x, cy + y, col, a);
}
function stroke(pts, rad, col) {            // round-capped polyline
  for (let s = 0; s < pts.length - 1; s++) {
    const [x0, y0] = pts[s], [x1, y1] = pts[s + 1];
    const steps = Math.ceil(Math.hypot(x1 - x0, y1 - y0));
    for (let t = 0; t <= steps; t++) disc(x0 + (x1 - x0) * t / steps, y0 + (y1 - y0) * t / steps, rad, col);
  }
}

fill(VOID);
// rounded border ring
for (let a = 0; a < 360; a += 0.25) { /* not a circle border; skip */ }
// ECG pulse: flat — small dip — tall spike — overshoot — flat, centered vertically
const cy = H / 2;
const wave = [
  [40, cy], [150, cy], [185, cy + 28], [215, cy - 150],
  [245, cy + 95], [275, cy], [360, cy], [400, cy + 40], [430, cy], [472, cy],
];
stroke(wave, 11, CYAN);     // glow body
stroke(wave, 4, BRIGHT);    // bright core
disc(215, cy - 150, 9, BRIGHT);  // peak node

/* ---- encode PNG (truecolor+alpha, filter 0 per scanline) ---- */
const CRC = (() => { const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (buf) => { let c = 0xFFFFFFFF; for (const b of buf) c = CRC[(c ^ b) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 6; // 8-bit, RGBA
const raw = Buffer.alloc((W * 4 + 1) * H);
for (let y = 0; y < H; y++) { raw[y * (W * 4 + 1)] = 0; px.subarray(y * W * 4, (y + 1) * W * 4).forEach((v, i) => raw[y * (W * 4 + 1) + 1 + i] = v); }
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
]);
const out = process.argv[2] || 'dist/icon.png';
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, png);
console.log(`wrote ${out} (${png.length} bytes, ${W}×${H})`);
