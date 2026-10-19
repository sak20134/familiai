// Draws the app icon from the pixel cat in src/renderer/pixelcat.json:
//   build/icon.png  512x512, used on Mac and Linux
//   build/icon.ico  Windows icon with 16..256 px sizes, so the packager never has to convert a
//                   picture itself (that step can run out of memory on some computers)
// Plain Node only: a tiny PNG/ICO writer, no image libraries.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const SIZE = 512;
const cat = JSON.parse(readFileSync(new URL('../src/renderer/pixelcat.json', import.meta.url), 'utf8'));
const rows = cat.rows;
const scale = Math.floor(SIZE / rows.length);
const offset = Math.floor((SIZE - scale * rows.length) / 2);
const rgba = Buffer.alloc(SIZE * SIZE * 4); // transparent

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
rows.forEach((row, y) => [...row].forEach((ch, x) => {
  const colour = cat.palette[ch];
  if (!colour) return;
  const [r, g, b] = hex(colour);
  for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
    const i = ((offset + y * scale + dy) * SIZE + offset + x * scale + dx) * 4;
    rgba[i] = r; rgba[i + 1] = g; rgba[i + 2] = b; rgba[i + 3] = 255;
  }
}));

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body));
  return Buffer.concat([len, body, sum]);
};

/** A PNG of `size` x `size` pixels, made from the 512 px picture by averaging blocks of pixels. */
function png(size) {
  const px = size === SIZE ? rgba : Buffer.alloc(size * size * 4);
  if (size !== SIZE) {
    const f = SIZE / size;
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let dy = 0; dy < f; dy++) for (let dx = 0; dx < f; dx++) {
        const i = ((y * f + dy) * SIZE + x * f + dx) * 4;
        const w = rgba[i + 3];
        r += rgba[i] * w; g += rgba[i + 1] * w; b += rgba[i + 2] * w; a += w;
      }
      const o = (y * size + x) * 4;
      if (a > 0) { px[o] = Math.round(r / a); px[o + 1] = Math.round(g / a); px[o + 2] = Math.round(b / a); px[o + 3] = Math.round(a / (f * f)); }
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

/** A Windows .ico holding one PNG per size (the format Windows has accepted since Vista). */
function ico(sizes) {
  const images = sizes.map((s) => png(s));
  const head = Buffer.alloc(6 + 16 * sizes.length);
  head.writeUInt16LE(1, 2); // type: icon
  head.writeUInt16LE(sizes.length, 4);
  let at = head.length;
  sizes.forEach((s, i) => {
    const e = 6 + 16 * i;
    head[e] = s === 256 ? 0 : s; head[e + 1] = s === 256 ? 0 : s; // 0 means 256
    head.writeUInt16LE(1, e + 4); head.writeUInt16LE(32, e + 6);
    head.writeUInt32LE(images[i].length, e + 8); head.writeUInt32LE(at, e + 12);
    at += images[i].length;
  });
  return Buffer.concat([head, ...images]);
}

mkdirSync(new URL('../build/', import.meta.url), { recursive: true });
const big = png(SIZE);
writeFileSync(new URL('../build/icon.png', import.meta.url), big);
const small = ico([256, 128, 64, 48, 32, 16]);
writeFileSync(new URL('../build/icon.ico', import.meta.url), small);
console.log(`build/icon.png ${SIZE}x${SIZE} (${big.length} bytes), build/icon.ico (${small.length} bytes)`);
