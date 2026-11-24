// Command layer: commands are plain JSON, applied by pure functions.
//   run(project, cmd)   -> {project, result}
//   apply(project, cmd) -> project
// Every command is validated after applying (validateProject errors => CommandError).
// A `batch` is atomic and validated once at the end, so intermediate states may be invalid.
// Assumes the INPUT project is valid (import must reject invalid projects).
import { validateProject, replaceClip, setFps, clipDuration, clipEnd } from './project.js';
import { tableStarts, frameIndexAt } from './frametable.js';

export class CommandError extends Error {
  constructor(msg) { super(msg); this.name = 'CommandError'; }
}
const need = (cond, msg) => { if (!cond) throw new CommandError(msg); };
const clone = v => structuredClone(v);

function findClip(p, id) {
  const c = p.clips.find(c => c.id === id);
  need(c, `no clip with id ${JSON.stringify(id)}`);
  return c;
}
function allocId(p) {
  const ids = new Set(p.clips.map(c => c.id));
  let n = p.idSeq + 1;
  while (ids.has('c' + n)) n++;
  return { id: 'c' + n, idSeq: n };
}
const insertAt = (arr, index, item) => [...arr.slice(0, index), item, ...arr.slice(index)];

const SETTINGS_KEYS = ['width', 'height', 'crop', 'dilation', 'output'];

// Handlers return [project, result].
const handlers = {
  setSettings(p, { patch }) {
    need(patch && typeof patch === 'object', 'setSettings needs a patch object');
    for (const k of Object.keys(patch)) need(SETTINGS_KEYS.includes(k), `settings.${k} cannot be set here (use setFps for fps/tickRate)`);
    const s = { ...p.settings, ...clone(patch) };
    if (patch.output) s.output = { ...p.settings.output, ...clone(patch.output) };
    return [{ ...p, settings: s }];
  },

  setFps(p, { fps }) {
    need(Array.isArray(fps) && fps.length === 2 && fps.every(n => Number.isInteger(n) && n > 0), 'fps must be [num, den] positive integers');
    return [setFps(p, fps)];
  },

  addMedia(p, { entry }) {
    need(entry && typeof entry.sha256 === 'string', 'addMedia needs entry.sha256');
    if (p.media.some(m => m.sha256 === entry.sha256)) return [p];       // idempotent
    return [{ ...p, media: [...p.media, clone(entry)] }];
  },

  removeMedia(p, { sha256 }) {
    need(p.media.some(m => m.sha256 === sha256), 'media not in manifest');
    need(!p.clips.some(c => c.kind === 'sequence' && c.mediaHash === sha256), 'media is still referenced by a clip');
    return [{ ...p, media: p.media.filter(m => m.sha256 !== sha256) }];
  },

  // Rebind every reference from -> entry.sha256. outOfRange: 'flag' (leave; validate warns) | 'clamp'.
  rebindMedia(p, { from, entry, outOfRange = 'flag' }) {
    need(entry && typeof entry.sha256 === 'string', 'rebindMedia needs entry.sha256');
    need(from !== entry.sha256, 'rebind source and target are the same media');
    need(p.media.some(m => m.sha256 === from), 'rebind source not in manifest');
    need(outOfRange === 'flag' || outOfRange === 'clamp', "outOfRange must be 'flag' or 'clamp'");
    const to = entry.sha256, max = entry.frameCount - 1;
    const clips = p.clips.map(c => {
      if (c.kind !== 'sequence' || c.mediaHash !== from) return c;
      const frames = outOfRange === 'clamp'
        ? c.frames.map(f => f.sourceFrame > max ? { ...f, sourceFrame: max } : f)
        : c.frames;
      return { ...c, mediaHash: to, frames };
    });
    const media = p.media.filter(m => m.sha256 !== from);
    if (!media.some(m => m.sha256 === to)) media.push(clone(entry));
    return [{ ...p, media, clips }];
  },

  addClip(p, { clip, index }) {
    need(clip && typeof clip === 'object', 'addClip needs a clip');
    const at = index ?? p.clips.length;
    need(Number.isInteger(at) && at >= 0 && at <= p.clips.length, 'addClip index out of range');
    const { id, idSeq } = allocId(p);
    return [{ ...p, idSeq, clips: insertAt(p.clips, at, { ...clone(clip), id }) }, id];
  },

  removeClip(p, { id }) {
    findClip(p, id);
    return [{ ...p, clips: p.clips.filter(c => c.id !== id) }];
  },

  replaceClip(p, { id, clip }) {
    const old = findClip(p, id);
    need(clip && clip.kind === old.kind, 'replaceClip cannot change a clip\'s kind');
    return [replaceClip(p, id, clone(clip))];
  },

  patchClip(p, { id, patch }) {
    const old = findClip(p, id);
    need(patch && typeof patch === 'object', 'patchClip needs a patch object');
    need(!('id' in patch) && !('kind' in patch), 'patchClip cannot change id or kind');
    return [replaceClip(p, id, { ...old, ...clone(patch) })];
  },

  reorderClip(p, { id, toIndex }) {
    const c = findClip(p, id);
    need(Number.isInteger(toIndex) && toIndex >= 0 && toIndex < p.clips.length, 'reorderClip toIndex out of range');
    const rest = p.clips.filter(x => x.id !== id);
    return [{ ...p, clips: insertAt(rest, toIndex, c) }];
  },

  setFrames(p, { id, frames }) {
    const c = findClip(p, id);
    need(c.kind === 'sequence', 'setFrames only applies to sequence clips');
    need(Array.isArray(frames), 'frames must be an array');
    return [replaceClip(p, id, { ...c, frames: clone(frames) })];
  },

  // Split at absolute tick `at`, strictly inside the clip. Left keeps the id; right is new and
  // sits directly above it in layer order. A frame entry containing `at` is divided in two.
  splitClip(p, { id, at }) {
    const c = findClip(p, id);
    need(Number.isInteger(at) && at > c.start && at < clipEnd(c), `split point must be strictly inside the clip (${c.start}..${clipEnd(c)})`);
    let left, right;
    if (c.kind === 'sequence') {
      const off = at - c.start, starts = tableStarts(c.frames), i = frameIndexAt(c.frames, off);
      let lf, rf;
      if (starts[i] === off) { lf = c.frames.slice(0, i); rf = c.frames.slice(i); }
      else {
        const a = { ...c.frames[i], durationTicks: off - starts[i] };
        const b = { ...c.frames[i], durationTicks: starts[i + 1] - off };
        lf = [...c.frames.slice(0, i), a]; rf = [b, ...c.frames.slice(i + 1)];
      }
      left = { ...c, frames: lf }; right = { ...clone(c), frames: rf, start: at };
    } else {
      left = { ...c, duration: at - c.start };
      right = { ...clone(c), start: at, duration: clipEnd(c) - at };
    }
    const { id: rid, idSeq } = allocId(p);
    right.id = rid;
    const idx = p.clips.findIndex(x => x.id === id);
    const clips = p.clips.map(x => x.id === id ? left : x);
    return [{ ...p, idSeq, clips: insertAt(clips, idx + 1, right) }, { leftId: id, rightId: rid }];
  },

  batch(p, { commands }) {
    need(Array.isArray(commands), 'batch needs a commands array');
    const results = [];
    for (const cmd of commands) { const [np, r] = step(p, cmd); p = np; results.push(r); }
    return [p, results];
  },
};

function step(project, cmd) {
  need(cmd && typeof cmd.type === 'string', 'command needs a type');
  const h = handlers[cmd.type];
  need(h, `unknown command type ${JSON.stringify(cmd.type)}`);
  const [p, result] = h(project, cmd);
  return [p, result];
}

export function run(project, cmd) {
  const [p, result] = step(project, cmd);
  const { errors } = validateProject(p);
  if (errors.length) throw new CommandError(`${cmd.type} rejected: ${errors.slice(0, 3).join('; ')}${errors.length > 3 ? ` (+${errors.length - 3} more)` : ''}`);
  return { project: p, result };
}
export const apply = (project, cmd) => run(project, cmd).project;
export const commandTypes = Object.keys(handlers);
