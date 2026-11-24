import assert from 'node:assert/strict';
import { createLru } from '../lib/lru.js';

let n = 0;
const test = (name, fn) => { fn(); n++; console.log('ok', name); };
const mk = (max) => {
  const evicted = [];
  const lru = createLru({ maxBytes: max, onEvict: (v, k) => evicted.push(k) });
  return { lru, evicted };
};

test('put/lease/hit/miss', () => {
  const { lru } = mk(100);
  lru.put('a', 'A', 10).release();
  const l = lru.lease('a');
  assert.equal(l.value, 'A');
  assert.equal(lru.lease('zz'), null);
  const s = lru.stats();
  assert.equal(s.hits, 1); assert.equal(s.misses, 1);
  l.release();
});

test('evicts oldest unpinned first', () => {
  const { lru, evicted } = mk(100);
  lru.put('a', 1, 40).release();
  lru.put('b', 2, 40).release();
  lru.put('c', 3, 40).release();
  assert.deepEqual(evicted, ['a']);
  assert.equal(lru.stats().bytes, 80);
});

test('lease() touches recency', () => {
  const { lru, evicted } = mk(100);
  lru.put('a', 1, 40).release();
  lru.put('b', 2, 40).release();
  lru.lease('a').release();
  lru.put('c', 3, 40).release();
  assert.deepEqual(evicted, ['b']);
});

test('pinned entries survive; over budget until release', () => {
  const { lru, evicted } = mk(100);
  const la = lru.put('a', 1, 80);
  const lb = lru.put('b', 2, 80);
  assert.deepEqual(evicted, []);
  assert.equal(lru.stats().bytes, 160);
  la.release();
  assert.deepEqual(evicted, ['a']);
  assert.equal(lru.stats().bytes, 80);
  lb.release();
  assert.deepEqual(evicted, ['a']);   // 80 <= 100, b stays
});

test('release is idempotent and per-lease', () => {
  const { lru } = mk(100);
  const l1 = lru.put('a', 1, 10);
  const l2 = lru.lease('a');
  l1.release(); l1.release();
  assert.equal(lru.stats().pinned, 1);
  l2.release();
  assert.equal(lru.stats().pinned, 0);
});

test('delete of pinned entry defers onEvict to last release', () => {
  const { lru, evicted } = mk(100);
  const l = lru.put('a', 1, 10);
  assert.equal(lru.delete('a'), true);
  assert.equal(lru.has('a'), false);
  assert.equal(lru.lease('a'), null);
  assert.deepEqual(evicted, []);
  assert.equal(lru.stats().bytes, 10);
  l.release(); l.release();
  assert.deepEqual(evicted, ['a']);
  assert.equal(lru.stats().bytes, 0);
});

test('duplicate put discards the new value and leases the old', () => {
  const { lru } = mk(100);
  const discarded = [];
  const l2 = createLru({ maxBytes: 100, onEvict: v => discarded.push(v) });
  l2.put('a', 'old', 10).release();
  const l = l2.put('a', 'new', 10);
  assert.equal(l.value, 'old');
  assert.deepEqual(discarded, ['new']);
  assert.equal(l2.stats().bytes, 10);
  l.release();
});

test('clear: unpinned freed now, pinned deferred', () => {
  const { lru, evicted } = mk(100);
  lru.put('a', 1, 10).release();
  const lb = lru.put('b', 2, 10);
  lru.clear();
  assert.deepEqual(evicted, ['a']);
  lb.release();
  assert.deepEqual(evicted, ['a', 'b']);
});

test('deleteWhere', () => {
  const { lru, evicted } = mk(100);
  for (const k of ['x:1', 'x:2', 'y:1']) lru.put(k, 0, 1).release();
  lru.deleteWhere(k => k.startsWith('x:'));
  assert.deepEqual(evicted.sort(), ['x:1', 'x:2']);
  assert.equal(lru.has('y:1'), true);
});

console.log(`\n${n} passed`);
