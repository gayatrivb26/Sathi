using System.Diagnostics;
using Hangfire;
using Hangfire.Client;
using Hangfire.Common;
using Hangfire.Server;
using Hangfire.States;
using Hangfire.Storage;
using Microsoft.Extensions.Logging;
using Serilog.Context;
using Sathi.Core.Ai;
using Sathi.Core.Observability;

namespace Sathi.Core.Jobs;

public static class JobQueues
{
    public const string Critical = "critical";
    public const string Default = "default";
    public const string AiHeavy = "ai-heavy";
    public static readonly string[] All = [Critical, Default, AiHeavy];
}

public static class JobRetry
{
    public const int Attempts = 3;
    public static readonly int[] Delays = [10, 60, 300];
}

/// <summary>Thrown for failures that must not be retried (e.g. INGEST_NO_TEXT). Excluded from AutomaticRetry.</summary>
public sealed class NonRetryableJobException(string code, string message, Exception? inner = null) : Exception($"{code}: {message}", inner)
{
    public string Code { get; } = code;
}

/// <summary>Ambient info about the job being performed (set by <see cref="JobObservabilityFilter"/>).</summary>
public sealed record JobContext(string JobId, int RetryCount)
{
    private static readonly AsyncLocal<JobContext?> Ambient = new();

    public static JobContext? Current
    {
        get => Ambient.Value;
        set => Ambient.Value = value;
    }

    /// <summary>True when a failure now will not be retried by AutomaticRetry (3 retries after the first run).</summary>
    public bool IsFinalAttempt => RetryCount >= JobRetry.Attempts;

    public int Attempt => RetryCount + 1;
}

/// <summary>Typed enqueueing so the API and jobs host enqueue by type onto the right queue.</summary>
public sealed class JobScheduler(IBackgroundJobClient client)
{
    private static readonly CancellationToken None = CancellationToken.None;

    public string EnqueueIngestDocument(Guid documentId, int version, string? traceParent, Guid runId) =>
        client.Create(Job.FromExpression<IngestDocumentJob>(j => j.ExecuteAsync(documentId, version, traceParent, runId, None)),
            new EnqueuedState(JobQueues.AiHeavy));

    public string EnqueueIndexLesson(Guid lessonId, int version, string? traceParent) =>
        client.Create(Job.FromExpression<IndexLessonJob>(j => j.ExecuteAsync(lessonId, version, traceParent, None)),
            new EnqueuedState(JobQueues.Default));

    public string EnqueueSyncLessonIndex() =>
        client.Create(Job.FromExpression<SyncLessonIndexJob>(j => j.ExecuteAsync(None)), new EnqueuedState(JobQueues.Default));

    public string EnqueueGradeAnswer(Guid gradingResultId, string? traceParent, Guid runId) =>
        client.Create(Job.FromExpression<GradeAnswerJob>(j => j.ExecuteAsync(gradingResultId, traceParent, runId, None)),
            new EnqueuedState(JobQueues.Critical));

    public string EnqueueGenerateQuestions(Guid courseId, Guid conceptId, int count, double difficulty, Guid requestedBy, string? traceParent, Guid runId) =>
        client.Create(Job.FromExpression<GenerateQuestionsJob>(j =>
                j.ExecuteAsync(courseId, conceptId, count, difficulty, requestedBy, traceParent, runId, None)),
            new EnqueuedState(JobQueues.AiHeavy));

    public string EnqueueRecomputeRecommendations(Guid userId, Guid courseId) =>
        client.Create(Job.FromExpression<RecomputeRecommendationsJob>(j => j.ExecuteAsync(userId, courseId, None)),
            new EnqueuedState(JobQueues.Default));
}

/// <summary>
/// Hangfire filter (client + server + state): restores the trace context from the job's traceParent argument (starting an
/// Activity with that parent), pushes job_id / attempt / run_id into the Serilog LogContext and writes job.state lines
/// (created, processing, succeeded, failed, retrying).
/// </summary>
public sealed class JobObservabilityFilter(ILoggerFactory loggerFactory, SathiMetrics? metrics = null)
    : JobFilterAttribute, IClientFilter, IServerFilter, IApplyStateFilter
{
    private static readonly EventId JobState = new(4001, "job.state");
    private static readonly ActivitySource Source = new("Sathi.Jobs");
    private const string ScopeKey = "sathi.observability";
    private readonly ILogger _logger = loggerFactory.CreateLogger("Sathi.Jobs.State");

    private sealed class Scope(Activity? activity, IDisposable logScope, Stopwatch watch)
    {
        public Activity? Activity { get; } = activity;
        public IDisposable LogScope { get; } = logScope;
        public Stopwatch Watch { get; } = watch;
    }

    // ---- client ----
    public void OnCreating(CreatingContext context) { }

    public void OnCreated(CreatedContext context)
    {
        if (context.BackgroundJob is null) return;
        _logger.LogInformation(JobState, "Job {job_type} {state} ({job_id})",
            JobType(context.Job), "created", context.BackgroundJob.Id);
    }

    // ---- server ----
    public void OnPerforming(PerformingContext context)
    {
        var job = context.BackgroundJob.Job;
        var traceParent = Arg(job, "traceParent") as string;
        var runId = Arg(job, "runId");
        var retryCount = RetryCount(context.Connection, context.BackgroundJob.Id);
        var name = "job " + JobType(job);

        Activity? activity = null;
        if (!string.IsNullOrEmpty(traceParent) && ActivityContext.TryParse(traceParent, null, out var parent))
        {
            activity = Source.StartActivity(name, ActivityKind.Consumer, parent);
            if (activity is null)
            {
                activity = new Activity(name);
                activity.SetParentId(traceParent);
                activity.Start();
            }
        }
        else
        {
            activity = Source.StartActivity(name, ActivityKind.Consumer) ?? new Activity(name).Start();
        }
        activity.SetTag("hangfire.job_id", context.BackgroundJob.Id);
        activity.SetTag("hangfire.attempt", retryCount + 1);

        var props = new List<IDisposable>
        {
            LogContext.PushProperty("job_id", context.BackgroundJob.Id),
            LogContext.PushProperty("attempt", retryCount + 1),
            LogContext.PushProperty("job_type", JobType(job)),
        };
        if (runId is not null) props.Add(LogContext.PushProperty("run_id", runId.ToString()));
        if (Arg(job, "documentId") is { } doc) props.Add(LogContext.PushProperty("document_id", doc.ToString()));

        RequestCorrelation.RequestId = "job-" + context.BackgroundJob.Id;
        JobContext.Current = new JobContext(context.BackgroundJob.Id, retryCount);
        context.Items[ScopeKey] = new Scope(activity, new CompositeDisposable(props), Stopwatch.StartNew());
    }

    public void OnPerformed(PerformedContext context)
    {
        if (context.Items.TryGetValue(ScopeKey, out var o) && o is Scope scope)
        {
            scope.Watch.Stop();
            if (context.Exception is not null && scope.Activity is not null)
                scope.Activity.SetStatus(ActivityStatusCode.Error, context.Exception.GetType().Name);
            scope.Activity?.SetTag("duration_ms", scope.Watch.ElapsedMilliseconds);
            scope.Activity?.Stop();
            scope.LogScope.Dispose();
        }
        JobContext.Current = null;
        RequestCorrelation.RequestId = null;
    }

    // ---- state ----
    public void OnStateApplied(ApplyStateContext context, IWriteOnlyTransaction transaction)
    {
        var job = context.BackgroundJob;
        var stateName = context.NewState.Name;
        var reason = context.NewState.Reason ?? "";
        string state;
        var level = LogLevel.Information;
        Exception? ex = null;

        if (stateName == ProcessingState.StateName) state = "processing";
        else if (stateName == SucceededState.StateName) state = "succeeded";
        else if (stateName == FailedState.StateName)
        {
            state = "failed";
            level = LogLevel.Error;
            ex = (context.NewState as FailedState)?.Exception;
            metrics?.JobsFailed.Add(1, new KeyValuePair<string, object?>("queue", QueueOf(context.BackgroundJob.Job)),
                new KeyValuePair<string, object?>("job_type", JobType(context.BackgroundJob.Job)));
        }
        else if (stateName == ScheduledState.StateName && reason.StartsWith("Retry", StringComparison.OrdinalIgnoreCase))
        {
            state = "retrying";
            level = LogLevel.Warning;
        }
        else if (stateName == DeletedState.StateName) state = "deleted";
        else
        {
            state = stateName.ToLowerInvariant();
            level = LogLevel.Debug;
        }

        var traceParent = Arg(job.Job, "traceParent") as string;
        var traceId = traceParent?.Split('-') is { Length: >= 2 } parts ? parts[1] : null;
        var attempt = RetryCount(context.Connection, job.Id) + 1;

        using (traceId is not null && Activity.Current is null ? LogContext.PushProperty("trace_id", traceId) : null)
        using (LogContext.PushProperty("attempt", attempt))
        {
            if (state == "retrying")
                _logger.Log(level, JobState, "Job {job_type} {state} ({job_id}): {reason}", JobType(job.Job), state, job.Id, Truncate(reason));
            else
                _logger.Log(level, JobState, ex, "Job {job_type} {state} ({job_id})", JobType(job.Job), state, job.Id);
        }
    }

    public void OnStateUnapplied(ApplyStateContext context, IWriteOnlyTransaction transaction) { }

    // ---- helpers ----
    private static string JobType(Job? job) => job?.Type.Name ?? "unknown";

    private static string QueueOf(Job? job)
    {
        if (job is null) return JobQueues.Default;
        if (!string.IsNullOrEmpty(job.Queue)) return job.Queue;
        var attr = job.Method.GetCustomAttributes(typeof(QueueAttribute), true).OfType<QueueAttribute>().FirstOrDefault();
        return attr?.Queue ?? JobQueues.Default;
    }

    private static object? Arg(Job? job, string name)
    {
        if (job is null) return null;
        var ps = job.Method.GetParameters();
        for (var i = 0; i < ps.Length && i < job.Args.Count; i++)
            if (string.Equals(ps[i].Name, name, StringComparison.Ordinal)) return job.Args[i];
        return null;
    }

    private static int RetryCount(IStorageConnection? connection, string jobId)
    {
        try
        {
            var raw = connection?.GetJobParameter(jobId, "RetryCount");
            return int.TryParse(raw?.Trim('"'), out var n) ? n : 0;
        }
        catch
        {
            return 0;
        }
    }

    private static string Truncate(string s) => s.Length > 300 ? s[..300] + "…" : s;

    private sealed class CompositeDisposable(List<IDisposable> items) : IDisposable
    {
        public void Dispose()
        {
            for (var i = items.Count - 1; i >= 0; i--) items[i].Dispose();
        }
    }
}
