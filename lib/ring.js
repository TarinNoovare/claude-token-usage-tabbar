'use strict';

// Renders a small circular "ring gauge" PNG (like Claude's usage indicator):
// a faint full track plus a solid arc that sweeps clockwise from 12 o'clock,
// full ring == 100%. Pure Node stdlib — hand-rolls the PNG (zlib + CRC32), no deps.

const zlib = require('node:zlib');

// --- CRC32 (for PNG chunks) ---

let CRC_TABLE = null;
function crcTable() {
  if (CRC_TABLE) return CRC_TABLE;
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  CRC_TABLE = t;
  return t;
}
function crc32(buf) {
  const t = crcTable();
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = t[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// --- minimal PNG encoder (8-bit RGBA, single IDAT, no filtering) ---

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  // 10,11,12 = compression/filter/interlace = 0
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    sig,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function hexToRgb(hex) {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

// Render the ring. pct 0..100, hexColor like '#4a90d9', size in px (square).
// Returns a base64 PNG string (no data: prefix) for SwiftBar's `image=`.
function ringPngBase64(pct, hexColor, size) {
  size = size || 36;
  const [r, g, b] = hexToRgb(hexColor);
  // Canvas HEIGHT is the scaling reference: the host (SwiftBar, or the native
  // app's @2x image) scales the whole canvas to the menu-bar row height, and
  // the ring occupies only DIAMETER_FRAC of that height (transparent top/bottom
  // margin) so its diameter lands close to the adjacent "%" text's digit
  // height rather than the full row height.
  // Canvas WIDTH is trimmed to just wider than the ring, so there's little empty
  // space between the ring and the % text beside it.
  const DIAMETER_FRAC = 0.6;
  const height = size;
  const outer = (height * DIAMETER_FRAC) / 2;
  const thickness = outer * 0.42;
  const inner = outer - thickness;
  const sideMargin = Math.max(1, height * 0.02);
  const width = Math.ceil(2 * outer + 2 * sideMargin);
  const cx = width / 2;
  const cy = height / 2;
  const fillAngle = (Math.max(0, Math.min(100, pct)) / 100) * 360;

  const SS = 4; // supersampling per axis for smooth edges
  const total = SS * SS;
  const rgba = Buffer.alloc(width * height * 4);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let band = 0; // subsamples inside the ring band
      let arc = 0; // ...of those, subsamples within the swept arc
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const dx = x + (sx + 0.5) / SS - cx;
          const dy = y + (sy + 0.5) / SS - cy;
          const d = Math.sqrt(dx * dx + dy * dy);
          if (d >= inner && d <= outer) {
            band++;
            let ang = (Math.atan2(dx, -dy) * 180) / Math.PI; // 0 at top, clockwise
            if (ang < 0) ang += 360;
            if (ang <= fillAngle) arc++;
          }
        }
      }
      const idx = (y * width + x) * 4;
      if (band === 0) {
        rgba[idx + 3] = 0;
        continue;
      }
      // Same hue everywhere; empty track is faint, swept arc is solid.
      const trackFrac = (band - arc) / total;
      const arcFrac = arc / total;
      const alpha = trackFrac * 0.28 + arcFrac * 1.0;
      rgba[idx] = r;
      rgba[idx + 1] = g;
      rgba[idx + 2] = b;
      rgba[idx + 3] = Math.round(alpha * 255);
    }
  }

  return encodePng(width, height, rgba).toString('base64');
}

module.exports = { ringPngBase64 };
