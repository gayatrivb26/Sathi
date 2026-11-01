using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using Sathi.Api.Infrastructure;
using Sathi.Core.Data;
using Sathi.Core.Documents;
using Sathi.Core.Domain;
using Sathi.Core.Errors;
using Sathi.Core.Options;

namespace Sathi.Api.Modules;

public static class DocumentsEndpoints
{
    public static void MapDocuments(this RouteGroupBuilder api)
    {
        var g = api.MapGroup("/documents").WithTags("Notes").WithProblems(401);
        g.MapGet("", async (HttpContext ctx, AppDbContext db, DocumentService docs, CancellationToken ct) =>
        {
            var userId = ctx.User.GetUserId();
            return await docs.ListAsync(db.Documents.Where(d => d.OwnerUserId == userId && d.Scope == DocumentScopes.User), ct);
        }).Doc("ListDocuments", "The student's own uploads");

        g.MapPost("", (HttpContext ctx, DocumentService docs, IOptions<QuotaOptions> q, CancellationToken ct) =>
                UploadAsync(ctx, docs, q.Value, DocumentScopes.User, null, ct))
            .DisableAntiforgery()
            .Accepts<IFormFile>("multipart/form-data")
            .WithProblems(400, 413, 415, 429)
            .Doc("UploadDocument", "Upload notes (multipart field 'file'); a repeated Idempotency-Key returns the original document");

        g.MapGet("/{id:guid}", async (Guid id, HttpContext ctx, AppDbContext db, DocumentService docs, CancellationToken ct) =>
            await docs.GetItemAsync(await OwnedAsync(db, ctx, id, ct), ct)).WithProblems(404).Doc("GetDocument", "Upload status (poll while not terminal)");

        g.MapPost("/{id:guid}/retry", async (Guid id, HttpContext ctx, AppDbContext db, DocumentService docs, CancellationToken ct) =>
                TypedResults.Accepted($"/api/v1/documents/{id}", await docs.RetryAsync(await OwnedAsync(db, ctx, id, ct), ctx.User.GetUserId(), ct)))
            .WithProblems(404, 409).Doc("RetryDocument", "Retry a failed ingestion");

        g.MapDelete("/{id:guid}", async (Guid id, HttpContext ctx, AppDbContext db, DocumentService docs, CancellationToken ct) =>
        {
            await docs.DeleteAsync(await OwnedAsync(db, ctx, id, ct), ctx.User.GetUserId(), ct);
            return TypedResults.NoContent();
        }).WithProblems(404).Doc("DeleteDocument", "Delete an upload (its passages are removed asynchronously)");
    }

    private static async Task<Document> OwnedAsync(AppDbContext db, HttpContext ctx, Guid id, CancellationToken ct)
    {
        var userId = ctx.User.GetUserId();
        return await db.Documents.FirstOrDefaultAsync(d => d.Id == id && d.OwnerUserId == userId && d.Scope == DocumentScopes.User && d.DeletedAt == null, ct)
               ?? throw AppException.NotFound("Document not found.");
    }

    /// <summary>
    /// Multipart upload shared by student notes and instructor course documents. A repeated Idempotency-Key returns the original
    /// document (contract §11.6) — persisted in documents.idempotency_key, so it holds across instances and restarts.
    /// </summary>
    public static async Task<Accepted<DocumentItem>> UploadAsync(HttpContext ctx, DocumentService docs, QuotaOptions quotas, string scope, Guid? courseId,
        CancellationToken ct)
    {
        var userId = ctx.User.GetUserId();
        var key = ctx.Request.Headers["Idempotency-Key"].ToString().Trim();
        if (key.Length > 200) throw AppException.Validation("idempotencyKey", "Idempotency-Key is too long.");
        string? idempotencyKey = key.Length == 0 ? null : key;
        if (idempotencyKey is not null && await docs.FindByIdempotencyKeyAsync(userId, scope, courseId, idempotencyKey, ct) is { } existing)
            return TypedResults.Accepted($"/api/v1/documents/{existing.Id}", await docs.GetItemAsync(existing, ct));

        if (!ctx.Request.HasFormContentType)
            throw AppException.Validation("file", "Upload the file as multipart/form-data in a field named 'file'.");
        if (ctx.Request.ContentLength is { } len && len > quotas.MaxUploadBytes + 1_048_576)
            throw new AppException(413, ErrorCodes.UploadTooLarge, $"Files can be at most {quotas.MaxUploadBytes / (1024 * 1024)} MB.");

        IFormCollection form;
        try
        {
            form = await ctx.Request.ReadFormAsync(ct);
        }
        catch (InvalidDataException)
        {
            throw new AppException(413, ErrorCodes.UploadTooLarge, $"Files can be at most {quotas.MaxUploadBytes / (1024 * 1024)} MB.");
        }
        var file = form.Files.GetFile("file") ?? form.Files.FirstOrDefault()
                   ?? throw AppException.Validation("file", "Choose a file to upload.");
        if (file.Length > quotas.MaxUploadBytes)
            throw new AppException(413, ErrorCodes.UploadTooLarge, $"Files can be at most {quotas.MaxUploadBytes / (1024 * 1024)} MB.");

        byte[] bytes;
        await using (var stream = file.OpenReadStream())
        using (var ms = new MemoryStream((int)Math.Max(0, file.Length)))
        {
            await stream.CopyToAsync(ms, ct);
            bytes = ms.ToArray();
        }

        var item = await docs.UploadAsync(userId, scope, courseId, file.FileName, bytes, idempotencyKey, ct);
        return TypedResults.Accepted($"/api/v1/documents/{item.Id}", item);
    }
}
