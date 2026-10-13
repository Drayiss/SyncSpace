using System.Text.Json;
using System.Text.RegularExpressions;

namespace SyncSpace;

public record Atom(string Id, string After, int Value, bool Deleted = false);
public record Edit(string Kind, string Id, string? After = null, int? Value = null);
public record Batch(Guid BatchId, string Author, List<Edit> Ops);
public record Snapshot(Guid Id, string Title, long Revision, List<Atom> Nodes);
public record RevisionInfo(long Revision, string Author, DateTime CreatedAt, int Characters);
public record WireEvent(string Type, Guid DocumentId, long? Revision = null, Guid? BatchId = null,
    List<Edit>? Ops = null, string? ConnectionId = null, string? Name = null,
    string? Anchor = null, string? Head = null, string? TraceParent = null, long? SentAt = null, string? InstanceId = null);

public static partial class Crdt
{
    public const int MaxNodes = 50_000;
    [GeneratedRegex(@"^\d{12}:[a-zA-Z0-9_-]{1,64}$", RegexOptions.CultureInvariant)]
    private static partial Regex IdPattern();

    // Lamport IDs sort descending among siblings. Tombstones retain insertion anchors.
    public static List<Atom> Apply(List<Atom> state, IReadOnlyList<Edit> ops)
    {
        if (ops.Count is < 1 or > 10_000) throw new ArgumentException("An edit must contain 1–10,000 operations.");
        var nodes = state.ToDictionary(n => n.Id, StringComparer.Ordinal);
        foreach (var op in ops)
        {
            if (!IdPattern().IsMatch(op.Id)) throw new ArgumentException("Invalid character ID.");
            if (op.Kind == "insert")
            {
                if (op.After is null || op.Value is null or < 0 or > 65535 || op.After == op.Id)
                    throw new ArgumentException("Invalid insertion.");
                if (nodes.TryGetValue(op.Id, out var old))
                {
                    if (old.After != op.After || old.Value != op.Value) throw new ArgumentException("Character IDs are immutable.");
                    continue;
                }
                if (op.After != "" && !nodes.ContainsKey(op.After)) throw new ArgumentException("Missing insertion anchor.");
                if (op.After != "" && StringComparer.Ordinal.Compare(op.Id, op.After) <= 0)
                    throw new ArgumentException("Insertion must advance the logical clock.");
                if (nodes.Count >= MaxNodes) throw new ArgumentException("Document capacity reached. Create a new document to continue.");
                nodes.Add(op.Id, new(op.Id, op.After, op.Value.Value));
            }
            else if (op.Kind == "delete")
            {
                if (!nodes.TryGetValue(op.Id, out var old)) throw new ArgumentException("Missing deletion target.");
                nodes[op.Id] = old with { Deleted = true };
            }
            else throw new ArgumentException("Unknown operation.");
        }
        return nodes.Values.ToList();
    }

    public static List<Atom> Visible(List<Atom> nodes)
    {
        var children = nodes.GroupBy(n => n.After).ToDictionary(g => g.Key,
            g => g.OrderBy(n => n.Id, StringComparer.Ordinal).ToArray());
        var stack = new Stack<Atom>();
        if (children.TryGetValue("", out var roots)) foreach (var n in roots) stack.Push(n);
        var result = new List<Atom>();
        while (stack.TryPop(out var atom))
        {
            if (!atom.Deleted) result.Add(atom);
            if (children.TryGetValue(atom.Id, out var list)) foreach (var n in list) stack.Push(n);
        }
        return result;
    }
    public static string Text(List<Atom> nodes) => new(Visible(nodes).Select(n => (char)n.Value).ToArray());
}

public static class Json
{
    public static readonly JsonSerializerOptions Options = new(JsonSerializerDefaults.Web);
    public static string Encode<T>(T value) => JsonSerializer.Serialize(value, Options);
    public static T Decode<T>(string value) => JsonSerializer.Deserialize<T>(value, Options) ?? throw new JsonException();
}
