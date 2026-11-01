using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using Sathi.Core.Data;
using Sathi.Core.Domain;
using Sathi.Core.Errors;
using Sathi.Core.Jobs;
using Sathi.Core.Options;
using Sathi.Core.Security;
using Sathi.Core.Storage;
using Sathi.Core.Usage;

namespace Sathi.Core.Documents;

public sealed record DocumentItem(
    Guid Id, string FileName, long SizeBytes, string ContentType, string Status, string Stage, int ProgressPercent,
    int? PassageCount, string? ErrorCode, string? ErrorMessage, string? ReferenceId, DateTime CreatedAt, DateTime UpdatedAt);

public sealed record ValidatedUpload(string Extension, string ContentType, byte[] Bytes, string Sha256, string SafeFileName);

/// <summary>Upload validation (contract §5.5): extension + magic bytes + size.</summary>
public static partial class UploadValidator
{
    private static readonly Dictionary<string, string> ContentTypes = new(StringComparer.OrdinalIgnoreCase)
    {
        [".pdf"] = "application/pdf",
        [".docx"] = "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        [".md"] = "text/markdown",
        [".txt"] = "text/plain",
    };

    [GeneratedRegex(@"[^A-Za-z0-9._\-]+")]
    private static partial Regex UnsafeChars();

    public static string SanitizeFileName(string fileName)
    {
        var name = Path.GetFileName(fileName.Replace('\\', '/').Split('/').Last());
        name = UnsafeChars().Replace(name, "_").Trim('_', '.');
        if (name.Length == 0) name = "file";
        if (name.Length > 120)
        {
            var ext = Path.GetExtension(name);
            name = name[..(120 - ext.Length)] + ext;
        }
        return name;
    }

    public static ValidatedUpload Validate(string fileName, byte[] bytes, long maxBytes)
    {
        var ext = Path.GetExtension(fileName ?? "").ToLowerInvariant();
        if (!ContentTypes.TryGetValue(ext, out var contentType))
            throw new AppException(415, ErrorCodes.UploadInvalidType, "Only PDF, Word (.docx), Markdown (.md) and text (.txt) files are allowed.");
        if (bytes.Length == 0)
            throw AppException.Validation("file", "The file is empty.");
        if (bytes.Length > maxBytes)
            throw new AppException(413, ErrorCodes.UploadTooLarge, $"Files can be at most {maxBytes / (1024 * 1024)} MB.");

        var ok = ext switch
        {
            ".pdf" => StartsWith(bytes, "%PDF-"u8),
            ".docx" => IsDocx(bytes),
            _ => IsUtf8Text(bytes),
        };
        if (!ok)
            throw new AppException(415, ErrorCodes.UploadInvalidType, "The file's contents don't match its type.");

        var sha = Convert.ToHexStringLower(SHA256.HashData(bytes));
        return new ValidatedUpload(ext, contentType, bytes, sha, SanitizeFileName(fileName!));
    }

    private static bool StartsWith(byte[] data, ReadOnlySpan<byte> magic) => data.AsSpan().StartsWith(magic);

    private static bool IsDocx(byte[] bytes)
    {
        if (!StartsWith(bytes, [0x50, 0x4B, 0x03, 0x04])) return false;
        try
        {
            using var zip = new ZipArchive(new MemoryStream(bytes, writable: false), ZipArchiveMode.Read);
            return zip.Entries.Any(e => e.FullName.StartsWith("word/", StringComparison.Ordinal));
        }
        catch (InvalidDataException)
        {
            return false;
        }
    }

    private static bool IsUtf8Text(byte[] bytes)
    {
        if (Array.IndexOf(bytes, (byte)0) >= 0) return false;
        try
        {
            _ = new UTF8Encoding(encoderShouldEmitUTF8Identifier: false, throwOnInvalidBytes: true).GetString(bytes);
            return true;
        }
        catch (DecoderFallbackException)
        {
            return false;
        }
    }
}

/// <summary>Creates, retries and deletes uploaded documents (user scope and course scope).</summary>
public sealed class DocumentService(
    AppDbContext db, IObjectStorage storage, UsageService usage, JobScheduler jobs, UserIdHasher hasher,
    IOptions<QuotaOptions> quotas, ILogger<DocumentService> logger)
{
    private static readonly EventId Upload = new(2101, "document.upload");

    /// <summary>
    /// The document previously created with this Idempotency-Key (contract §11.6): per owner for user uploads, per course for
    /// course uploads. Persisted in documents.idempotency_key, so it works across API instances and restarts.
    /// </summary>
    public Task<Document?> FindByIdempotencyKeyAsync(Guid actorUserId, string scope, Guid? courseId, string key, CancellationToken ct) =>
        scope == DocumentScopes.User
            ? db.Documents.FirstOrDefaultAsync(d => d.OwnerUserId == actorUserId && d.Scope == DocumentScopes.User && d.IdempotencyKey == key, ct)
            : db.Documents.FirstOrDefaultAsync(d => d.CourseId == courseId && d.Scope == scope && d.OwnerUserId == null && d.IdempotencyKey == key, ct);

    public async Task<DocumentItem> UploadAsync(Guid actorUserId, string scope, Guid? courseId, string fileName, byte[] bytes, string? idempotencyKey,
        CancellationToken ct)
    {
        var q = quotas.Value;
        var upload = UploadValidator.Validate(fileName, bytes, q.MaxUploadBytes);
        await usage.EnsureUploadQuotaAsync(actorUserId, ct);

        if (scope == DocumentScopes.User)
        {
            var used = await db.Documents.Where(d => d.OwnerUserId == actorUserId && d.Scope == DocumentScopes.User && d.DeletedAt == null)
                .SumAsync(d => (long?)d.SizeBytes, ct) ?? 0;
            if (used + bytes.Length > q.MaxStorageBytesPerUser)
                throw new AppException(413, ErrorCodes.UploadTooLarge,
                    $"You've reached your {q.MaxStorageBytesPerUser / (1024 * 1024)} MB storage limit. Delete some notes to upload more.");
        }

        var now = DateTime.UtcNow;
        var doc = new Document
        {
            Scope = scope,
            OwnerUserId = scope == DocumentScopes.User ? actorUserId : null,
            CourseId = courseId,
            SourceType = SourceTypes.Upload,
            FileName = Path.GetFileName(fileName).Trim() is { Length: > 0 and <= 255 } f ? f : upload.SafeFileName,
            ContentType = upload.ContentType,
            SizeBytes = bytes.Length,
            Sha256 = upload.Sha256,
            CurrentVersion = 1,
            Status = DocumentStatuses.Queued,
            IdempotencyKey = idempotencyKey,
            CreatedAt = now,
            UpdatedAt = now,
        };
        var key = scope == DocumentScopes.User
            ? $"uploads/{actorUserId}/{doc.Id}/v1/{upload.SafeFileName}"
            : $"uploads/courses/{courseId}/{doc.Id}/v1/{upload.SafeFileName}"; // §11.8: apps may only write uploads/* and lessons/*

        using (var ms = new MemoryStream(bytes, writable: false))
            await storage.PutAsync(key, ms, upload.ContentType, ct);

        var traceId = TraceIds.Current();
        var job = new IngestionJob
        {
            DocumentId = doc.Id, DocumentVersion = 1, Status = IngestionStages.Queued, Stage = IngestionStages.Queued,
            ProgressPercent = IngestionStages.Percent(IngestionStages.Queued), TraceId = traceId,
            ReferenceId = ReferenceId.ToStored(traceId), Attempt = 1, CreatedAt = now, UpdatedAt = now,
        };
        var run = RunLedger.NewRun(AiRunTypes.Ingestion, actorUserId, hasher);
        run.DocumentId = doc.Id;

        db.Documents.Add(doc);
        db.DocumentVersions.Add(new DocumentVersion
        {
            DocumentId = doc.Id, Version = 1, StorageKey = key, Sha256 = upload.Sha256, SizeBytes = bytes.Length, CreatedAt = now,
        });
        db.IngestionJobs.Add(job);
        db.AiRuns.Add(run);
        try
        {
            await db.SaveChangesAsync(ct);
        }
        catch (DbUpdateException ex) when (idempotencyKey is not null
                                           && ex.InnerException is Npgsql.PostgresException { SqlState: Npgsql.PostgresErrorCodes.UniqueViolation })
        {
            // A concurrent request with the same key won the race: drop ours and return theirs.
            db.ChangeTracker.Clear();
            await storage.DeleteAsync(key, CancellationToken.None);
            var winner = await FindByIdempotencyKeyAsync(actorUserId, scope, courseId, idempotencyKey, ct) ?? throw AppException.Conflict("This upload was already received.");
            return await GetItemAsync(winner, ct);
        }
        await usage.IncrementAsync(actorUserId, UsageKinds.Upload, ct: ct);

        job.HangfireJobId = jobs.EnqueueIngestDocument(doc.Id, 1, TraceIds.CurrentTraceParent(), run.Id);
        run.HangfireJobId = job.HangfireJobId;
        await db.SaveChangesAsync(CancellationToken.None);

        logger.LogInformation(Upload, "Document {document_id} uploaded ({size_bytes} bytes, {content_type}, scope {scope}); ingestion queued",
            doc.Id, bytes.Length, upload.ContentType, scope);
        return ToItem(doc, job);
    }

    /// <summary>New ingestion attempt for the same version (ingestion_jobs is unique per document/version).</summary>
    public async Task<DocumentItem> RetryAsync(Document doc, Guid actorUserId, CancellationToken ct)
    {
        var job = await db.IngestionJobs.FirstOrDefaultAsync(j => j.DocumentId == doc.Id && j.DocumentVersion == doc.CurrentVersion, ct)
                  ?? throw AppException.NotFound();
        if (job.Status != IngestionStages.Failed)
            throw AppException.Conflict("Only failed documents can be retried.");

        var traceId = TraceIds.Current();
        var now = DateTime.UtcNow;
        job.Attempt += 1;
        job.Status = IngestionStages.Queued;
        job.Stage = IngestionStages.Queued;
        job.ProgressPercent = IngestionStages.Percent(IngestionStages.Queued);
        job.ErrorCode = null;
        job.ErrorMessage = null;
        job.CompletedAt = null;
        job.TraceId = traceId;
        job.ReferenceId = ReferenceId.ToStored(traceId);
        job.UpdatedAt = now;
        doc.Status = DocumentStatuses.Queued;
        doc.UpdatedAt = now;
        var run = RunLedger.NewRun(AiRunTypes.Ingestion, actorUserId, hasher);
        run.DocumentId = doc.Id;
        db.AiRuns.Add(run);
        await db.SaveChangesAsync(ct);

        job.HangfireJobId = jobs.EnqueueIngestDocument(doc.Id, doc.CurrentVersion, TraceIds.CurrentTraceParent(), run.Id);
        run.HangfireJobId = job.HangfireJobId;
        await db.SaveChangesAsync(CancellationToken.None);
        logger.LogInformation(Upload, "Document {document_id} ingestion retried (attempt {attempt})", doc.Id, job.Attempt);
        return ToItem(doc, job);
    }

    /// <summary>Soft delete + document.deleted outbox event (chunks and objects removed asynchronously).</summary>
    public async Task DeleteAsync(Document doc, Guid actorUserId, CancellationToken ct)
    {
        doc.DeletedAt = DateTime.UtcNow;
        doc.UpdatedAt = doc.DeletedAt.Value;
        var prefix = doc.Scope == DocumentScopes.User
            ? $"uploads/{doc.OwnerUserId}/{doc.Id}/"
            : $"uploads/courses/{doc.CourseId}/{doc.Id}/";
        db.Outbox(OutboxTypes.DocumentDeleted, new { documentId = doc.Id, storagePrefix = doc.SourceType == SourceTypes.Upload ? prefix : null });
        db.Audit(actorUserId, AuditActions.DocumentDelete, "document", doc.Id, new { doc.Scope });
        await db.SaveChangesAsync(ct);
    }

    public async Task<List<DocumentItem>> ListAsync(IQueryable<Document> docs, CancellationToken ct)
    {
        var list = await docs.Where(d => d.DeletedAt == null).OrderByDescending(d => d.CreatedAt).Take(200).ToListAsync(ct);
        var ids = list.Select(d => d.Id).ToList();
        var jobs = await db.IngestionJobs.Where(j => ids.Contains(j.DocumentId)).ToListAsync(ct);
        return list.Select(d => ToItem(d, jobs.FirstOrDefault(j => j.DocumentId == d.Id && j.DocumentVersion == d.CurrentVersion))).ToList();
    }

    public async Task<DocumentItem> GetItemAsync(Document doc, CancellationToken ct)
    {
        var job = await db.IngestionJobs.FirstOrDefaultAsync(j => j.DocumentId == doc.Id && j.DocumentVersion == doc.CurrentVersion, ct);
        return ToItem(doc, job);
    }

    public static DocumentItem ToItem(Document d, IngestionJob? j) => new(
        d.Id, d.FileName, d.SizeBytes, d.ContentType, d.Status,
        j?.Stage ?? IngestionStages.Queued, j?.ProgressPercent ?? 0, j?.PassageCount, j?.ErrorCode, j?.ErrorMessage,
        j is { Status: IngestionStages.Failed } ? Security.ReferenceId.Format(j.ReferenceId) : null,
        d.CreatedAt, d.UpdatedAt > (j?.UpdatedAt ?? DateTime.MinValue) ? d.UpdatedAt : j!.UpdatedAt);
}
