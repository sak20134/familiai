// Draws the app icon (build/icon.png, 512x512) from the pixel cat in src/renderer/pixelcat.json.
// Plain Node only: a tiny PNG writer, no image libraries. The packager turns it into .ico / .icns.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const SIZE = 512;
const cat = JSON.parse(readFileSync(new URL('../src/renderer/pixelcat.json', import.meta.url), 'utf8'));
const rows = cat.rows;
const scale = Math.floor(SIZE / rows.length); // 21 px per cat pixel
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
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0); ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
for (let y = 0; y < SIZE; y++) rgba.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
mkdirSync(new URL('../build/', import.meta.url), { recursive: true });
writeFileSync(new URL('../build/icon.png', import.meta.url), png);
console.log(`build/icon.png ${SIZE}x${SIZE} (${png.length} bytes)`);
