using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using Sathi.Core.Data;
using Sathi.Core.Domain;

namespace Sathi.Core.Seeding;

/// <summary>Seeds roles, the admin account and (optionally) demo users. Idempotent.</summary>
public sealed class IdentitySeeder(
    AppDbContext db, UserManager<AppUser> users, RoleManager<AppRole> roles, ILogger<IdentitySeeder> logger)
{
    public const string DemoStudentEmail = "demo@sathi.local";
    public const string DemoStudentPassword = "Demo!12345";
    public const string DemoInstructorEmail = "instructor@sathi.local";
    public const string DemoInstructorPassword = "Teach!12345";

    public async Task SeedRolesAsync()
    {
        foreach (var name in Roles.All)
            if (!await roles.RoleExistsAsync(name))
            {
                var r = await roles.CreateAsync(new AppRole(name));
                if (!r.Succeeded) throw new InvalidOperationException($"Could not create role {name}: {Describe(r)}");
                logger.LogInformation("Created role {role}", name);
            }
    }

    /// <summary>Creates (or updates roles of) a confirmed user. Existing passwords are not changed.</summary>
    public async Task<AppUser> EnsureUserAsync(string email, string password, string displayName, params string[] userRoles)
    {
        var user = await users.FindByEmailAsync(email);
        if (user is null)
        {
            user = new AppUser { UserName = email, Email = email, EmailConfirmed = true, DisplayName = displayName, CreatedAt = DateTime.UtcNow };
            var r = await users.CreateAsync(user, password);
            if (!r.Succeeded) throw new InvalidOperationException($"Could not create seeded user: {Describe(r)}");
            logger.LogInformation("Created seeded user with roles {roles}", string.Join(",", userRoles));
        }
        else if (!user.EmailConfirmed)
        {
            user.EmailConfirmed = true;
            await users.UpdateAsync(user);
        }

        foreach (var role in userRoles)
            if (!await users.IsInRoleAsync(user, role))
                await users.AddToRoleAsync(user, role);

        if (!await db.UserPreferences.AnyAsync(p => p.UserId == user.Id))
        {
            db.UserPreferences.Add(new UserPreference { UserId = user.Id });
            await db.SaveChangesAsync();
        }
        return user;
    }

    private static string Describe(IdentityResult r) => string.Join("; ", r.Errors.Select(e => e.Code));
}
