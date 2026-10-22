// Generates public/icons/{icon-192,icon-512,maskable-512}.png and icon.svg
// without any image library (plain PNG encoder + zlib). Run: npm run icons
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');
mkdirSync(out, { recursive: true });

const INDIGO = [79, 70, 229];
const LILAC = [195, 192, 255];
const WHITE = [255, 255, 255];

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
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};

function png(size, pixel) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel((x + 0.5) / size, (y + 0.5) / size);
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
      raw[o + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// Signed distance to a rounded rectangle (normalised coords).
const roundRect = (x, y, x0, y0, x1, y1, r) => {
  const cx = Math.max(x0 + r, Math.min(x, x1 - r));
  const cy = Math.max(y0 + r, Math.min(y, y1 - r));
  return Math.hypot(x - cx, y - cy) - r;
};
const aa = (d, px) => Math.max(0, Math.min(1, 0.5 - d / px));
const mix = (base, col, a) => base.map((v, i) => Math.round(v + (col[i] - v) * a));

function art(size, maskable) {
  const px = 1 / size;
  // Maskable icons must fill the whole canvas; keep content inside the 80% safe zone.
  const s = maskable ? 0.78 : 1;
  const t = (v) => 0.5 + (v - 0.5) * s;
  return (x, y) => {
    let rgb = INDIGO;
    let alpha = 1;
    if (!maskable) alpha = aa(roundRect(x, y, 0, 0, 1, 1, 0.22), px);
    // back card
    const d1 = roundRect(x, y, t(0.24), t(0.28), t(0.68), t(0.60), 0.06 * s);
    rgb = mix(rgb, LILAC, aa(d1, px));
    // front card
    const d2 = roundRect(x, y, t(0.33), t(0.40), t(0.77), t(0.72), 0.06 * s);
    rgb = mix(rgb, WHITE, aa(d2, px));
    // accent line on the front card
    const d3 = roundRect(x, y, t(0.40), t(0.52), t(0.62), t(0.56), 0.02 * s);
    rgb = mix(rgb, INDIGO, aa(d3, px) * aa(d2, px));
    return [...rgb, Math.round(alpha * 255)];
  };
}

writeFileSync(join(out, 'icon-192.png'), png(192, art(192, false)));
writeFileSync(join(out, 'icon-512.png'), png(512, art(512, false)));
writeFileSync(join(out, 'maskable-512.png'), png(512, art(512, true)));
writeFileSync(
  join(out, 'icon.svg'),
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" rx="22" fill="#4f46e5"/><rect x="24" y="28" width="44" height="32" rx="6" fill="#c3c0ff"/><rect x="33" y="40" width="44" height="32" rx="6" fill="#fff"/><rect x="40" y="52" width="22" height="4" rx="2" fill="#4f46e5"/></svg>\n`,
);
console.log('icons written to', out);
