using System.Text;
using System.Text.Json;

namespace Sathi.Api.Modules.Tutor;

/// <summary>
/// Serialised writes of SSE frames to the browser. Any write failure (disconnect, timeout) flips <see cref="IsGone"/> and is
/// swallowed, so the caller keeps consuming the upstream stream and still persists the final message.
/// </summary>
public sealed class SseWriter(HttpResponse response, CancellationToken browserAborted, TimeSpan writeTimeout, ILogger logger)
{
    public static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    private readonly SemaphoreSlim _gate = new(1, 1);
    private volatile bool _gone;

    public bool IsGone => _gone;

    public Task EventAsync(string name, object data) =>
        WriteAsync($"event: {name}\ndata: {JsonSerializer.Serialize(data, Json)}\n\n");

    public Task EventRawAsync(string name, string json) => WriteAsync($"event: {name}\ndata: {json}\n\n");

    public Task PingAsync() => WriteAsync(": ping\n\n");

    private async Task WriteAsync(string frame)
    {
        if (_gone) return;
        await _gate.WaitAsync().ConfigureAwait(false);
        try
        {
            if (_gone) return;
            using var cts = CancellationTokenSource.CreateLinkedTokenSource(browserAborted);
            cts.CancelAfter(writeTimeout);
            await response.Body.WriteAsync(Encoding.UTF8.GetBytes(frame), cts.Token).ConfigureAwait(false);
            await response.Body.FlushAsync(cts.Token).ConfigureAwait(false);
        }
        catch (Exception ex) when (ex is OperationCanceledException or IOException or ObjectDisposedException or InvalidOperationException)
        {
            _gone = true;
            logger.LogDebug("Browser stream closed ({exception_type}); continuing upstream", ex.GetType().Name);
        }
        finally
        {
            _gate.Release();
        }
    }
}
