using System.Text.RegularExpressions;
using Serilog.Core;
using Serilog.Events;

namespace Sathi.Core.Observability;

/// <summary>
/// Redaction rules (contract §8): mask values whose key matches password|secret|token|authorization|cookie|api[_-]?key|email,
/// and string values matching email / bearer / sk- patterns.
/// </summary>
public static partial class Redactor
{
    public const string Mask = "***";

    [GeneratedRegex(@"password|secret|token|authorization|cookie|api[_-]?key|email", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex SensitiveKeyRegex();

    [GeneratedRegex(@"[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}", RegexOptions.CultureInvariant)]
    private static partial Regex EmailRegex();

    [GeneratedRegex(@"(?i)bearer\s+[A-Za-z0-9\-._~+/]+=*", RegexOptions.CultureInvariant)]
    private static partial Regex BearerRegex();

    [GeneratedRegex(@"\bsk-[A-Za-z0-9_\-]{8,}", RegexOptions.CultureInvariant)]
    private static partial Regex SkKeyRegex();

    // Keys we deliberately allow although they match the pattern (they are not secrets).
    private static readonly HashSet<string> AllowedKeys = new(StringComparer.OrdinalIgnoreCase)
    {
        "input_tokens", "output_tokens", "InputTokens", "OutputTokens", "inputTokens", "outputTokens",
        "token_count", "email_confirmed", "EmailConfirmed",
    };

    public static bool IsSensitiveKey(string key) => !AllowedKeys.Contains(key) && SensitiveKeyRegex().IsMatch(key);

    public static string RedactText(string value)
    {
        if (string.IsNullOrEmpty(value)) return value;
        var s = BearerRegex().Replace(value, "Bearer " + Mask);
        s = SkKeyRegex().Replace(s, Mask);
        s = EmailRegex().Replace(s, Mask);
        return s;
    }

    public static LogEventPropertyValue Redact(string? key, LogEventPropertyValue value)
    {
        if (key is not null && IsSensitiveKey(key)) return new ScalarValue(Mask);
        return value switch
        {
            ScalarValue { Value: string s } => new ScalarValue(RedactText(s)),
            StructureValue sv => new StructureValue(
                sv.Properties.Select(p => new LogEventProperty(p.Name, Redact(p.Name, p.Value))), sv.TypeTag),
            SequenceValue seq => new SequenceValue(seq.Elements.Select(e => Redact(null, e))),
            DictionaryValue dv => new DictionaryValue(dv.Elements.Select(kv =>
                new KeyValuePair<ScalarValue, LogEventPropertyValue>(kv.Key, Redact(kv.Key.Value?.ToString(), kv.Value)))),
            _ => value,
        };
    }
}

/// <summary>Runs last in the enricher chain: masks sensitive properties (including those from LogContext).</summary>
public sealed class RedactionEnricher : ILogEventEnricher
{
    public void Enrich(LogEvent logEvent, ILogEventPropertyFactory propertyFactory)
    {
        foreach (var (name, value) in logEvent.Properties.ToArray())
        {
            var redacted = Redactor.Redact(name, value);
            if (!ReferenceEquals(redacted, value))
                logEvent.AddOrUpdateProperty(new LogEventProperty(name, redacted));
        }
    }
}

/// <summary>Destructuring policy: objects logged with {@x} have sensitive members masked.</summary>
public sealed class RedactingDestructuringPolicy : IDestructuringPolicy
{
    public bool TryDestructure(object value, ILogEventPropertyValueFactory propertyValueFactory, out LogEventPropertyValue result)
    {
        result = null!;
        if (value is string || value.GetType().IsPrimitive || value is System.Collections.IEnumerable) return false;
        var type = value.GetType();
        if (type.Namespace is { } ns && (ns.StartsWith("System", StringComparison.Ordinal) || ns.StartsWith("Microsoft", StringComparison.Ordinal)))
            return false;

        var props = type.GetProperties(System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.Instance)
            .Where(p => p.CanRead && p.GetIndexParameters().Length == 0)
            .ToArray();
        if (props.Length == 0) return false;

        var list = new List<LogEventProperty>(props.Length);
        foreach (var p in props)
        {
            if (Redactor.IsSensitiveKey(p.Name))
            {
                list.Add(new LogEventProperty(p.Name, new ScalarValue(Redactor.Mask)));
                continue;
            }
            object? v;
            try { v = p.GetValue(value); } catch { v = null; }
            list.Add(new LogEventProperty(p.Name, Redactor.Redact(p.Name, propertyValueFactory.CreatePropertyValue(v, true))));
        }
        result = new StructureValue(list, type.Name);
        return true;
    }
}
