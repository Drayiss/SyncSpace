using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;
using Npgsql;

namespace SyncSpace;

public sealed class Store(NpgsqlDataSource database)
{
    private static string Hash(string key) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(key)));
    public async Task Initialize()
    {
        await using var connection = await database.OpenConnectionAsync();
        await using var transaction = await connection.BeginTransactionAsync();
        await using var cmd = new NpgsqlCommand("""
            SELECT pg_advisory_xact_lock(827314);
            CREATE TABLE IF NOT EXISTS documents (
                id uuid PRIMARY KEY, title text NOT NULL, key_hash text NOT NULL,
                state jsonb NOT NULL DEFAULT '[]', revision bigint NOT NULL DEFAULT 0,
                updated_at timestamptz NOT NULL DEFAULT now());
            CREATE TABLE IF NOT EXISTS revisions (
                document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
                revision bigint NOT NULL, batch_id uuid NOT NULL, author text NOT NULL,
                state jsonb NOT NULL, ops jsonb NOT NULL, characters int NOT NULL,
                created_at timestamptz NOT NULL DEFAULT now(),
                PRIMARY KEY(document_id, revision), UNIQUE(document_id, batch_id));
            """, connection, transaction);
        await cmd.ExecuteNonQueryAsync();
        await transaction.CommitAsync();
    }
    public async Task<object> Create(string? title, CancellationToken ct)
    {
        var id = Guid.NewGuid(); var key = Convert.ToHexString(RandomNumberGenerator.GetBytes(32)).ToLowerInvariant();
        await using var cmd = database.CreateCommand("INSERT INTO documents(id,title,key_hash) VALUES($1,$2,$3)");
        cmd.Parameters.AddWithValue(id); cmd.Parameters.AddWithValue(Clean(title, "Untitled document")); cmd.Parameters.AddWithValue(Hash(key));
        await cmd.ExecuteNonQueryAsync(ct);
        return new { id, title = Clean(title, "Untitled document"), key };
    }
    public static string Clean(string? text, string fallback) => string.IsNullOrWhiteSpace(text) ? fallback : text.Trim()[..Math.Min(text.Trim().Length, 100)];
    public async Task<bool> Authorize(Guid id, string key, CancellationToken ct)
    {
        if (key.Length != 64) return false;
        await using var cmd = database.CreateCommand("SELECT key_hash FROM documents WHERE id=$1");
        cmd.Parameters.AddWithValue(id);
        return await cmd.ExecuteScalarAsync(ct) is string expected && CryptographicOperations.FixedTimeEquals(
            Encoding.ASCII.GetBytes(expected), Encoding.ASCII.GetBytes(Hash(key)));
    }
    public async Task<Snapshot?> Read(Guid id, CancellationToken ct)
    {
        await using var cmd = database.CreateCommand("SELECT title,revision,state::text FROM documents WHERE id=$1");
        cmd.Parameters.AddWithValue(id);
        await using var reader = await cmd.ExecuteReaderAsync(ct);
        return await reader.ReadAsync(ct) ? new(id, reader.GetString(0), reader.GetInt64(1), Json.Decode<List<Atom>>(reader.GetString(2))) : null;
    }
    public async Task<WireEvent> Commit(Guid id, Batch batch, CancellationToken ct)
    {
        using var activity = Telemetry.Activities.StartActivity("document.commit");
        activity?.SetTag("document.id", id); activity?.SetTag("batch.id", batch.BatchId);
        var timer = Stopwatch.StartNew();
        if (batch.BatchId == Guid.Empty) throw new ArgumentException("Invalid batch ID.");
        await using var connection = await database.OpenConnectionAsync(ct);
        await using var transaction = await connection.BeginTransactionAsync(ct);
        await using var read = new NpgsqlCommand("SELECT revision,state::text FROM documents WHERE id=$1 FOR UPDATE", connection, transaction);
        read.Parameters.AddWithValue(id);
        long revision; List<Atom> state;
        await using (var reader = await read.ExecuteReaderAsync(ct))
        {
            if (!await reader.ReadAsync(ct)) throw new ArgumentException("Document not found.");
            revision = reader.GetInt64(0); state = Json.Decode<List<Atom>>(reader.GetString(1));
        }
        await using var duplicate = new NpgsqlCommand("SELECT revision,ops::text FROM revisions WHERE document_id=$1 AND batch_id=$2", connection, transaction);
        duplicate.Parameters.AddWithValue(id); duplicate.Parameters.AddWithValue(batch.BatchId);
        await using (var reader = await duplicate.ExecuteReaderAsync(ct))
        {
            if (await reader.ReadAsync(ct)) return new("edit", id, reader.GetInt64(0), batch.BatchId, Json.Decode<List<Edit>>(reader.GetString(1)));
        }
        state = Crdt.Apply(state, batch.Ops);
        var stateJson = Json.Encode(state); var opsJson = Json.Encode(batch.Ops);
        await using var write = new NpgsqlCommand("UPDATE documents SET state=$2::jsonb,revision=$3,updated_at=now() WHERE id=$1", connection, transaction);
        write.Parameters.AddWithValue(id); write.Parameters.AddWithValue(stateJson); write.Parameters.AddWithValue(++revision);
        await write.ExecuteNonQueryAsync(ct);
        await using var history = new NpgsqlCommand("INSERT INTO revisions(document_id,revision,batch_id,author,state,ops,characters) VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7)", connection, transaction);
        history.Parameters.AddWithValue(id); history.Parameters.AddWithValue(revision);
        history.Parameters.AddWithValue(batch.BatchId); history.Parameters.AddWithValue(Clean(batch.Author, "Guest"));
        history.Parameters.AddWithValue(stateJson); history.Parameters.AddWithValue(opsJson); history.Parameters.AddWithValue(Crdt.Visible(state).Count);
        await history.ExecuteNonQueryAsync(ct); await transaction.CommitAsync(ct);
        Telemetry.Commit(timer.Elapsed.TotalMilliseconds);
        return new("edit", id, revision, batch.BatchId, batch.Ops, TraceParent: activity?.Id);
    }
    public async Task<List<RevisionInfo>> History(Guid id, long before, CancellationToken ct)
    {
        await using var cmd = database.CreateCommand("SELECT revision,author,created_at,characters FROM revisions WHERE document_id=$1 AND revision<$2 ORDER BY revision DESC LIMIT 50");
        cmd.Parameters.AddWithValue(id); cmd.Parameters.AddWithValue(before);
        await using var reader = await cmd.ExecuteReaderAsync(ct);
        var result = new List<RevisionInfo>();
        while (await reader.ReadAsync(ct)) result.Add(new(reader.GetInt64(0), reader.GetString(1), reader.GetDateTime(2), reader.GetInt32(3)));
        return result;
    }
    public async Task<object?> Version(Guid id, long revision, CancellationToken ct)
    {
        if (revision == 0) return new { revision, text = "" };
        await using var cmd = database.CreateCommand("SELECT state::text FROM revisions WHERE document_id=$1 AND revision=$2");
        cmd.Parameters.AddWithValue(id); cmd.Parameters.AddWithValue(revision);
        var state = await cmd.ExecuteScalarAsync(ct);
        return state is string json ? new { revision, text = Crdt.Text(Json.Decode<List<Atom>>(json)) } : null;
    }
    public async Task Rename(Guid id, string title, CancellationToken ct)
    {
        await using var cmd = database.CreateCommand("UPDATE documents SET title=$2,updated_at=now() WHERE id=$1");
        cmd.Parameters.AddWithValue(id); cmd.Parameters.AddWithValue(Clean(title, "Untitled document"));
        await cmd.ExecuteNonQueryAsync(ct);
    }
    public async Task Ping(CancellationToken ct)
    {
        await using var cmd = database.CreateCommand("SELECT 1"); await cmd.ExecuteScalarAsync(ct);
    }
}
