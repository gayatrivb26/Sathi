using System.Security.Cryptography;
using System.Text;
using Microsoft.AspNetCore.WebUtilities;
using Microsoft.EntityFrameworkCore;
using Sathi.Core.Data;
using Sathi.Core.Domain;

namespace Sathi.Core.Access;

/// <summary>Who is asking. Role flags come from the (security-stamp validated) auth cookie.</summary>
public sealed record CourseViewer(Guid UserId, bool IsAdmin, bool IsInstructor)
{
    public bool IsStaff => IsAdmin || IsInstructor;
}

/// <summary>
/// Course access rules (contract §11.1), always applied in SQL:
/// <list type="bullet">
/// <item>Admin sees and manages every course.</item>
/// <item>Staff with a <c>course_instructors</c> row see and manage that course (published or not).</item>
/// <item>Everyone else sees a course when it is published and public, or published and they are an active member
/// (<c>removed_at is null</c>) of a non-archived class of it. Anything else is 404.</item>
/// </list>
/// </summary>
public static class CourseAccess
{
    /// <summary>Courses the viewer may open (detail pages, lessons, practice, tutor, …).</summary>
    public static IQueryable<Course> Visible(AppDbContext db, CourseViewer viewer)
    {
        if (viewer.IsAdmin) return db.Courses;
        var userId = viewer.UserId;
        var staff = viewer.IsStaff;
        return db.Courses.Where(c =>
            (staff && db.CourseInstructors.Any(ci => ci.CourseId == c.Id && ci.UserId == userId))
            || (c.IsPublished && (c.Visibility == CourseVisibilities.Public
                                  || db.ClassMembers.Any(m => m.UserId == userId && m.RemovedAt == null
                                                              && db.Classes.Any(k => k.Id == m.ClassId && k.CourseId == c.Id && k.ArchivedAt == null)))));
    }

    /// <summary>The student catalogue: visible and published.</summary>
    public static IQueryable<Course> Catalog(AppDbContext db, CourseViewer viewer) => Visible(db, viewer).Where(c => c.IsPublished);

    /// <summary>Courses the viewer may edit (instructor area).</summary>
    public static IQueryable<Course> Manageable(AppDbContext db, CourseViewer viewer)
    {
        if (viewer.IsAdmin) return db.Courses;
        if (!viewer.IsInstructor) return db.Courses.Where(_ => false);
        var userId = viewer.UserId;
        return db.Courses.Where(c => db.CourseInstructors.Any(ci => ci.CourseId == c.Id && ci.UserId == userId));
    }

    public static Task<bool> CanSeeAsync(AppDbContext db, CourseViewer viewer, Guid courseId, CancellationToken ct) =>
        Visible(db, viewer).AnyAsync(c => c.Id == courseId, ct);

    /// <summary>Ids of the courses (among <paramref name="courseIds"/>) the viewer may still see.</summary>
    public static Task<List<Guid>> FilterVisibleAsync(AppDbContext db, CourseViewer viewer, IReadOnlyCollection<Guid> courseIds, CancellationToken ct) =>
        Visible(db, viewer).Where(c => courseIds.Contains(c.Id)).Select(c => c.Id).ToListAsync(ct);

    /// <summary>Active (not removed) memberships of non-archived classes.</summary>
    public static IQueryable<ClassMember> ActiveMemberships(AppDbContext db) =>
        db.ClassMembers.Where(m => m.RemovedAt == null && db.Classes.Any(k => k.Id == m.ClassId && k.ArchivedAt == null));
}

/// <summary>Class join codes: 8 characters from an unambiguous alphabet (no 0/O/1/I), displayed XXXX-XXXX.</summary>
public static class JoinCodes
{
    public const string Alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    public const int Length = 8;

    /// <summary>Uniformly random code from a CSPRNG.</summary>
    public static string Generate() => new(RandomNumberGenerator.GetItems<char>(Alphabet, Length));

    /// <summary>Dash-, space- and case-insensitive; null when it cannot be a code.</summary>
    public static string? Normalize(string? input)
    {
        if (string.IsNullOrWhiteSpace(input)) return null;
        var s = new string(input.Where(ch => ch is not ('-' or ' ')).Select(char.ToUpperInvariant).ToArray());
        return s.Length == Length && s.All(Alphabet.Contains) ? s : null;
    }

    public static string Format(string code) => code.Length == Length ? code[..4] + "-" + code[4..] : code;
}

/// <summary>Opaque emailed tokens: 32 random bytes as base64url; only the SHA-256 hex digest is stored.</summary>
public static class SecureTokens
{
    public static (string Raw, string Hash) Create()
    {
        var raw = WebEncoders.Base64UrlEncode(RandomNumberGenerator.GetBytes(32));
        return (raw, Hash(raw));
    }

    public static string Hash(string raw) => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(raw.Trim())));
}

public static class EmailAddresses
{
    /// <summary>Stored form for invite/consent emails: trimmed, lower-case.</summary>
    public static string Normalize(string email) => email.Trim().ToLowerInvariant();

    /// <summary>"asha.k@example.com" → "a***@example.com".</summary>
    public static string Mask(string? email)
    {
        if (string.IsNullOrWhiteSpace(email)) return "";
        var at = email.IndexOf('@');
        if (at <= 0) return "***";
        return email[0] + "***" + email[at..];
    }

    public static bool IsValid(string? email) =>
        !string.IsNullOrWhiteSpace(email) && email.Length <= 254 && System.Net.Mail.MailAddress.TryCreate(email.Trim(), out var a)
        && a.Address == email.Trim() && a.Host.Contains('.');
}

public static class Ages
{
    /// <summary>Completed years on <paramref name="today"/>.</summary>
    public static int On(DateOnly dateOfBirth, DateOnly today)
    {
        var age = today.Year - dateOfBirth.Year;
        if (dateOfBirth > today.AddYears(-age)) age--;
        return age;
    }
}
