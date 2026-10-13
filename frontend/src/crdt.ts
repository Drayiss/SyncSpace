export type Atom = { id: string; after: string; value: number; deleted: boolean };
export type Edit = { kind: 'insert' | 'delete'; id: string; after?: string; value?: number };
export type Batch = { batchId: string; name: string; ops: Edit[] };
export type Snapshot = { id: string; title: string; revision: number; nodes: Atom[] };
export function orderBatches(batches: Batch[]): Batch[] {
  const creator = new Map(
    batches.flatMap((b) =>
      b.ops.filter((o) => o.kind === 'insert').map((o) => [o.id, b.batchId] as const),
    ),
  );
  const remaining = batches.map((batch) => ({
    batch,
    needs: new Set(
      batch.ops
        .map((o) => creator.get(o.kind === 'insert' ? o.after! : o.id))
        .filter((id): id is string => !!id && id !== batch.batchId),
    ),
  }));
  const result: Batch[] = [];
  const done = new Set<string>();
  while (remaining.length) {
    const index = remaining.findIndex((item) => [...item.needs].every((id) => done.has(id)));
    if (index < 0) throw new Error('Local draft dependencies are invalid.');
    const [{ batch }] = remaining.splice(index, 1);
    result.push(batch);
    done.add(batch.batchId);
  }
  return result;
}

export function apply(nodes: Atom[], ops: Edit[]): Atom[] {
  const map = new Map(nodes.map((n) => [n.id, n]));
  for (const op of ops) {
    const old = map.get(op.id);
    if (op.kind === 'insert' && !old)
      map.set(op.id, { id: op.id, after: op.after!, value: op.value!, deleted: false });
    if (op.kind === 'delete' && old && !old.deleted) map.set(op.id, { ...old, deleted: true });
  }
  return [...map.values()];
}
export function ordered(nodes: Atom[], includeDeleted = false): Atom[] {
  const children = new Map<string, Atom[]>();
  for (const n of nodes) {
    const list = children.get(n.after) ?? [];
    list.push(n);
    children.set(n.after, list);
  }
  for (const list of children.values())
    list.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const stack = [...(children.get('') ?? [])];
  const result: Atom[] = [];
  while (stack.length) {
    const n = stack.pop()!;
    if (includeDeleted || !n.deleted) result.push(n);
    stack.push(...(children.get(n.id) ?? []));
  }
  return result;
}
export const textOf = (nodes: Atom[]) =>
  ordered(nodes)
    .map((n) => String.fromCharCode(n.value))
    .join('');
export function position(nodes: Atom[], anchor: string | null): number {
  if (!anchor) return 0;
  let offset = 0;
  for (const atom of ordered(nodes, true)) {
    if (!atom.deleted) offset++;
    if (atom.id === anchor) return offset;
  }
  return offset;
}
export class Clock {
  constructor(
    public clientId: string,
    public value = 0,
  ) {}
  observe(nodes: Atom[]) {
    for (const n of nodes) this.value = Math.max(this.value, Number(n.id.split(':')[0]));
  }
  next() {
    return `${String(++this.value).padStart(12, '0')}:${this.clientId}`;
  }
}
// One contiguous splice covers typing, paste, cut, replace and native textarea undo.
export function difference(nodes: Atom[], next: string, clock: Clock): Edit[] {
  const visible = ordered(nodes);
  const previous = visible.map((n) => String.fromCharCode(n.value)).join('');
  let start = 0;
  while (start < Math.min(previous.length, next.length) && previous[start] === next[start]) start++;
  let end = previous.length,
    nextEnd = next.length;
  while (end > start && nextEnd > start && previous[end - 1] === next[nextEnd - 1]) {
    end--;
    nextEnd--;
  }
  const ops: Edit[] = visible.slice(start, end).map((n) => ({ kind: 'delete', id: n.id }));
  let after = start ? visible[start - 1].id : '';
  for (let i = start; i < nextEnd; i++) {
    const id = clock.next();
    ops.push({ kind: 'insert', id, after, value: next.charCodeAt(i) });
    after = id;
  }
  return ops;
}
