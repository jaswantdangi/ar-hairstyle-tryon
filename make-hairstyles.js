/* Generate real alpha-transparent PNG hairstyle assets (no external deps).
   Draws simple stylized hairstyle silhouettes into an RGBA buffer and
   encodes a valid PNG with zlib. These are placeholders so the demo runs
   out-of-the-box — swap in real cut-out PNGs later (same filenames). */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const W = 512, H = 512;
const OUT = path.join(__dirname, 'hairstyles');
fs.mkdirSync(OUT, { recursive: true });

// ---- tiny PNG encoder (RGBA, 8-bit) ----
function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
function encodePNG(rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0; // 8-bit RGBA
  // add filter byte (0) per scanline
  const stride = W * 4;
  const raw = Buffer.alloc((stride + 1) * H);
  for (let y = 0; y < H; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// ---- simple software rasterizer ----
function newCanvas() { return Buffer.alloc(W * H * 4); } // all transparent (0,0,0,0)
function px(buf, x, y, r, g, b, a) {
  x |= 0; y |= 0;
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 4;
  const sa = a / 255, da = buf[i + 3] / 255;
  const oa = sa + da * (1 - sa);
  if (oa === 0) return;
  buf[i]     = (r * sa + buf[i]     * da * (1 - sa)) / oa;
  buf[i + 1] = (g * sa + buf[i + 1] * da * (1 - sa)) / oa;
  buf[i + 2] = (b * sa + buf[i + 2] * da * (1 - sa)) / oa;
  buf[i + 3] = oa * 255;
}
// Fill where predicate(x,y) true, with soft 1px edge via supersampling
function fill(buf, pred, [r, g, b]) {
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let hits = 0;
    for (let sy = 0; sy < 2; sy++) for (let sx = 0; sx < 2; sx++)
      if (pred(x + (sx + 0.5) / 2, y + (sy + 0.5) / 2)) hits++;
    if (hits) px(buf, x, y, r, g, b, Math.round((hits / 4) * 255));
  }
}

const cx = W / 2;

// Hairstyle shape predicates. Coordinates: head roughly centered, hair sits on top.
// We carve out a "face hole" (lower-center oval) so the hair frames the face.
function faceHole(x, y) {
  const dx = (x - cx) / 150, dy = (y - 300) / 200;
  return dx * dx + dy * dy < 1; // face oval region (kept transparent)
}

const styles = {
  // 1) Classic short — rounded cap hugging the top of the head
  'hairstyle-01': { color: [60, 42, 33], shape: (x, y) => {
    const dx = (x - cx) / 175, dy = (y - 230) / 175;
    const cap = dx * dx + dy * dy < 1 && y < 300;
    return cap && !(faceHole(x, y) && y > 200);
  }},
  // 2) Long wavy — falls down the sides past the cheeks
  'hairstyle-02': { color: [40, 26, 18], shape: (x, y) => {
    const dx = (x - cx) / 195, dy = (y - 250) / 230;
    const dome = dx * dx + dy * dy < 1;
    const sideWave = Math.abs(x - cx) > 110 && Math.abs(x - cx) < 200 && y < 430
      && (Math.sin(y / 28) * 12 + 150 > Math.abs(x - cx));
    return (dome && y < 320 || sideWave) && !faceHole(x, y);
  }},
  // 3) Curly afro — big soft circle with bumpy edge
  'hairstyle-03': { color: [25, 20, 18], shape: (x, y) => {
    const dx = x - cx, dy = y - 220;
    const r = Math.sqrt(dx * dx + dy * dy);
    const bumpy = 200 + Math.sin(Math.atan2(dy, dx) * 9) * 14;
    return r < bumpy && y < 340 && !(faceHole(x, y) && y > 230);
  }},
};

const manifest = [];
for (const [id, def] of Object.entries(styles)) {
  const buf = newCanvas();
  fill(buf, def.shape, def.color);
  // subtle top highlight
  fill(buf, (x, y) => {
    const dx = (x - cx + 40) / 90, dy = (y - 150) / 70;
    return dx * dx + dy * dy < 1 && def.shape(x, y);
  }, [def.color[0] + 35, def.color[1] + 30, def.color[2] + 25]);

  const png = encodePNG(buf);
  fs.writeFileSync(path.join(OUT, id + '.png'), png);
  console.log('wrote', id + '.png', png.length, 'bytes');
  manifest.push(id);
}
console.log('done:', manifest.join(', '));
