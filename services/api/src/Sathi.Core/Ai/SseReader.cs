using System.Runtime.CompilerServices;
using System.Text;

namespace Sathi.Core.Ai;

/// <summary>Minimal text/event-stream parser: "event:", "data:" (multi-line joined by \n), ":" comments, blank line dispatch.</summary>
public static class SseReader
{
    public static async IAsyncEnumerable<SseEvent> ReadAsync(Stream stream, [EnumeratorCancellation] CancellationToken ct)
    {
        using var reader = new StreamReader(stream, Encoding.UTF8, detectEncodingFromByteOrderMarks: false, bufferSize: 4096, leaveOpen: true);
        string? eventName = null;
        var data = new StringBuilder();

        while (true)
        {
            var line = await reader.ReadLineAsync(ct).ConfigureAwait(false);
            if (line is null)
            {
                if (data.Length > 0 || eventName is not null)
                    yield return new SseEvent(eventName ?? "message", data.ToString());
                yield break;
            }

            if (line.Length == 0)
            {
                if (data.Length > 0 || eventName is not null)
                {
                    yield return new SseEvent(eventName ?? "message", data.ToString());
                    eventName = null;
                    data.Clear();
                }
                continue;
            }

            if (line[0] == ':') continue;

            var idx = line.IndexOf(':');
            var field = idx < 0 ? line : line[..idx];
            var value = idx < 0 ? "" : line[(idx + 1)..];
            if (value.StartsWith(' ')) value = value[1..];

            switch (field)
            {
                case "event": eventName = value; break;
                case "data":
                    if (data.Length > 0) data.Append('\n');
                    data.Append(value);
                    break;
            }
        }
    }
}
