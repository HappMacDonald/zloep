// Project schema, immutable edit helpers, validation. All state is plain JSON.
import { lcm, tickRateFor, reduceFrac } from './time.js';
import { tableDuration } from './frametable.js';

export const PROJECT_VERSION = 1;

export function createProject({ width, height, fps = [30, 1] }) {
  fps = reduceFrac(fps[0], fps[1]);
  return {
    version: PROJECT_VERSION,
    settings: {
      width, height, fps,
      tickRate: tickRateFor(fps),      // always a multiple of lcm(1000, fps[0])
      crop: null,                      // {x,y,width,height} | null
      dilation: [1, 1],                // duration multiplier [num, den]
      output: { loop: 0, minDelayMs: 0, keyframeInterval: 0 },
    },
    media: [],                         // [{sha256,name,size,type,dimensions:[w,h],frameCount}]
    clips: [],                         // array order = layer order (last is on top)
    idSeq: 0,
  };
}

// ---- clip constructors (no id; addClip assigns one) ----
export const sequenceClip = o => ({
  kind: 'sequence', mediaHash: o.mediaHash, frames: o.frames,
  start: o.start ?? 0, x: o.x ?? 0, y: o.y ?? 0, alpha: o.alpha ?? 1,
});
export const rectClip = o => ({
  kind: 'rect', start: o.start ?? 0, duration: o.duration,
  x: o.x ?? 0, y: o.y ?? 0, width: o.width, height: o.height,
  fill: o.fill ?? '#000000', alpha: o.alpha ?? 1,
});
export const textClip = o => ({
  kind: 'text', start: o.start ?? 0, duration: o.duration,
  x: o.x ?? 0, y: o.y ?? 0, text: o.text ?? '',
  fontFamily: o.fontFamily ?? 'sans-serif', fontSize: o.fontSize ?? 32,
  fontWeight: o.fontWeight ?? 'normal', fill: o.fill ?? '#ffffff',
  outline: o.outline ?? null,          // {color,width} | null
  shadow: o.shadow ?? null,            // {color,blur,dx,dy} | null
  alpha: o.alpha ?? 1,
});

// ---- derived time ----
export const clipDuration = c => c.kind === 'sequence' ? tableDuration(c.frames) : c.duration;
export const clipEnd = c => c.start + clipDuration(c);
export const projectDuration = p => p.clips.reduce((m, c) => Math.max(m, clipEnd(c)), 0);

// ---- immutable edits (each returns a new project) ----
export function addClip(project, clip) {
  const id = 'c' + (project.idSeq + 1);
  return { project: { ...project, idSeq: project.idSeq + 1, clips: [...project.clips, { ...clip, id }] }, id };
}
export function replaceClip(project, id, clip) {
  if (!project.clips.some(c => c.id === id)) throw new Error('no clip ' + id);
  return { ...project, clips: project.clips.map(c => c.id === id ? { ...clip, id } : c) };
}
export function updateClip(project, id, patch) {
  const c = project.clips.find(c => c.id === id);
  if (!c) throw new Error('no clip ' + id);
  return replaceClip(project, id, { ...c, ...patch });
}
export function removeClip(project, id) {
  return { ...project, clips: project.clips.filter(c => c.id !== id) };
}

// Change the editing grid. tickRate only ever grows, by an exact integer factor k,
// so every stored tick is multiplied by k with no rounding.
export function setFps(project, fps) {
  fps = reduceFrac(fps[0], fps[1]);
  const old = project.settings.tickRate;
  const next = lcm(old, tickRateFor(fps));
  const k = next / old;
  const scale = c => {
    if (k === 1) return c;
    if (c.kind === 'sequence') {
      return { ...c, start: c.start * k, frames: c.frames.map(f => ({ ...f, durationTicks: f.durationTicks * k })) };
    }
    return { ...c, start: c.start * k, duration: c.duration * k };
  };
  return { ...project, settings: { ...project.settings, fps, tickRate: next }, clips: project.clips.map(scale) };
}

// ---- validation: {errors:[], warnings:[]} ----
export function validateProject(p) {
  const errors = [], warnings = [];
  const err = m => errors.push(m);
  const int = Number.isInteger, pos = n => int(n) && n > 0, nn = n => int(n) && n >= 0;
  const fin = n => typeof n === 'number' && Number.isFinite(n);
  if (!p || typeof p !== 'object') return { errors: ['project is not an object'], warnings };
  if (p.version !== PROJECT_VERSION) err(`version must be ${PROJECT_VERSION}`);

  const s = p.settings;
  if (!s || typeof s !== 'object') { err('settings missing'); return { errors, warnings }; }
  if (!pos(s.width) || !pos(s.height)) err('settings.width/height must be positive integers');
  if (!Array.isArray(s.fps) || s.fps.length !== 2 || !pos(s.fps[0]) || !pos(s.fps[1])) err('settings.fps must be [num, den] positive integers');
  if (!pos(s.tickRate) || s.tickRate % 1000 !== 0) err('settings.tickRate must be a positive multiple of 1000');
  else if (Array.isArray(s.fps) && pos(s.fps[0]) && s.tickRate % s.fps[0] !== 0) err('settings.tickRate must be a multiple of fps numerator');
  if (!Array.isArray(s.dilation) || s.dilation.length !== 2 || !pos(s.dilation[0]) || !pos(s.dilation[1])) err('settings.dilation must be [num, den] positive integers');
  if (s.crop !== null) {
    const c = s.crop;
    if (!c || !nn(c.x) || !nn(c.y) || !pos(c.width) || !pos(c.height)) err('settings.crop must be null or {x,y,width,height} integers');
    else if (c.x + c.width > s.width || c.y + c.height > s.height) err('settings.crop extends outside the canvas');
  }
  const o = s.output;
  if (!o || !nn(o.loop) || !nn(o.minDelayMs) || !nn(o.keyframeInterval)) err('settings.output needs non-negative integers loop, minDelayMs, keyframeInterval');

  const media = new Map();
  if (!Array.isArray(p.media)) err('media must be an array');
  else p.media.forEach((m, i) => {
    if (!m || typeof m.sha256 !== 'string' || !m.sha256) return err(`media[${i}]: sha256 missing`);
    if (media.has(m.sha256)) err(`media[${i}]: duplicate sha256`);
    media.set(m.sha256, m);
    if (!pos(m.frameCount)) err(`media[${i}]: frameCount must be a positive integer`);
    if (!Array.isArray(m.dimensions) || !pos(m.dimensions[0]) || !pos(m.dimensions[1])) err(`media[${i}]: dimensions must be [w,h]`);
  });

  if (!Array.isArray(p.clips)) { err('clips must be an array'); return { errors, warnings }; }
  const ids = new Set();
  p.clips.forEach((c, i) => {
    const at = `clips[${i}]${c && c.id ? '(' + c.id + ')' : ''}`;
    const e = m => err(`${at}: ${m}`);
    if (!c || typeof c !== 'object') return e('not an object');
    if (typeof c.id !== 'string' || !c.id) e('id missing'); else if (ids.has(c.id)) e('duplicate id'); else ids.add(c.id);
    if (!nn(c.start)) e('start must be a non-negative integer');
    if (!fin(c.alpha) || c.alpha < 0 || c.alpha > 1) e('alpha must be a number in 0..1');
    if (c.kind === 'sequence' || c.kind === 'text' || c.kind === 'rect') {
      if (!int(c.x) || !int(c.y)) e('x and y must be integers');
    }
    if (c.kind === 'sequence') {
      const m = media.get(c.mediaHash);
      if (!m) e('unknown media ' + c.mediaHash);
      if (!Array.isArray(c.frames) || !c.frames.length) return e('frames must be a non-empty array');
      c.frames.forEach((f, j) => {
        if (!f || !nn(f.sourceFrame)) e(`frames[${j}].sourceFrame must be a non-negative integer`);
        else if (m && pos(m.frameCount) && f.sourceFrame >= m.frameCount) warnings.push(`${at}: frames[${j}].sourceFrame ${f.sourceFrame} is out of range (media has ${m.frameCount})`);
        if (!f || !pos(f.durationTicks)) e(`frames[${j}].durationTicks must be a positive integer`);
      });
    } else if (c.kind === 'text') {
      if (!pos(c.duration)) e('duration must be a positive integer');
      if (typeof c.text !== 'string') e('text must be a string');
      if (typeof c.fontFamily !== 'string' || !c.fontFamily) e('fontFamily missing');
      if (!pos(c.fontSize)) e('fontSize must be a positive integer');
      if (typeof c.fill !== 'string') e('fill must be a string');
      if (c.outline !== null && !(c.outline && typeof c.outline.color === 'string' && fin(c.outline.width) && c.outline.width > 0)) e('outline must be null or {color,width>0}');
      if (c.shadow !== null && !(c.shadow && typeof c.shadow.color === 'string' && fin(c.shadow.blur) && fin(c.shadow.dx) && fin(c.shadow.dy))) e('shadow must be null or {color,blur,dx,dy}');
    } else if (c.kind === 'rect') {
      if (!pos(c.duration)) e('duration must be a positive integer');
      if (!pos(c.width) || !pos(c.height)) e('width/height must be positive integers');
      if (typeof c.fill !== 'string') e('fill must be a string');
    } else e('unknown kind ' + JSON.stringify(c.kind));
  });
  return { errors, warnings };
}
