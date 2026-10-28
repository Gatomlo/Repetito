// Genere les icones PWA (PNG) sans dependance externe : encodeur PNG minimal + glyphe "R" en bitmap.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const CRC_TABLE = (() => {
  const t = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}
function encodePNG(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8; ihdrData[9] = 6; ihdrData[10] = 0; ihdrData[11] = 0; ihdrData[12] = 0;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (width * 4 + 1);
    raw[rowStart] = 0;
    rgba.copy(raw, rowStart + 1, y * width * 4, (y + 1) * width * 4);
  }
  const idatData = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdrData), chunk('IDAT', idatData), chunk('IEND', Buffer.alloc(0))]);
}

// Glyphe "R" en bitmap 5x7 (bords toujours nets, pas besoin d'anti-aliasing)
const R_GLYPH = [
  [1, 1, 1, 1, 0],
  [1, 0, 0, 0, 1],
  [1, 0, 0, 0, 1],
  [1, 1, 1, 1, 0],
  [1, 0, 1, 0, 0],
  [1, 0, 0, 1, 0],
  [1, 0, 0, 0, 1],
];

function generateIcon(size) {
  const bg = [138, 33, 69, 255]; // accent
  const fg = [255, 255, 255, 255];
  const buf = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i++) buf.set(bg, i * 4);
  const gw = 5, gh = 7;
  const block = Math.max(1, Math.floor((size * 0.62) / gh));
  const glyphW = block * gw, glyphH = block * gh;
  const ox = Math.floor((size - glyphW) / 2);
  const oy = Math.floor((size - glyphH) / 2);
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      if (!R_GLYPH[gy][gx]) continue;
      const x0 = ox + gx * block, y0 = oy + gy * block;
      for (let y = y0; y < y0 + block; y++) {
        for (let x = x0; x < x0 + block; x++) {
          if (x < 0 || x >= size || y < 0 || y >= size) continue;
          buf.set(fg, (y * size + x) * 4);
        }
      }
    }
  }
  return encodePNG(size, size, buf);
}

const outDir = path.join(__dirname, '..', 'public', 'icons');
fs.mkdirSync(outDir, { recursive: true });
[180, 192, 512].forEach((size) => {
  const png = generateIcon(size);
  fs.writeFileSync(path.join(outDir, `icon-${size}.png`), png);
  console.log('icon-' + size + '.png', png.length, 'octets');
});
