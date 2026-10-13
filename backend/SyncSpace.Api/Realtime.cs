using System.Collections.Concurrent;
using System.Diagnostics;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using System.Threading.Channels;
using StackExchange.Redis;

namespace SyncSpace;

public sealed class Peer(WebSocket socket, Guid documentId, ILogger logger)
{
    public string Id { get; } = Guid.NewGuid().ToString("N");
    public Guid DocumentId { get; } = documentId;
    private readonly Channel<string> outgoing = Channel.CreateBounded<string>(new BoundedChannelOptions(256)
    { SingleReader = true, FullMode = BoundedChannelFullMode.Wait });
    public void Send(object value)
    {
        // Presence is ephemeral: reserve queue space for edits, snapshots and acknowledgements.
        if (value is WireEvent { Type: "presence" } && outgoing.Reader.Count >= 64) return;
        if (!outgoing.Writer.TryWrite(Json.Encode(value)))
        {
            Telemetry.Error(); logger.LogWarning("Slow WebSocket consumer {ConnectionId} disconnected", Id);
            socket.Abort(); // Slow consumers reconnect and fetch durable state.
        }
    }
    public void Complete() => outgoing.Writer.TryComplete();
    public async Task Drain(CancellationToken ct)
    {
        await foreach (var message in outgoing.Reader.ReadAllAsync(ct))
            await socket.SendAsync(Encoding.UTF8.GetBytes(message), WebSocketMessageType.Text, true, ct);
    }
}

public sealed class Realtime(Store store, IConnectionMultiplexer redis, ILogger<Realtime> logger) : IHostedService
{
    private static readonly RedisChannel Channel = RedisChannel.Literal("syncspace:events:v1");
    private readonly ConcurrentDictionary<string, Peer> peers = new();
    private readonly ConcurrentDictionary<string, WireEvent> presence = new();
    private readonly string instanceId = Guid.NewGuid().ToString("N");
    public async Task StartAsync(CancellationToken ct)
    {
        await redis.GetSubscriber().SubscribeAsync(Channel, (_, payload) =>
        {
            try
            {
                var message = Json.Decode<WireEvent>(payload.ToString());
                if (message.InstanceId == instanceId) return;
                using var activity = Telemetry.Activities.StartActivity("redis.receive", ActivityKind.Consumer, message.TraceParent);
                Deliver(message);
            }
            catch (Exception ex) { logger.LogWarning(ex, "Invalid event from Redis"); }
        });
    }
    public Task StopAsync(CancellationToken ct) => redis.GetSubscriber().UnsubscribeAsync(Channel);
    private void Deliver(WireEvent message)
    {
        if (message.ConnectionId is { } connectionId)
        {
            if (message.Type == "leave") presence.TryRemove(connectionId, out _);
            if (message.Type == "presence") presence[connectionId] = message;
        }
        foreach (var peer in peers.Values) if (peer.DocumentId == message.DocumentId) peer.Send(message);
        var cutoff = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - 20_000;
        foreach (var entry in presence) if (entry.Value.SentAt < cutoff) presence.TryRemove(entry.Key, out _);
    }
    public async Task Publish(WireEvent message)
    {
        // Deliver locally even if Redis is down. Periodic snapshots repair remote missed commits.
        Deliver(message);
        try
        {
            using var activity = Telemetry.Activities.StartActivity("redis.publish", ActivityKind.Producer, message.TraceParent);
            await redis.GetSubscriber().PublishAsync(Channel, Json.Encode(message with { TraceParent = activity?.Id ?? message.TraceParent, InstanceId = instanceId }));
        }
        catch (RedisException ex) { logger.LogWarning(ex, "Redis broadcast unavailable for {DocumentId}; durable reconciliation will recover", message.DocumentId); }
    }
    public async Task Connect(HttpContext context, Guid id)
    {
        if (!context.WebSockets.IsWebSocketRequest) { context.Response.StatusCode = 400; return; }
        using var socket = await context.WebSockets.AcceptWebSocketAsync();
        using var lifetime = CancellationTokenSource.CreateLinkedTokenSource(context.RequestAborted);
        var ct = lifetime.Token;
        Peer? peer = null; Task? writer = null;
        try
        {
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct); timeout.CancelAfter(TimeSpan.FromSeconds(10));
            var join = await Receive(socket, timeout.Token);
            if (join is null || join.Type != "join" || !await store.Authorize(id, join.Key ?? "", timeout.Token))
            {
                await socket.CloseAsync(WebSocketCloseStatus.PolicyViolation, "Invalid document key", ct); return;
            }
            peer = new(socket, id, logger); peers[peer.Id] = peer; Telemetry.Connection(1);
            writer = peer.Drain(ct);
            peer.Send(new { type = "joined", connectionId = peer.Id, snapshot = await store.Read(id, ct) });
            foreach (var entry in presence.Values) if (entry.DocumentId == id && entry.SentAt >= DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - 20_000) peer.Send(entry);
            logger.LogInformation("WebSocket joined {DocumentId} as {ConnectionId}", id, peer.Id);
            var tokens = 100.0; var previous = Stopwatch.GetTimestamp();
            while (socket.State == WebSocketState.Open && !ct.IsCancellationRequested)
            {
                var message = await Receive(socket, ct); if (message is null) break;
                var now = Stopwatch.GetTimestamp(); tokens = Math.Min(100, tokens + Stopwatch.GetElapsedTime(previous, now).TotalSeconds * 30); previous = now;
                if (--tokens < 0) { await socket.CloseOutputAsync(WebSocketCloseStatus.PolicyViolation, "Message rate exceeded", ct); break; }
                try
                {
                    switch (message.Type)
                    {
                        case "edit":
                            var committed = await store.Commit(id, new(message.BatchId ?? Guid.Empty, Store.Clean(message.Name, "Guest"), message.Ops ?? []), ct);
                            peer.Send(committed); // Explicit durable acknowledgement, even on an idempotent retry.
                            await Publish(committed);
                            logger.LogInformation("Committed {DocumentId} revision {Revision} batch {BatchId}", id, committed.Revision, committed.BatchId);
                            break;
                        case "sync": peer.Send(new { type = "snapshot", snapshot = await store.Read(id, ct) }); break;
                        case "presence":
                            await Publish(new("presence", id, ConnectionId: peer.Id, Name: Store.Clean(message.Name, "Guest"),
                                Anchor: Short(message.Anchor), Head: Short(message.Head), SentAt: DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()));
                            break;
                        default: throw new ArgumentException("Unknown message type.");
                    }
                }
                catch (ArgumentException ex) { peer.Send(new { type = "error", batchId = message.BatchId, message = ex.Message, permanent = true }); }
                catch (Npgsql.NpgsqlException ex)
                {
                    Telemetry.Error(); logger.LogWarning(ex, "Document database temporarily unavailable {DocumentId}", id);
                    peer.Send(new { type = "error", batchId = message.BatchId, message = "Saving is temporarily unavailable; reconnecting will retry.", permanent = false });
                    break;
                }
            }
        }
        catch (Exception ex) when (ex is WebSocketException or OperationCanceledException or JsonException or ArgumentException)
        { logger.LogDebug("WebSocket ended: {Reason}", ex.Message); }
        finally
        {
            if (peer is not null)
            {
                peers.TryRemove(peer.Id, out _); Telemetry.Connection(-1);
                await Publish(new("leave", id, ConnectionId: peer.Id)); peer.Complete();
            }
            lifetime.Cancel();
            if (writer is not null) try { await writer; } catch (Exception ex) when (ex is WebSocketException or OperationCanceledException) { }
            if (socket.State == WebSocketState.Open) try { await socket.CloseOutputAsync(WebSocketCloseStatus.NormalClosure, "Session ended", CancellationToken.None); } catch (WebSocketException) { }
        }
    }
    private static string? Short(string? value) => value is { Length: <= 80 } ? value : null;
    private static async Task<ClientMessage?> Receive(WebSocket socket, CancellationToken ct)
    {
        using var stream = new MemoryStream(); var buffer = new byte[8192];
        WebSocketReceiveResult result;
        do
        {
            result = await socket.ReceiveAsync(buffer, ct);
            if (result.MessageType == WebSocketMessageType.Close) return null;
            if (result.MessageType != WebSocketMessageType.Text || stream.Length + result.Count > 1_048_576)
                throw new ArgumentException("Message must be JSON text under 1 MiB.");
            stream.Write(buffer, 0, result.Count);
        } while (!result.EndOfMessage);
        return JsonSerializer.Deserialize<ClientMessage>(stream.ToArray(), Json.Options) ?? throw new JsonException();
    }
    private record ClientMessage(string Type, string? Key, Guid? BatchId, List<Edit>? Ops, string? Name, string? Anchor, string? Head);
}
