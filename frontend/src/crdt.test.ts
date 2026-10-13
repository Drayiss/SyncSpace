import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apply, Clock, difference, textOf, position, orderBatches } from './crdt';
import type { Atom, Edit } from './crdt';
test('recovered journals preserve insertion and deletion dependencies across tabs', () => {
  const insertBatch = { batchId: 'insert', name: 'Alice', ops: [{ kind: 'insert' as const, id: '000000000001:a', after: '', value: 65 }] };
  const deleteBatch = { batchId: 'delete', name: 'Alice', ops: [{ kind: 'delete' as const, id: '000000000001:a' }] };
  assert.deepEqual(orderBatches([deleteBatch, insertBatch]).map(b => b.batchId), ['insert', 'delete']);
  let nodes: Atom[] = []; for (const batch of orderBatches([deleteBatch, insertBatch])) nodes = apply(nodes, batch.ops);
  assert.equal(textOf(nodes), '');
});

test('concurrent insertion converges in either order and preserves both writers', () => {
  const a = new Clock('alice'),
    b = new Clock('bob');
  const left = difference([], 'Hello', a),
    right = difference([], 'World', b);
  const ab = apply(apply([], left), right),
    ba = apply(apply([], right), left);
  assert.equal(textOf(ab), textOf(ba));
  assert.equal(textOf(ab), 'WorldHello');
});
test('insertion inside existing text, deletion anchors and idempotency', () => {
  const clock = new Clock('alice');
  let state = apply([], difference([], 'abc', clock));
  const insertion = difference(state, 'aXbc', clock);
  state = apply(state, insertion);
  assert.equal(textOf(state), 'aXbc');
  assert.equal(textOf(apply(state, insertion)), 'aXbc');
  const anchor = state.find((n) => n.value === 88)!.id;
  state = apply(state, difference(state, 'abc', clock));
  assert.equal(position(state, anchor), 1);
});
test('concurrent deletion and anchored insertion converge, including emoji', () => {
  const a = new Clock('a'),
    b = new Clock('b');
  const initial = apply([], difference([], 'Hi 😀!', a));
  b.observe(initial);
  const deletion = difference(initial, 'Hi !', a),
    insertion = difference(initial, 'Hi 😀 there!', b);
  assert.equal(
    textOf(apply(apply(initial, deletion), insertion)),
    textOf(apply(apply(initial, insertion), deletion)),
  );
  assert.equal(textOf(apply(apply(initial, deletion), insertion)), 'Hi  there!');
});
test('random concurrent splices converge across 200 schedules', () => {
  let seed = 42;
  const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32;
  let state: Atom[] = [];
  const a = new Clock('a'),
    b = new Clock('b');
  for (let step = 0; step < 200; step++) {
    a.observe(state);
    b.observe(state);
    const original = textOf(state);
    const splice = () => {
      const start = Math.floor(random() * (original.length + 1));
      return (
        original.slice(0, start) +
        String.fromCharCode(65 + (step % 26)) +
        original.slice(Math.min(start + Math.floor(random() * 3), original.length))
      );
    };
    const left: Edit[] = difference(state, splice(), a),
      right = difference(state, splice(), b);
    const ab = apply(apply(state, left), right),
      ba = apply(apply(state, right), left);
    assert.equal(textOf(ab), textOf(ba));
    state = ab;
  }
});
