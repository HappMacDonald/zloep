// Animated-WebP helpers: RIFF parse/describe, muxer, delta bounding box.
const ascii = s => [...s].map(c => c.charCodeAt(0));
const u24 = n => [n & 255, (n >> 8) & 255, (n >> 16) & 255];
const u32 = n => [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255];
function cat(parts) {
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0)); let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
function chunk(tag, payload) {
  const p = payload instanceof Uint8Array ? payload : Uint8Array.from(payload);
  return cat([ascii(tag), u32(p.length), p, p.length & 1 ? [0] : []]);
}

// parseWebP(u8) -> [{tag, off, size}]  (off = payload offset). Throws if not RIFF/WEBP.
export function parseWebP(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const tag = o => String.fromCharCode(u8[o], u8[o+1], u8[o+2], u8[o+3]);
  if (u8.length < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WEBP') throw new Error('not RIFF/WEBP');
  const chunks = []; let o = 12;
  while (o + 8 <= u8.length) {
    const size = dv.getUint32(o + 4, true);
    chunks.push({ tag: tag(o), off: o + 8, size });
    o += 8 + size + (size & 1);
  }
  return chunks;
}

// describeWebP(u8) -> {top, flags, canvas:[w,h], loop, frames:[{x,y,w,h,dur,dispose,noBlend}]}
// dur is in ms. Absent fields are undefined for stills.
export function describeWebP(u8) {
  const ch = parseWebP(u8), dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const u24r = o => u8[o] | u8[o+1] << 8 | u8[o+2] << 16;
  const r = { top: ch.slice(0, 6).map(c => c.tag + ':' + c.size).join(' '), frames: [] };
  for (const c of ch) {
    if (c.tag === 'VP8X') { r.flags = u8[c.off]; r.canvas = [u24r(c.off + 4) + 1, u24r(c.off + 7) + 1]; }
    if (c.tag === 'ANIM') r.loop = dv.getUint16(c.off + 4, true);
    if (c.tag === 'ANMF') r.frames.push({
      x: u24r(c.off) * 2, y: u24r(c.off + 3) * 2, w: u24r(c.off + 6) + 1, h: u24r(c.off + 9) + 1,
      dur: u24r(c.off + 12), dispose: u8[c.off + 15] & 1, noBlend: (u8[c.off + 15] >> 1) & 1 });
  }
  return r;
}

// imageChunks(stillWebpBytes) -> bytes of just the ALPH/VP8/VP8L chunks (drops VP8X, ICCP, EXIF...).
export function imageChunks(u8) {
  return cat(parseWebP(u8).filter(c => ['VP8 ', 'VP8L', 'ALPH'].includes(c.tag))
    .map(c => chunk(c.tag, u8.subarray(c.off, c.off + c.size))));
}

// muxAnimWebP({width, height, loop=0, alpha=true, background=0, frames}) -> Uint8Array
//   frames[i] = {x, y, width, height, duration /*ms integer*/, data /*Uint8Array of a still .webp*/,
//                noBlend=true, dispose=false}
// x,y must be even. loop 0 = infinite. Throws on invalid input.
export function muxAnimWebP({ width, height, loop = 0, alpha = true, background = 0, frames }) {
  if (!frames.length) throw new Error('no frames');
  if (width < 1 || height < 1 || width > 16777216 || height > 16777216) throw new Error('bad canvas size');
  const anmfs = frames.map((f, i) => {
    const { x, y, width: w, height: h, duration: d, data } = f;
    if ((x | y) & 1) throw new Error(`frame ${i}: odd offset ${x},${y}`);
    if (x < 0 || y < 0 || x + w > width || y + h > height) throw new Error(`frame ${i}: outside canvas`);
    if (!Number.isInteger(d) || d < 0 || d > 0xFFFFFF) throw new Error(`frame ${i}: bad duration ${d}`);
    const flags = ((f.noBlend ?? true) ? 2 : 0) | (f.dispose ? 1 : 0);
    return chunk('ANMF', cat([u24(x / 2), u24(y / 2), u24(w - 1), u24(h - 1), u24(d), [flags], imageChunks(data)]));
  });
  const body = cat([ascii('WEBP'),
    chunk('VP8X', [0x02 | (alpha ? 0x10 : 0), 0, 0, 0, ...u24(width - 1), ...u24(height - 1)]),
    chunk('ANIM', [background & 255, (background >> 8) & 255, (background >> 16) & 255, (background >>> 24) & 255, loop & 255, loop >> 8]),
    ...anmfs]);
  return cat([ascii('RIFF'), u32(body.length), body]);
}

// diffBBox(a, b, w, h): a,b are Uint32Array views of RGBA pixels. -> {x0,y0,x1,y1} (x1,y1 exclusive) or null if identical.
export function diffBBox(a, b, w, h) {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0, i = y * w; x < w; x++, i++) if (a[i] !== b[i]) {
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return x1 < 0 ? null : { x0, y0, x1: x1 + 1, y1: y1 + 1 };
}
// alignEven(bb) -> bb with x0,y0 rounded down to even (WebP offset rule). Size grows accordingly.
export const alignEven = bb => ({ ...bb, x0: bb.x0 & ~1, y0: bb.y0 & ~1 });
