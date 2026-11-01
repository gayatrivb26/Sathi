using System.Globalization;
using System.Text;
using System.Text.Json;
using Serilog.Events;
using Serilog.Formatting;
using Serilog.Parsing;

namespace Sathi.Core.Observability;

/// <summary>
/// One JSON object per line with the contract §8 field names:
/// timestamp, level, message, service, env, version, trace_id, span_id, request_id, user_id_hash, event, ...contextual fields,
/// exception_type, exception_message, stack. PascalCase property names are converted to snake_case.
/// </summary>
public sealed class SathiJsonFormatter : ITextFormatter
{
    private static readonly JsonWriterOptions WriterOptions = new() { Indented = false, SkipValidation = true };

    private static readonly HashSet<string> Skip = new(StringComparer.Ordinal)
    {
        "service", "env", "version", "trace_id", "span_id", "request_id", "user_id_hash", "EventId", "event",
        "MessageTemplate", "{OriginalFormat}", "ActionId", "ConnectionId", "RequestId", "HostingRequestStartingLog",
        "HostingRequestFinishedLog",
    };

    public void Format(LogEvent logEvent, TextWriter output)
    {
        using var ms = new MemoryStream();
        using (var w = new Utf8JsonWriter(ms, WriterOptions))
        {
            w.WriteStartObject();
            w.WriteString("timestamp", logEvent.Timestamp.UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture));
            w.WriteString("level", Level(logEvent.Level));
            w.WriteString("message", Redactor.RedactText(RenderMessage(logEvent)));

            WriteScalar(w, "service", logEvent, "service");
            WriteScalar(w, "env", logEvent, "env");
            WriteScalar(w, "version", logEvent, "version");

            var traceId = logEvent.TraceId?.ToHexString();
            if (string.IsNullOrEmpty(traceId) && logEvent.Properties.TryGetValue("trace_id", out var t)) traceId = Scalar(t);
            if (!string.IsNullOrEmpty(traceId) && traceId != "00000000000000000000000000000000") w.WriteString("trace_id", traceId);
            var spanId = logEvent.SpanId?.ToHexString();
            if (string.IsNullOrEmpty(spanId) && logEvent.Properties.TryGetValue("span_id", out var s)) spanId = Scalar(s);
            if (!string.IsNullOrEmpty(spanId) && spanId != "0000000000000000") w.WriteString("span_id", spanId);

            WriteScalar(w, "request_id", logEvent, "request_id");
            WriteScalar(w, "user_id_hash", logEvent, "user_id_hash");

            string? evt = null;
            if (logEvent.Properties.TryGetValue("event", out var ev)) evt = Scalar(ev);
            if (evt is null && logEvent.Properties.TryGetValue("EventId", out var eid) && eid is StructureValue sv)
                evt = sv.Properties.FirstOrDefault(p => p.Name == "Name")?.Value is ScalarValue { Value: string n } ? n : null;
            if (!string.IsNullOrEmpty(evt)) w.WriteString("event", evt);

            foreach (var (key, value) in logEvent.Properties)
            {
                if (Skip.Contains(key)) continue;
                var name = key == "SourceContext" ? "logger" : SnakeCase(key);
                w.WritePropertyName(name);
                WriteValue(w, value);
            }

            if (logEvent.Exception is { } ex)
            {
                w.WriteString("exception_type", ex.GetType().FullName);
                w.WriteString("exception_message", Redactor.RedactText(ex.Message));
                w.WriteString("stack", Redactor.RedactText(ex.ToString()));
            }

            w.WriteEndObject();
        }
        output.Write(Encoding.UTF8.GetString(ms.ToArray()));
        output.Write('\n');
    }

    /// <summary>Renders the template with string values unquoted (Serilog's default quotes them).</summary>
    public static string RenderMessage(LogEvent e)
    {
        using var sw = new StringWriter(CultureInfo.InvariantCulture);
        foreach (var token in e.MessageTemplate.Tokens)
        {
            switch (token)
            {
                case TextToken text:
                    sw.Write(text.Text);
                    break;
                case PropertyToken prop when e.Properties.TryGetValue(prop.PropertyName, out var value):
                    if (value is ScalarValue { Value: string str }) sw.Write(str);
                    else value.Render(sw, prop.Format, CultureInfo.InvariantCulture);
                    break;
                default:
                    sw.Write(token.ToString());
                    break;
            }
        }
        return sw.ToString();
    }

    public static string Level(LogEventLevel level) => level switch
    {
        LogEventLevel.Verbose or LogEventLevel.Debug => "debug",
        LogEventLevel.Information => "info",
        LogEventLevel.Warning => "warning",
        _ => "error",
    };

    private static void WriteScalar(Utf8JsonWriter w, string name, LogEvent e, string key)
    {
        if (e.Properties.TryGetValue(key, out var v) && Scalar(v) is { Length: > 0 } s) w.WriteString(name, s);
    }

    private static string? Scalar(LogEventPropertyValue v) => v is ScalarValue sv ? sv.Value?.ToString() : v.ToString();

    private static void WriteValue(Utf8JsonWriter w, LogEventPropertyValue value)
    {
        switch (value)
        {
            case ScalarValue sv:
                switch (sv.Value)
                {
                    case null: w.WriteNullValue(); break;
                    case string str: w.WriteStringValue(str); break;
                    case bool b: w.WriteBooleanValue(b); break;
                    case int i: w.WriteNumberValue(i); break;
                    case long l: w.WriteNumberValue(l); break;
                    case short sh: w.WriteNumberValue(sh); break;
                    case uint ui: w.WriteNumberValue(ui); break;
                    case ulong ul: w.WriteNumberValue(ul); break;
                    case double d when double.IsFinite(d): w.WriteNumberValue(d); break;
                    case float f when float.IsFinite(f): w.WriteNumberValue(f); break;
                    case decimal m: w.WriteNumberValue(m); break;
                    case DateTime dt: w.WriteStringValue(dt.ToUniversalTime().ToString("O", CultureInfo.InvariantCulture)); break;
                    case DateTimeOffset dto: w.WriteStringValue(dto.UtcDateTime.ToString("O", CultureInfo.InvariantCulture)); break;
                    default: w.WriteStringValue(Convert.ToString(sv.Value, CultureInfo.InvariantCulture)); break;
                }
                break;
            case SequenceValue seq:
                w.WriteStartArray();
                foreach (var el in seq.Elements) WriteValue(w, el);
                w.WriteEndArray();
                break;
            case StructureValue st:
                w.WriteStartObject();
                foreach (var p in st.Properties) { w.WritePropertyName(p.Name); WriteValue(w, p.Value); }
                w.WriteEndObject();
                break;
            case DictionaryValue dv:
                w.WriteStartObject();
                foreach (var kv in dv.Elements)
                {
                    w.WritePropertyName(kv.Key.Value?.ToString() ?? "null");
                    WriteValue(w, kv.Value);
                }
                w.WriteEndObject();
                break;
            default:
                w.WriteStringValue(value.ToString());
                break;
        }
    }

    public static string SnakeCase(string name)
    {
        if (string.IsNullOrEmpty(name)) return name;
        var sb = new StringBuilder(name.Length + 8);
        for (var i = 0; i < name.Length; i++)
        {
            var c = name[i];
            if (char.IsUpper(c))
            {
                if (i > 0 && name[i - 1] != '_' && (char.IsLower(name[i - 1]) || (i + 1 < name.Length && char.IsLower(name[i + 1]))))
                    sb.Append('_');
                sb.Append(char.ToLowerInvariant(c));
            }
            else if (c == '.' || c == '-' || c == ' ') sb.Append('_');
            else sb.Append(c);
        }
        return sb.ToString();
    }
}
