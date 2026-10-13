using System.Diagnostics;
using System.Diagnostics.Metrics;
using System.Globalization;

namespace SyncSpace;

public static class Telemetry
{
    public static readonly ActivitySource Activities = new("SyncSpace");
    public static readonly Meter Meter = new("SyncSpace");
    private static readonly Counter<long> Commits = Meter.CreateCounter<long>("syncspace.edits.committed");
    private static readonly Histogram<double> Latency = Meter.CreateHistogram<double>("syncspace.commit.duration", "ms");
    private static readonly double[] Bounds = [5, 10, 25, 50, 100, 250, 500, 1000, 5000];
    private static readonly long[] Buckets = new long[Bounds.Length];
    private static long connections, commits, errors;
    private static double duration;
    private static readonly object Gate = new();
    static Telemetry() => Meter.CreateObservableGauge("syncspace.connections", () => Interlocked.Read(ref connections));
    public static void Connection(int delta) => Interlocked.Add(ref connections, delta);
    public static void Error() => Interlocked.Increment(ref errors);
    public static void Commit(double ms)
    {
        Commits.Add(1); Latency.Record(ms);
        lock (Gate) { commits++; duration += ms; for (var i = 0; i < Bounds.Length; i++) if (ms <= Bounds[i]) Buckets[i]++; }
    }
    public static string Prometheus()
    {
        lock (Gate)
        {
            var lines = new List<string> { "# TYPE syncspace_connections gauge", $"syncspace_connections {Interlocked.Read(ref connections)}",
                "# TYPE syncspace_commits_total counter", $"syncspace_commits_total {commits}",
                "# TYPE syncspace_errors_total counter", $"syncspace_errors_total {Interlocked.Read(ref errors)}",
                "# TYPE syncspace_commit_duration_ms histogram" };
            for (var i = 0; i < Bounds.Length; i++) lines.Add($"syncspace_commit_duration_ms_bucket{{le=\"{Bounds[i]}\"}} {Buckets[i]}");
            lines.Add($"syncspace_commit_duration_ms_bucket{{le=\"+Inf\"}} {commits}");
            lines.Add($"syncspace_commit_duration_ms_count {commits}");
            lines.Add($"syncspace_commit_duration_ms_sum {duration.ToString(CultureInfo.InvariantCulture)}");
            return string.Join('\n', lines) + "\n";
        }
    }
}
