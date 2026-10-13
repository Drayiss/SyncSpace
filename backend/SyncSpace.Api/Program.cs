using System.Threading.RateLimiting;
using Npgsql;
using OpenTelemetry.Metrics;
using OpenTelemetry.Resources;
using OpenTelemetry.Trace;
using StackExchange.Redis;
using SyncSpace;

var builder = WebApplication.CreateBuilder(args);
builder.Logging.ClearProviders(); builder.Logging.AddJsonConsole(options => options.IncludeScopes = true);
builder.Services.Configure<Microsoft.AspNetCore.Http.Json.JsonOptions>(o => o.SerializerOptions.PropertyNamingPolicy = System.Text.Json.JsonNamingPolicy.CamelCase);
var postgresOptions = new NpgsqlConnectionStringBuilder(builder.Configuration.GetConnectionString("Postgres")
    ?? "Host=localhost;Port=5432;Database=syncspace;Username=syncspace;Password=syncspace_local_only")
{ MaxPoolSize = builder.Configuration.GetValue("DatabasePoolSize", 10), ApplicationName = "syncspace" };
builder.Services.AddSingleton(NpgsqlDataSource.Create(postgresOptions.ConnectionString));
builder.Services.AddSingleton<IConnectionMultiplexer>(_ => ConnectionMultiplexer.Connect(
    builder.Configuration.GetConnectionString("Redis") ?? "localhost:6379,abortConnect=false"));
builder.Services.AddSingleton<Store>(); builder.Services.AddSingleton<Realtime>();
builder.Services.AddHostedService(sp => sp.GetRequiredService<Realtime>());
builder.Services.AddOpenTelemetry().ConfigureResource(r => r.AddService("syncspace-api", serviceInstanceId: Environment.MachineName))
    .WithTracing(t =>
    {
        t.AddAspNetCoreInstrumentation().AddHttpClientInstrumentation().AddSource("SyncSpace", "Npgsql");
        if (!string.IsNullOrEmpty(builder.Configuration["OTEL_EXPORTER_OTLP_ENDPOINT"])) t.AddOtlpExporter();
    })
    .WithMetrics(m =>
    {
        m.AddAspNetCoreInstrumentation().AddRuntimeInstrumentationSafe().AddMeter("SyncSpace");
        if (!string.IsNullOrEmpty(builder.Configuration["OTEL_EXPORTER_OTLP_ENDPOINT"]) && builder.Configuration.GetValue("Telemetry:ExportMetrics", true)) m.AddOtlpExporter();
    });
builder.Services.AddRateLimiter(options =>
{
    options.RejectionStatusCode = 429; options.AddPolicy("create", context => RateLimitPartition.GetFixedWindowLimiter(
    context.Connection.RemoteIpAddress?.ToString() ?? "unknown", _ => new() { PermitLimit = 20, Window = TimeSpan.FromMinutes(1), QueueLimit = 0 }));
});
builder.Services.AddCors(o => o.AddDefaultPolicy(p => p.WithOrigins((builder.Configuration["AllowedOrigins"] ?? "http://localhost:5173,http://127.0.0.1:5173,http://localhost:5080,http://127.0.0.1:5080,http://localhost:5081,http://127.0.0.1:5081").Split(',')).AllowAnyHeader().AllowAnyMethod()));
builder.WebHost.ConfigureKestrel(o => o.Limits.MaxRequestBodySize = 1_048_576);
var app = builder.Build();
await app.Services.GetRequiredService<Store>().Initialize();
app.Use(async (ctx, next) =>
{
    ctx.Response.Headers["X-Content-Type-Options"] = "nosniff";
    ctx.Response.Headers["Referrer-Policy"] = "no-referrer";
    ctx.Response.Headers["Content-Security-Policy"] = "default-src 'self'; connect-src 'self' ws: wss:; style-src 'self'; script-src 'self'; img-src 'self' data:; frame-ancestors 'none'";
    try { await next(); }
    catch (Exception ex) when (ex is not OperationCanceledException)
    {
        Telemetry.Error(); app.Logger.LogError(ex, "Request failed {TraceId}", ctx.TraceIdentifier);
        if (!ctx.Response.HasStarted) { ctx.Response.StatusCode = 503; await ctx.Response.WriteAsJsonAsync(new { message = "Service temporarily unavailable", traceId = ctx.TraceIdentifier }); }
    }
});
app.UseCors(); app.UseRateLimiter();
var sockets = new WebSocketOptions { KeepAliveInterval = TimeSpan.FromSeconds(20), KeepAliveTimeout = TimeSpan.FromSeconds(15) };
foreach (var origin in (builder.Configuration["AllowedOrigins"] ?? "http://localhost:5173,http://127.0.0.1:5173,http://localhost:5080,http://127.0.0.1:5080,http://localhost:5081,http://127.0.0.1:5081").Split(',')) sockets.AllowedOrigins.Add(origin);
app.UseWebSockets(sockets);
app.MapGet("/health/live", () => Results.Ok(new { status = "ok" }));
app.MapGet("/health/ready", async (Store store, IConnectionMultiplexer redis, CancellationToken ct) =>
{
    await store.Ping(ct); await redis.GetDatabase().PingAsync(); return Results.Ok(new { status = "ready" });
});
app.MapGet("/metrics", () => Results.Text(Telemetry.Prometheus(), "text/plain; version=0.0.4"));
app.MapPost("/api/documents", async (CreateDocument body, Store store, CancellationToken ct) => Results.Json(await store.Create(body.Title, ct), statusCode: 201)).RequireRateLimiting("create");
var documents = app.MapGroup("/api/documents/{id:guid}");
documents.AddEndpointFilter(async (context, next) =>
{
    var http = context.HttpContext; var id = Guid.Parse(http.Request.RouteValues["id"]!.ToString()!);
    var header = http.Request.Headers.Authorization.ToString();
    if (!header.StartsWith("Bearer ", StringComparison.Ordinal) || !await http.RequestServices.GetRequiredService<Store>().Authorize(id, header[7..], http.RequestAborted)) return Results.Unauthorized();
    http.Response.Headers.CacheControl = "no-store";
    return await next(context);
});
documents.MapGet("", async (Guid id, Store store, CancellationToken ct) => Results.Ok(await store.Read(id, ct)));
documents.MapPut("/title", async (Guid id, CreateDocument body, Store store, Realtime realtime, CancellationToken ct) =>
{
    await store.Rename(id, body.Title ?? "Untitled document", ct); await realtime.Publish(new("metadata", id)); return Results.NoContent();
});
documents.MapGet("/history", async (Guid id, long? before, Store store, CancellationToken ct) => Results.Ok(await store.History(id, before ?? long.MaxValue, ct)));
documents.MapGet("/history/{revision:long}", async (Guid id, long revision, Store store, CancellationToken ct) =>
    await store.Version(id, revision, ct) is { } version ? Results.Ok(version) : Results.NotFound());
app.Map("/ws/documents/{id:guid}", async (HttpContext context, Guid id, Realtime realtime) => await realtime.Connect(context, id));
app.UseDefaultFiles(); app.UseStaticFiles(); app.MapFallbackToFile("index.html");
app.Run();
record CreateDocument(string? Title);

// Runtime metrics already exposed by ASP.NET Core; keep dependencies minimal.
static class MetricsExtensions { public static MeterProviderBuilder AddRuntimeInstrumentationSafe(this MeterProviderBuilder builder) => builder.AddMeter("System.Runtime"); }
