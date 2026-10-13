using SyncSpace;
using Xunit;
public class CrdtTests
{
    private static string Id(int n, string client) => $"{n:D12}:{client}";
    [Fact]
    public void ConcurrentEditsConverge()
    {
        Edit[] a = [new("insert", Id(1, "a"), "", 65), new("insert", Id(2, "a"), Id(1, "a"), 66)];
        Edit[] b = [new("insert", Id(1, "b"), "", 88), new("insert", Id(2, "b"), Id(1, "b"), 89)];
        Assert.Equal("XYAB", Crdt.Text(Crdt.Apply(Crdt.Apply([], a), b)));
        Assert.Equal("XYAB", Crdt.Text(Crdt.Apply(Crdt.Apply([], b), a)));
    }
    [Fact]
    public void DeletedAnchorsRetainConcurrentInsertion()
    {
        var state = Crdt.Apply([], [new("insert", Id(1, "a"), "", 65)]);
        Edit[] insert = [new("insert", Id(2, "b"), Id(1, "a"), 66)]; Edit[] delete = [new("delete", Id(1, "a"))];
        Assert.Equal("B", Crdt.Text(Crdt.Apply(Crdt.Apply(state, delete), insert)));
        Assert.Equal("B", Crdt.Text(Crdt.Apply(Crdt.Apply(state, insert), delete)));
    }
    [Fact]
    public void RetryDoesNotResurrectDeletedCharacters()
    {
        Edit[] insert = [new("insert", Id(1, "a"), "", 65)];
        var state = Crdt.Apply(Crdt.Apply([], insert), [new("delete", Id(1, "a"))]);
        Assert.Empty(Crdt.Text(Crdt.Apply(state, insert)));
    }
    [Fact]
    public void CyclesAndMutatedIdsAreRejected()
    {
        Assert.Throws<ArgumentException>(() => Crdt.Apply([], [new("insert", Id(1, "a"), Id(1, "a"), 65)]));
        var state = Crdt.Apply([], [new("insert", Id(2, "a"), "", 65)]);
        Assert.Throws<ArgumentException>(() => Crdt.Apply(state, [new("insert", Id(1, "b"), Id(2, "a"), 66)]));
        Assert.Throws<ArgumentException>(() => Crdt.Apply(state, [new("insert", Id(2, "a"), "", 90)]));
    }
    [Fact]
    public void LargeDocumentTraversalDoesNotUseRecursiveStack()
    {
        var nodes = Enumerable.Range(1, 40_000).Select(i => new Atom(Id(i, "a"), i == 1 ? "" : Id(i - 1, "a"), 65)).ToList();
        Assert.Equal(40_000, Crdt.Visible(nodes).Count);
    }
}
