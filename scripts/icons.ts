/**
 * Generates the PWA icon set into `public/icons/`.
 *
 * The mark is a bookmark pennant on an ink field — drawn here in code rather than
 * committed as opaque binaries, so it can be re-rendered at any size and the shape
 * is reviewable in a diff. Run `npm run icons` after changing anything below.
 *
 * Sizes cover the three consumers: 192 and 512 for the web manifest (both also
 * emitted maskable, with the mark inside Android's 80% safe zone), and 180 for
 * iOS's apple-touch-icon, which ignores the manifest entirely.
 */
import { deflateSync } from 'node:zlib';
import { mkdir, writeFile } from 'node:fs/promises';

const INK = [0x12, 0x10, 0x0e] as const;
const PAPER = [0xfa, 0xf8, 0xf4] as const;

/** A minimal PNG encoder: one IHDR, one deflated IDAT of RGB rows, one IEND. */
function encodePng(width: number, height: number, rgb: Uint8Array): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc32 = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  // 10-12 are compression, filter and interlace — all zero.

  // Each scanline is prefixed with filter type 0 (None).
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    const src = y * width * 3;
    const dst = y * (1 + width * 3);
    raw[dst] = 0;
    Buffer.from(rgb.subarray(src, src + width * 3)).copy(raw, dst + 1);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Renders the mark at `size`, sampling 3x3 per pixel so the pennant's notch and
 * shoulders come out smooth rather than stepped.
 *
 * `inset` is the fraction of the canvas the mark is scaled down to. Maskable icons
 * pass 0.8 so the shape survives Android cropping it to a circle or squircle.
 */
function render(size: number, inset: number): Uint8Array {
  const out = new Uint8Array(size * size * 3);
  const SS = 3;

  // The pennant, in a 0..1 unit box: a tall rectangle with a triangular notch
  // taken out of the bottom edge.
  const inside = (ux: number, uy: number) => {
    if (ux < 0.28 || ux > 0.72 || uy < 0.14 || uy > 0.86) return false;
    // Notch: below the shoulder, the cut widens toward the centre.
    const notchTop = 0.62;
    if (uy <= notchTop) return true;
    const depth = (uy - notchTop) / (0.86 - notchTop);
    return Math.abs(ux - 0.5) > depth * 0.22;
  };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let hits = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          // Map the subpixel into the unit box, honouring the maskable inset.
          const px = (x + (sx + 0.5) / SS) / size;
          const py = (y + (sy + 0.5) / SS) / size;
          const ux = (px - 0.5) / inset + 0.5;
          const uy = (py - 0.5) / inset + 0.5;
          if (inside(ux, uy)) hits++;
        }
      }
      const a = hits / (SS * SS);
      const i = (y * size + x) * 3;
      for (let c = 0; c < 3; c++) {
        const ink = INK[c] as number;
        const paper = PAPER[c] as number;
        out[i + c] = Math.round(ink + (paper - ink) * a);
      }
    }
  }
  return out;
}

const TARGETS: Array<{ file: string; size: number; inset: number }> = [
  { file: 'icon-192.png', size: 192, inset: 1 },
  { file: 'icon-512.png', size: 512, inset: 1 },
  { file: 'icon-192-maskable.png', size: 192, inset: 0.8 },
  { file: 'icon-512-maskable.png', size: 512, inset: 0.8 },
  { file: 'apple-touch-icon.png', size: 180, inset: 1 },
];

await mkdir('public/icons', { recursive: true });
for (const { file, size, inset } of TARGETS) {
  const png = encodePng(size, size, render(size, inset));
  await writeFile(`public/icons/${file}`, png);
  console.log(`${file.padEnd(26)} ${size}x${size}  ${(png.length / 1024).toFixed(1)} KB`);
}
