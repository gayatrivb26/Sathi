using Microsoft.AspNetCore.Identity;

namespace Sathi.Core.Domain;

public sealed class AppUser : IdentityUser<Guid>
{
    public AppUser()
    {
        Id = Guid.CreateVersion7();
        SecurityStamp = Guid.NewGuid().ToString("N");
    }

    public string DisplayName { get; set; } = "";
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime? LastActiveAt { get; set; }
    public DateTime? DeletedAt { get; set; }

    // ---- under-18 learners (contract §11.4); null date of birth = existing/seeded account = adult ----
    public DateOnly? DateOfBirth { get; set; }
    public bool IsMinor { get; set; }
    public string? GuardianEmailNormalized { get; set; }
    public string GuardianConsentStatus { get; set; } = GuardianConsentStatuses.NotRequired;
    public DateTime? GuardianConsentAt { get; set; }
}

public sealed class AppRole : IdentityRole<Guid>
{
    public AppRole() { Id = Guid.CreateVersion7(); }
    public AppRole(string name) : this() { Name = name; NormalizedName = name.ToUpperInvariant(); }
}

public static class Roles
{
    public const string Student = "Student";
    public const string Instructor = "Instructor";
    public const string Admin = "Admin";
    public static readonly string[] All = [Student, Instructor, Admin];

    /// <summary>Case-insensitive match against <see cref="All"/>; returns the canonical name or null.</summary>
    public static string? Canonical(string? name) =>
        All.FirstOrDefault(r => string.Equals(r, name?.Trim(), StringComparison.OrdinalIgnoreCase));
}
