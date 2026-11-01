using System.Collections.Concurrent;

namespace Sathi.Api.Modules.Tutor;

/// <summary>
/// In-process registry of live tutor streams (contract §11.5): assistant message id → the CancellationTokenSource that aborts the
/// upstream AI-service request. Singleton. Cancel across several API instances needs a shared channel (e.g. Redis pub/sub) — later.
/// </summary>
public sealed class ActiveTutorRuns
{
    private readonly ConcurrentDictionary<Guid, Run> _runs = new();

    public sealed class Run : IDisposable
    {
        private readonly CancellationTokenSource _cts = new();
        private int _cancelRequested;

        public Run(Guid userId, Guid conversationId)
        {
            UserId = userId;
            ConversationId = conversationId;
        }

        public Guid UserId { get; }
        public Guid ConversationId { get; }
        public CancellationToken Token => _cts.Token;
        public bool CancelRequested => Volatile.Read(ref _cancelRequested) == 1;

        public void Cancel()
        {
            Interlocked.Exchange(ref _cancelRequested, 1);
            try { _cts.Cancel(); }
            catch (ObjectDisposedException) { /* the stream already finished */ }
        }

        public void Dispose() => _cts.Dispose();
    }

    public int Count => _runs.Count;

    public Run Register(Guid messageId, Guid userId, Guid conversationId)
    {
        var run = new Run(userId, conversationId);
        _runs[messageId] = run;
        return run;
    }

    /// <summary>Removes and disposes the entry (call after the final message has been persisted).</summary>
    public void Unregister(Guid messageId)
    {
        if (_runs.TryRemove(messageId, out var run)) run.Dispose();
    }

    public bool IsActive(Guid messageId) => _runs.ContainsKey(messageId);

    /// <summary>Signals cancellation; false when the message is not streaming on this instance.</summary>
    public bool TryCancel(Guid messageId)
    {
        if (!_runs.TryGetValue(messageId, out var run)) return false;
        run.Cancel();
        return true;
    }
}
