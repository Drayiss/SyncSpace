import type { Batch, Snapshot } from './crdt';
import { orderBatches } from './crdt';
export type Stored = { snapshot: Snapshot; pending: Batch[]; clientId: string; clock: number };
const database = new Promise<IDBDatabase>((resolve, reject) => {
  const request = indexedDB.open('syncspace', 1);
  request.onupgradeneeded = () => request.result.createObjectStore('documents');
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(new Error('Local draft storage is unavailable.'));
});
// Each tab has its own journal; other tabs cannot overwrite its unacknowledged edits.
const journalId = crypto.randomUUID();
export async function readDraft(id: string): Promise<Stored | undefined> {
  const db = await database;
  return new Promise((resolve, reject) => {
    const r = db.transaction('documents').objectStore('documents').getAll();
    r.onsuccess = () => {
      try {
        const journals = (r.result as Stored[]).filter((s) => s.snapshot.id === id);
        if (!journals.length) {
          resolve(undefined);
          return;
        }
        const latest = journals.reduce((a, b) =>
          a.snapshot.revision >= b.snapshot.revision ? a : b,
        );
        const batches = new Map(journals.flatMap((s) => s.pending).map((b) => [b.batchId, b]));
        const pending = orderBatches([...batches.values()]);
        resolve({ ...latest, pending });
      } catch (error) {
        reject(error);
      }
    };
    r.onerror = () => reject(r.error);
  });
}
export async function acknowledge(id: string, batchId: string): Promise<void> {
  const db = await database;
  return new Promise((resolve, reject) => {
    const tx = db.transaction('documents', 'readwrite');
    const store = tx.objectStore('documents');
    const cursor = store.openCursor();
    cursor.onsuccess = () => {
      const entry = cursor.result;
      if (!entry) return;
      const value = entry.value as Stored;
      if (value.snapshot.id === id && value.pending.some((b) => b.batchId === batchId))
        entry.update({ ...value, pending: value.pending.filter((b) => b.batchId !== batchId) });
      entry.continue();
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
export async function writeDraft(id: string, value: Stored): Promise<void> {
  const db = await database;
  return new Promise((resolve, reject) => {
    const tx = db.transaction('documents', 'readwrite');
    const store = tx.objectStore('documents');
    store.put(value, `${id}:${journalId}`);
    const cursor = store.openCursor();
    cursor.onsuccess = () => {
      const entry = cursor.result;
      if (!entry) return;
      const old = entry.value as Stored;
      if (
        entry.key !== `${id}:${journalId}` &&
        old.snapshot.id === id &&
        !old.pending.length &&
        old.snapshot.revision <= value.snapshot.revision
      )
        entry.delete();
      entry.continue();
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () =>
      reject(new Error('Could not save your local draft. Export your text before closing.'));
  });
}
