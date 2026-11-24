'use strict';
const $ = s => document.querySelector(s);
const sleep = ms => new Promise(r => setTimeout(r, ms));
function log(...a) {
  $('#out').textContent += a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ') + '\n';
}
const fmtB = n => n < 1024 ? n + ' B' : n < 1048576 ? (n/1024).toFixed(1) + ' KiB' : (n/1048576).toFixed(2) + ' MiB';
const f1 = n => +n.toFixed(1);
function stats(a) {
  const s = [...a].sort((x, y) => x - y), q = p => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { n: s.length, mean: f1(s.reduce((x, y) => x + y, 0) / s.length), p50: f1(q(.5)), p95: f1(q(.95)), max: f1(s[s.length - 1]) };
}
async function sha256hex(buf) {
  const d = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}
function onFile(sel, fn) {
  $(sel).addEventListener('change', e => {
    const f = e.target.files[0];
    if (f) fn(f).catch(err => log('ERROR', String(err && err.stack || err)));
  });
}
function mkCanvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
const ctx2d = c => c.getContext('2d', { willReadFrequently: true });
const toBlob = (c, type, q) => new Promise((res, rej) => c.toBlob(b => b ? res(b) : rej(new Error('toBlob gave null')), type, q));
function cmpRGBA(a, b) { // two ImageData
  let n = 0, max = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    let d = 0;
    for (let k = 0; k < 4; k++) d = Math.max(d, Math.abs(a.data[i + k] - b.data[i + k]));
    if (d) { n++; if (d > max) max = d; }
  }
  return { diffPixels: n, maxDiff: max };
}
// ---- RIFF / WebP ----
function parseWebP(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const tag = o => String.fromCharCode(u8[o], u8[o+1], u8[o+2], u8[o+3]);
  if (tag(0) !== 'RIFF' || tag(8) !== 'WEBP') throw new Error('not RIFF/WEBP');
  const chunks = []; let o = 12;
  while (o + 8 <= u8.length) {
    const sz = dv.getUint32(o + 4, true);
    chunks.push({ tag: tag(o), off: o + 8, size: sz });
    o += 8 + sz + (sz & 1);
  }
  return chunks;
}
function describeWebP(u8) {
  const ch = parseWebP(u8), dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const u24 = o => u8[o] | u8[o+1] << 8 | u8[o+2] << 16;
  const r = { top: ch.slice(0, 6).map(c => c.tag + ':' + c.size).join(' '), frames: [] };
  for (const c of ch) {
    if (c.tag === 'VP8X') { r.flags = u8[c.off]; r.canvas = [u24(c.off + 4) + 1, u24(c.off + 7) + 1]; }
    if (c.tag === 'ANIM') r.loop = dv.getUint16(c.off + 4, true);
    if (c.tag === 'ANMF') r.frames.push({
      x: u24(c.off) * 2, y: u24(c.off + 3) * 2, w: u24(c.off + 6) + 1, h: u24(c.off + 9) + 1,
      dur: u24(c.off + 12), dispose: u8[c.off + 15] & 1, noBlend: (u8[c.off + 15] >> 1) & 1 });
  }
  return r;
}
function envReport() {
  log('UA', navigator.userAgent);
  const c = mkCanvas(16, 16), x = ctx2d(c);
  x.fillStyle = 'rgb(10,200,30)'; x.fillRect(0, 0, 16, 16);
  const d = x.getImageData(0, 0, 16, 16).data; let bad = 0;
  for (let i = 0; i < d.length; i += 4) if (d[i] !== 10 || d[i+1] !== 200 || d[i+2] !== 30 || d[i+3] !== 255) bad++;
  log('canvas readback of solid opaque colour:', bad ? `CORRUPTED (${bad}/256 px), fingerprint protection?` : 'exact');
  const t = []; for (let i = 0; i < 20; i++) { const a = performance.now(); for (let k = 0; k < 1e5; k++); t.push(performance.now() - a); }
  log('timer: ' + new Set(t.map(v => v.toFixed(3))).size + ' distinct values in 20 samples (1-3 = clamped)');
  log('ImageDecoder', typeof ImageDecoder, '| VideoFrame', typeof VideoFrame, '| OffscreenCanvas', typeof OffscreenCanvas);
}
envReport();
