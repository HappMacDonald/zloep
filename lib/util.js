export const sleep = ms => new Promise(r => setTimeout(r, ms));
export const fmtB = n => n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KiB' : (n / 1048576).toFixed(2) + ' MiB';
const f1 = n => +n.toFixed(1);
// stats(array of numbers) -> {n, mean, p50, p95, max}
export function stats(a) {
  const s = [...a].sort((x, y) => x - y), q = p => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { n: s.length, mean: f1(s.reduce((x, y) => x + y, 0) / s.length), p50: f1(q(.5)), p95: f1(q(.95)), max: f1(s[s.length - 1]) };
}
// sha256hex(ArrayBuffer | TypedArray | Blob) -> lowercase hex string
export async function sha256hex(data) {
  if (data instanceof Blob) data = await data.arrayBuffer();
  const d = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}
