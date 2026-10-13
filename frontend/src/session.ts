import { apply, Clock, difference, ordered, textOf } from './crdt';
import type { Atom, Batch, Edit, Snapshot } from './crdt';
import { acknowledge, readDraft, writeDraft } from './storage';
export type Presence = {
  connectionId: string;
  name: string;
  anchor: string | null;
  head: string | null;
  sentAt: number;
};
export type View = {
  title: string;
  revision: number;
  nodes: Atom[];
  text: string;
  pending: number;
  status: 'connecting' | 'online' | 'offline' | 'error';
  error: string;
  peers: Presence[];
  ready: boolean;
};
type EditEvent = { type: 'edit'; revision: number; batchId: string; ops: Edit[] };
export class Session {
  private base: Snapshot;
  private pending: Batch[] = [];
  private clock = new Clock(crypto.randomUUID().replaceAll('-', ''));
  private socket?: WebSocket;
  private connectionId = '';
  private listeners = new Set<() => void>();
  private peers = new Map<string, Presence>();
  private events = new Map<number, EditEvent>();
  private sent = new Set<string>();
  private timer?: ReturnType<typeof setTimeout>;
  private flushTimer?: ReturnType<typeof setTimeout>;
  private heartbeat?: ReturnType<typeof setInterval>;
  private disposed = false;
  private attempts = 0;
  private lastMessage = Date.now();
  private persisted: Promise<void> = Promise.resolve();
  private selection = { anchor: '', head: '' };
  private offline = () => {
    this.socket?.close();
    this.emit({ status: 'offline' });
  };
  private online = () => {
    clearTimeout(this.timer);
    if (this.socket?.readyState !== WebSocket.OPEN) this.connect();
  };
  view: View;
  constructor(
    public id: string,
    public key: string,
    public name: string,
  ) {
    this.base = { id, title: 'Untitled document', revision: 0, nodes: [] };
    this.view = {
      title: this.base.title,
      revision: 0,
      nodes: [],
      text: '',
      pending: 0,
      status: 'connecting',
      error: '',
      peers: [],
      ready: false,
    };
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getSnapshot = () => this.view;
  private emit(update: Partial<View> = {}) {
    let nodes = this.base.nodes;
    for (const batch of this.pending) nodes = apply(nodes, batch.ops);
    this.clock.observe(nodes);
    this.view = {
      ...this.view,
      ...update,
      title: this.base.title,
      revision: this.base.revision,
      nodes,
      text: textOf(nodes),
      pending: this.pending.length,
      peers: [...this.peers.values()].filter(
        (p) => p.connectionId !== this.connectionId && p.sentAt > Date.now() - 20_000,
      ),
    };
    this.listeners.forEach((listener) => listener());
  }
  async start() {
    window.addEventListener('offline', this.offline);
    window.addEventListener('online', this.online);
    try {
      const saved = await readDraft(this.id);
      if (this.disposed) return;
      if (saved) {
        this.base = saved.snapshot;
        this.pending = saved.pending;
        this.clock.value = saved.clock;
      }
      this.emit({ ready: !!saved });
      this.connect();
    } catch (error) {
      this.emit({ status: 'error', error: String(error) });
    }
  }
  private save() {
    const stored = structuredClone({
      snapshot: this.base,
      pending: this.pending,
      clientId: this.clock.clientId,
      clock: this.clock.value,
    });
    this.persisted = this.persisted
      .then(() => writeDraft(this.id, stored))
      .catch((error) => {
        this.emit({ status: 'error', error: String(error) });
        throw error;
      });
    // Handle rejection while preserving failure for flush(), which must not send unpersisted edits.
    void this.persisted.catch(() => {});
  }
  edit(next: string, referenceNodes = this.view.nodes) {
    const ops = difference(referenceNodes, next, this.clock);
    if (!ops.length) return;
    if (
      ops.length > 10_000 ||
      this.view.nodes.length + ops.filter((o) => o.kind === 'insert').length > 50_000
    ) {
      this.emit({
        error:
          'This change exceeds document capacity. Use smaller pastes or create a new document.',
      });
      return;
    }
    this.pending.push({ batchId: crypto.randomUUID(), name: this.name, ops });
    this.emit({ error: '' });
    this.save();
    clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => {
      void this.flush();
    }, 100);
  }
  private send(value: object) {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(value));
  }
  private async flush() {
    try {
      await this.persisted;
    } catch {
      return;
    }
    if (this.view.status !== 'online') return;
    // One in-flight batch preserves dependencies between locally generated edits.
    if (this.sent.size) return;
    const batch = this.pending[0];
    if (batch) {
      this.sent.add(batch.batchId);
      this.send({ type: 'edit', ...batch });
    }
  }
  select(start: number, end: number) {
    const visible = ordered(this.view.nodes);
    this.selection = {
      anchor: start ? (visible[start - 1]?.id ?? '') : '',
      head: end ? (visible[end - 1]?.id ?? '') : '',
    };
    this.send({ type: 'presence', name: this.name, ...this.selection });
  }
  setName(name: string) {
    this.name = name;
    this.send({ type: 'presence', name, ...this.selection });
  }
  private receiveSnapshot(snapshot: Snapshot) {
    if (snapshot.revision >= this.base.revision) this.base = snapshot;
    for (const revision of this.events.keys())
      if (revision <= this.base.revision) {
        this.ack(this.events.get(revision)!.batchId);
        this.events.delete(revision);
      }
    this.drain();
    this.emit({ ready: true });
    this.save();
    void this.flush();
  }
  private ack(batchId: string) {
    if (this.pending.some((p) => p.batchId === batchId)) {
      this.pending = this.pending.filter((p) => p.batchId !== batchId);
      this.persisted = this.persisted.then(() => acknowledge(this.id, batchId));
      void this.persisted.catch(() => {});
    }
    this.sent.delete(batchId);
  }
  private drain() {
    let event: EditEvent | undefined;
    while ((event = this.events.get(this.base.revision + 1))) {
      this.base = {
        ...this.base,
        revision: event.revision,
        nodes: apply(this.base.nodes, event.ops),
      };
      this.events.delete(event.revision);
      this.ack(event.batchId);
    }
  }
  private connect() {
    if (this.disposed) return;
    if (!navigator.onLine) {
      this.emit({ status: 'offline' });
      return;
    }
    clearInterval(this.heartbeat);
    this.emit({ status: this.attempts ? 'offline' : 'connecting' });
    const ws = new WebSocket(
      `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws/documents/${this.id}`,
    );
    this.socket = ws;
    ws.onopen = () => this.send({ type: 'join', key: this.key });
    ws.onmessage = (event) => {
      if (this.disposed || ws !== this.socket) return;
      this.lastMessage = Date.now();
      const message = JSON.parse(event.data);
      if (message.type === 'joined') {
        this.connectionId = message.connectionId;
        this.sent.clear();
        this.attempts = 0;
        this.emit({ status: 'online', error: '' });
        this.receiveSnapshot(message.snapshot);
        this.send({ type: 'presence', name: this.name, ...this.selection });
      } else if (message.type === 'snapshot') this.receiveSnapshot(message.snapshot);
      else if (message.type === 'edit') {
        if (message.revision <= this.base.revision) this.ack(message.batchId);
        else this.events.set(message.revision, message);
        this.drain();
        this.emit();
        this.save();
        void this.flush();
        if (this.events.size) this.send({ type: 'sync' });
      } else if (message.type === 'presence') {
        this.peers.set(message.connectionId, message);
        this.emit();
      } else if (message.type === 'leave') {
        this.peers.delete(message.connectionId);
        this.emit();
      } else if (message.type === 'metadata') this.send({ type: 'sync' });
      else if (message.type === 'error') {
        this.emit({ error: message.message, status: message.permanent ? 'error' : 'offline' });
        if (!message.permanent) ws.close();
      }
    };
    ws.onclose = (event) => {
      if (ws !== this.socket) return;
      clearInterval(this.heartbeat);
      this.sent.clear();
      this.peers.clear();
      if (this.disposed) return;
      if (event.code === 1008) {
        this.emit({
          status: 'error',
          error: 'Access refused or request rate exceeded. Check the invite link, then reload.',
        });
        return;
      }
      this.emit({ status: 'offline' });
      this.timer = setTimeout(
        () => this.connect(),
        Math.min(15_000, 500 * 2 ** this.attempts++) + Math.random() * 300,
      );
    };
    ws.onerror = () => ws.close();
    this.heartbeat = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        if (Date.now() - this.lastMessage > 25_000) {
          ws.close();
          return;
        }
        this.send({ type: 'sync' });
        this.send({ type: 'presence', name: this.name, ...this.selection });
        this.emit();
      }
    }, 5_000);
  }
  dispose() {
    this.disposed = true;
    window.removeEventListener('offline', this.offline);
    window.removeEventListener('online', this.online);
    clearTimeout(this.timer);
    clearTimeout(this.flushTimer);
    clearInterval(this.heartbeat);
    this.socket?.close();
  }
}
