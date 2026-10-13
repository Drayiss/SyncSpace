# Protocol and persistence

HTTP:

| Method | Path | Behavior |
|---|---|---|
| POST | `/api/documents` | `{title}` → `{id,title,key}`; creates empty document |
| GET | `/api/documents/{id}` | Current `{id,title,revision,nodes}` |
| PUT | `/api/documents/{id}/title` | `{title}` updates metadata |
| GET | `/api/documents/{id}/history?before=N` | Up to 50 versions, newest first |
| GET | `/api/documents/{id}/history/{revision}` | `{revision,text}`; revision 0 is empty |

All document endpoints except creation require `Authorization: Bearer <key>`. The stored key is a SHA-256 hash of a random 256-bit capability. The shared browser URL keeps the key in its fragment, avoiding HTTP request URLs and referrer propagation. A WebSocket sends the key in its first frame instead of the handshake URL. Browser WebSocket origins are explicitly allowed; CORS alone does not protect the handshake. Non-browser clients still require the key.

Open `/ws/documents/{id}` and send `{"type":"join","key":"..."}` within ten seconds. The server returns `joined` with a connection ID and durable snapshot.

An edit has `type: "edit"`, a UUID `batchId`, a display `name`, and `ops`:

```json
{
  "type": "edit",
  "batchId": "ee3d2f23-9982-4b79-9873-1bd4e3f035c9",
  "name": "Alice",
  "ops": [
    {"kind":"insert","id":"000000000001:alice","after":"","value":65},
    {"kind":"delete","id":"000000000001:alice"}
  ]
}
```

IDs contain a twelve-digit logical counter and client identifier. Each insertion advances the clock beyond its anchor. Values are UTF-16 code units; paired units preserve emoji and match textarea offsets. The empty string is the root. Character identities/values/parents cannot change, deletes are monotone, and insertion/deletion targets must exist by their operation's position in the batch. These checks prevent cycles and invalid references. The full batch is atomic.

The server sends/broadcasts `edit` with `documentId`, `revision`, `batchId`, `ops` and optional `traceParent`. A repeated batch returns its original revision and operations. A client applies sequential revisions or requests `{"type":"sync"}` to receive `snapshot`. A pending operation can be reapplied to a snapshot safely because inserted IDs and tombstones are idempotent.

Presence: send `{"type":"presence","name":"Alice","anchor":"ID-or-empty","head":"ID-or-empty"}`. The server assigns `connectionId` and `sentAt`, distributes presence across replicas, and emits `leave` on disconnect. Clients map stable IDs into current offsets, including deleted anchors. Heartbeats refresh every five seconds; entries expire after twenty seconds. A new connection receives currently known peers and subsequent heartbeats. Presence is ephemeral and does not create revisions.

Errors have `type:"error"`, optional `batchId`, `message`, and `permanent`. Invalid operations remain in the local journal with a visible error; users can export their draft. Database failures close the connection after a transient error, triggering reconnect/retry. A bounded outgoing queue reserves room for durable events and drops excess ephemeral presence. Slow sockets are aborted and reconnect to fetch state. Redis events carry an instance ID to avoid broadcasting a local event again through its own subscription. Messages are limited to 1 MiB, 10,000 edit operations, and 30 messages/s per connection with a 100-message burst.

PostgreSQL tables are created under a transaction advisory lock at startup. Document rows contain title, key hash, revision, full CRDT state and update time. Revision rows contain batch identity, author, full state, operations, character count and timestamp. Row locking serializes writes across all instances; `(document_id,batch_id)` is unique. Revision numbers provide event ordering, while the CRDT supplies conflict resolution independently of commit ordering.

Redis Pub/Sub is transport, not the source of truth. This design intentionally uses periodic reconciliation instead of an outbox dispatcher: state survives any missed broadcast, including a server crash immediately after commit. During a Redis outage local edits continue to commit; other instances reconcile within approximately five seconds. New connections/snapshot reads require PostgreSQL. There is no promise of instantaneous presence during Redis outages.
