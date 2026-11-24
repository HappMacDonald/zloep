// checkEnv() -> {ok, problems[], warnings[], ua}   hard gate: refuse to run if !ok
export function checkEnv() {
  const problems = [], warnings = [];
  if (typeof ImageDecoder === 'undefined') problems.push('ImageDecoder missing (Chrome required)');
  if (typeof VideoFrame === 'undefined') problems.push('VideoFrame missing');
  if (typeof OffscreenCanvas === 'undefined') problems.push('OffscreenCanvas missing');
  if (!(globalThis.crypto && crypto.subtle)) problems.push('crypto.subtle missing (insecure context?)');
  if (typeof window.queryLocalFonts !== 'function') warnings.push('queryLocalFonts missing: no system font list');
  if (typeof window.showOpenFilePicker !== 'function') warnings.push('File System Access API missing');
  return { ok: !problems.length, problems, warnings, ua: navigator.userAgent };
}
// canvasProbe() -> {ok, bad}   solid opaque colours must read back exactly; run at startup AND before each export
export function canvasProbe() {
  const c = document.createElement('canvas'); c.width = c.height = 16;
  const x = c.getContext('2d', { willReadFrequently: true }); let bad = 0;
  for (const [r, g, b] of [[10, 200, 30], [255, 0, 255], [1, 2, 3]]) {
    x.fillStyle = `rgb(${r},${g},${b})`; x.fillRect(0, 0, 16, 16);
    const d = x.getImageData(0, 0, 16, 16).data;
    for (let i = 0; i < d.length; i += 4) if (d[i] !== r || d[i+1] !== g || d[i+2] !== b || d[i+3] !== 255) bad++;
  }
  return { ok: bad === 0, bad };
}
// loadLocalFonts() -> {status: 'ok'|'unsupported'|'empty'|'denied'|'error', fonts[], error?}
// Must be called from a user gesture. 'empty' = Chrome returned no fonts (observed when permission was denied).
export async function loadLocalFonts() {
  if (typeof window.queryLocalFonts !== 'function') return { status: 'unsupported', fonts: [] };
  try {
    const fonts = await queryLocalFonts();
    return { status: fonts.length ? 'ok' : 'empty', fonts };
  } catch (e) {
    return { status: (e.name === 'NotAllowedError' || e.name === 'SecurityError') ? 'denied' : 'error', fonts: [], error: String(e) };
  }
}
