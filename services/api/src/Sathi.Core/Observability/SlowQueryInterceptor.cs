using System.Data.Common;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using Sathi.Core.Options;

namespace Sathi.Core.Observability;

/// <summary>Logs commands slower than Observability:SlowQueryMs at Warning (event db.slow_query). SQL text only, never parameters.</summary>
public sealed class SlowQueryInterceptor(IOptions<ObservabilityOptions> options, ILogger<SlowQueryInterceptor> logger) : DbCommandInterceptor
{
    private static readonly EventId SlowQuery = new(5001, "db.slow_query");
    private readonly int _thresholdMs = options.Value.SlowQueryMs;

    private void Check(DbCommand command, CommandExecutedEventData data)
    {
        var ms = data.Duration.TotalMilliseconds;
        if (ms < _thresholdMs) return;
        var sql = command.CommandText.Length > 500 ? command.CommandText[..500] + "…" : command.CommandText;
        logger.LogWarning(SlowQuery, "Slow query {duration_ms} ms (threshold {threshold_ms} ms): {sql}", (int)ms, _thresholdMs, sql);
    }

    public override DbDataReader ReaderExecuted(DbCommand command, CommandExecutedEventData eventData, DbDataReader result)
    { Check(command, eventData); return result; }

    public override ValueTask<DbDataReader> ReaderExecutedAsync(DbCommand command, CommandExecutedEventData eventData, DbDataReader result, CancellationToken cancellationToken = default)
    { Check(command, eventData); return ValueTask.FromResult(result); }

    public override int NonQueryExecuted(DbCommand command, CommandExecutedEventData eventData, int result)
    { Check(command, eventData); return result; }

    public override ValueTask<int> NonQueryExecutedAsync(DbCommand command, CommandExecutedEventData eventData, int result, CancellationToken cancellationToken = default)
    { Check(command, eventData); return ValueTask.FromResult(result); }

    public override object? ScalarExecuted(DbCommand command, CommandExecutedEventData eventData, object? result)
    { Check(command, eventData); return result; }

    public override ValueTask<object?> ScalarExecutedAsync(DbCommand command, CommandExecutedEventData eventData, object? result, CancellationToken cancellationToken = default)
    { Check(command, eventData); return ValueTask.FromResult(result); }
}
