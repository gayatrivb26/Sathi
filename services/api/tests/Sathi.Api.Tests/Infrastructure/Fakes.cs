using System.Collections.Concurrent;
using System.Globalization;
using Hangfire;
using Hangfire.Common;
using Hangfire.States;
using Sathi.Core.Email;
using Sathi.Core.Observability;
using Sathi.Core.Storage;
using Serilog.Core;
using Serilog.Events;

namespace Sathi.Api.Tests.Infrastructure;

public sealed class FakeEmailSender : IAppEmailSender
{
    public ConcurrentQueue<EmailMessage> Sent { get; } = new();

    public Task SendAsync(EmailMessage message, CancellationToken ct)
    {
        Sent.Enqueue(message);
        return Task.CompletedTask;
    }

    public EmailMessage LastTo(string email) => Sent.Reverse().First(m => string.Equals(m.To, email, StringComparison.OrdinalIgnoreCase));
}

public sealed class FakeObjectStorage : IObjectStorage
{
    public ConcurrentDictionary<string, byte[]> Objects { get; } = new();

    public async Task PutAsync(string key, Stream content, string contentType, CancellationToken ct)
    {
        using var ms = new MemoryStream();
        await content.CopyToAsync(ms, ct);
        Objects[key] = ms.ToArray();
    }

    public Task DeleteAsync(string key, CancellationToken ct) { Objects.TryRemove(key, out _); return Task.CompletedTask; }

    public Task DeletePrefixAsync(string prefix, CancellationToken ct)
    {
        foreach (var k in Objects.Keys.Where(k => k.StartsWith(prefix, StringComparison.Ordinal))) Objects.TryRemove(k, out _);
        return Task.CompletedTask;
    }

    public Task<bool> IsHealthyAsync(CancellationToken ct) => Task.FromResult(true);
}

public sealed record EnqueuedJob(string Id, Job Job, string Queue);

/// <summary>Records enqueued jobs instead of writing to Hangfire storage.</summary>
public sealed class FakeBackgroundJobClient : IBackgroundJobClient
{
    private int _next;
    public ConcurrentQueue<EnqueuedJob> Jobs { get; } = new();

    public string Create(Job job, IState state)
    {
        var id = Interlocked.Increment(ref _next).ToString(CultureInfo.InvariantCulture);
        Jobs.Enqueue(new EnqueuedJob(id, job, (state as EnqueuedState)?.Queue ?? "default"));
        return id;
    }

    public bool ChangeState(string jobId, IState state, string expectedState) => true;
}

/// <summary>Captures every log event rendered exactly as production writes it (contract §8 JSON).</summary>
public sealed class CapturingLogSink : ILogEventSink
{
    private readonly SathiJsonFormatter _formatter = new();
    public ConcurrentQueue<string> Lines { get; } = new();

    public void Emit(LogEvent logEvent)
    {
        using var sw = new StringWriter(CultureInfo.InvariantCulture);
        _formatter.Format(logEvent, sw);
        Lines.Enqueue(sw.ToString());
    }

    public string All => string.Join("", Lines);
}
