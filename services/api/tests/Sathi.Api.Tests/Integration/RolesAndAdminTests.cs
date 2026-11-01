using System.Net;
using System.Text.Json;
using System.Web;
using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Sathi.Api.Tests.Infrastructure;
using Sathi.Core.Domain;

namespace Sathi.Api.Tests.Integration;

/// <summary>Contract §11.2 / §11.3: role administration guards, session refresh, lock/unlock, staff invites, profile.</summary>
[Collection(IntegrationCollection.Name)]
public class RolesAndAdminTests(IntegrationFixture fx)
{
    private SathiApiFactory F => fx.Factory;

    private static async Task<JsonElement> Json(Task<HttpResponseMessage> call, HttpStatusCode expected)
    {
        var resp = await call;
        var body = await TestClient.ReadJsonAsync(resp);
        Assert.True(resp.StatusCode == expected, $"Expected {(int)expected}, got {(int)resp.StatusCode}: {body}");
        return body;
    }

    private static async Task ExpectProblem(Task<HttpResponseMessage> call, HttpStatusCode status, string code)
    {
        var resp = await call;
        var body = await TestClient.ReadJsonAsync(resp);
        Assert.True(resp.StatusCode == status, $"Expected {(int)status} {code}, got {(int)resp.StatusCode}: {body}");
        Assert.Equal(code, body.GetProperty("code").GetString());
    }

    private static string[] RolesOf(JsonElement user) => user.GetProperty("roles").EnumerateArray().Select(r => r.GetString()!).ToArray();

    [Fact]
    public async Task Admin_cannot_demote_or_lock_themselves_and_the_last_admin_is_kept()
    {
        var a = await F.CreateUserAsync(Roles.Admin);
        var b = await F.CreateUserAsync(Roles.Admin);
        using var adminA = await TestClient.SignedInAsync(F, a.Email, a.Password);
        using var adminB = await TestClient.SignedInAsync(F, b.Email, b.Password);

        await ExpectProblem(adminA.PutAsync($"/api/v1/admin/users/{a.Id}/roles", new { roles = new[] { "Student" } }), HttpStatusCode.Conflict, "ROLE_SELF_DEMOTION");
        await ExpectProblem(adminA.PostAsync($"/api/v1/admin/users/{a.Id}/lock", new { minutes = 5 }), HttpStatusCode.Conflict, "ROLE_SELF_DEMOTION");
        await ExpectProblem(adminA.PutAsync($"/api/v1/admin/users/{a.Id}/roles", new { roles = Array.Empty<string>() }), HttpStatusCode.BadRequest, "VALIDATION_FAILED");
        await ExpectProblem(adminA.PutAsync($"/api/v1/admin/users/{a.Id}/roles", new { roles = new[] { "Wizard" } }), HttpStatusCode.BadRequest, "VALIDATION_FAILED");
        // Keeping your own Admin role while adding others is fine.
        var self = await Json(adminA.PutAsync($"/api/v1/admin/users/{a.Id}/roles", new { roles = new[] { "admin", "Instructor" } }), HttpStatusCode.OK);
        Assert.Equal(["Admin", "Instructor"], RolesOf(self));

        // ROLE_LAST_ADMIN: only A and B are admins. A demotes B; B's cookie still carries Admin until the security stamp is
        // re-validated, and B uses that window to demote A — which would leave no administrator.
        await using var scope = F.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<Sathi.Core.Data.AppDbContext>();
        var adminRoleId = await db.Roles.Where(r => r.NormalizedName == "ADMIN").Select(r => r.Id).SingleAsync();
        var others = await db.UserRoles.Where(ur => ur.RoleId == adminRoleId && ur.UserId != a.Id && ur.UserId != b.Id).ToListAsync();
        db.UserRoles.RemoveRange(others);
        await db.SaveChangesAsync();
        try
        {
            await Json(adminB.GetAsync($"/api/v1/admin/users/{b.Id}"), HttpStatusCode.OK); // fresh validation → window starts now
            var demoted = await Json(adminA.PutAsync($"/api/v1/admin/users/{b.Id}/roles", new { roles = new[] { "Student" } }), HttpStatusCode.OK);
            Assert.Equal(["Student"], RolesOf(demoted));
            await ExpectProblem(adminB.PutAsync($"/api/v1/admin/users/{a.Id}/roles", new { roles = new[] { "Student" } }), HttpStatusCode.Conflict, "ROLE_LAST_ADMIN");
            var stillAdmin = await Json(adminA.GetAsync($"/api/v1/admin/users/{a.Id}"), HttpStatusCode.OK);
            Assert.Contains("Admin", RolesOf(stillAdmin));
            // Once the stamp is re-validated B's session ends (the role change reached it).
            await Task.Delay(F.SecurityStampIntervalPlusMargin);
            Assert.Equal(HttpStatusCode.Unauthorized, (await adminB.GetAsync("/api/v1/admin/users")).StatusCode);
        }
        finally
        {
            db.ChangeTracker.Clear();
            db.UserRoles.AddRange(others.Select(o => new IdentityUserRole<Guid> { UserId = o.UserId, RoleId = o.RoleId }));
            await db.SaveChangesAsync();
        }

        var audit = await F.WithDbAsync(d => d.AuditEvents.AsNoTracking().Where(e => e.Action == AuditActions.RolesChanged && e.EntityId == b.Id).ToListAsync());
        Assert.Contains(audit, e => e.MetadataJson.Contains("\"before\"") && e.MetadataJson.Contains("\"after\""));
    }

    [Fact]
    public async Task Demoted_instructor_loses_access_within_the_validation_interval()
    {
        var admin = await F.CreateUserAsync(Roles.Admin);
        var teacher = await F.CreateUserAsync(Roles.Student, Roles.Instructor);
        using var ad = await TestClient.SignedInAsync(F, admin.Email, admin.Password);
        using var t = await TestClient.SignedInAsync(F, teacher.Email, teacher.Password);
        await Json(t.GetAsync("/api/v1/instructor/courses"), HttpStatusCode.OK);

        var updated = await Json(ad.PutAsync($"/api/v1/admin/users/{teacher.Id}/roles", new { roles = new[] { "Student" } }), HttpStatusCode.OK);
        Assert.Equal(["Student"], RolesOf(updated));

        // The role change rotates the security stamp: once it is re-validated (1 min in production, 2 s here) the old
        // session ends, and a new sign-in carries only the new roles.
        await Task.Delay(F.SecurityStampIntervalPlusMargin);
        await ExpectProblem(t.GetAsync("/api/v1/instructor/courses"), HttpStatusCode.Unauthorized, "AUTH_UNAUTHENTICATED");
        using (var relogged = await TestClient.SignedInAsync(F, teacher.Email, teacher.Password))
        {
            await ExpectProblem(relogged.GetAsync("/api/v1/instructor/courses"), HttpStatusCode.Forbidden, "AUTH_FORBIDDEN");
            Assert.Equal(["Student"], RolesOf(await Json(relogged.GetAsync("/api/v1/auth/me"), HttpStatusCode.OK)));

            // Locking ends the session too, and blocks sign-in until unlocked.
            Assert.Equal(HttpStatusCode.NoContent, (await ad.PostAsync($"/api/v1/admin/users/{teacher.Id}/lock", new { minutes = (int?)null })).StatusCode);
            await Task.Delay(F.SecurityStampIntervalPlusMargin);
            Assert.Equal(HttpStatusCode.Unauthorized, (await relogged.GetAsync("/api/v1/auth/me")).StatusCode);
        }
        var detail = await Json(ad.GetAsync($"/api/v1/admin/users/{teacher.Id}"), HttpStatusCode.OK);
        Assert.True(detail.GetProperty("lockedOut").GetBoolean());
        using (var anon = await TestClient.CreateAsync(F))
            await ExpectProblem(anon.PostAsync("/api/v1/auth/login", new { email = teacher.Email, password = teacher.Password, rememberMe = false }),
                (HttpStatusCode)423, "AUTH_LOCKED_OUT");
        Assert.Equal(HttpStatusCode.NoContent, (await ad.PostAsync($"/api/v1/admin/users/{teacher.Id}/unlock")).StatusCode);
        using var again = await TestClient.SignedInAsync(F, teacher.Email, teacher.Password);
        Assert.True(await F.WithDbAsync(d => d.AuditEvents.AnyAsync(e => e.Action == AuditActions.UserLocked && e.EntityId == teacher.Id)));
        Assert.True(await F.WithDbAsync(d => d.AuditEvents.AnyAsync(e => e.Action == AuditActions.UserUnlocked && e.EntityId == teacher.Id)));
    }

    [Fact]
    public async Task Admin_user_list_search_filters_and_paging()
    {
        var admin = await F.CreateUserAsync(Roles.Admin);
        var tag = Guid.NewGuid().ToString("N")[..10];
        var ids = new List<Guid>();
        for (var i = 0; i < 3; i++)
        {
            var u = await F.CreateUserAsync(Roles.Instructor);
            await F.WithDbAsync(async db =>
            {
                var user = await db.Users.SingleAsync(x => x.Id == u.Id);
                user.DisplayName = $"Findme {tag} {i}";
                return await db.SaveChangesAsync();
            });
            ids.Add(u.Id);
        }
        using var ad = await TestClient.SignedInAsync(F, admin.Email, admin.Password);
        using var student = await TestClient.SignedInAsync(F, (await F.CreateUserAsync()).Email, "Correct-horse-42");
        Assert.Equal(HttpStatusCode.Forbidden, (await student.GetAsync("/api/v1/admin/users")).StatusCode);

        var seen = new List<Guid>();
        string? cursor = null;
        do
        {
            var page = await Json(ad.GetAsync($"/api/v1/admin/users?query={tag.ToUpperInvariant()}&role=instructor&status=active&limit=2"
                                              + (cursor is null ? "" : $"&cursor={cursor}")), HttpStatusCode.OK);
            foreach (var item in page.GetProperty("items").EnumerateArray())
            {
                seen.Add(item.GetProperty("id").GetGuid());
                Assert.Equal("active", item.GetProperty("accountStatus").GetString());
                Assert.Contains("Instructor", RolesOf(item));
                Assert.False(item.GetProperty("isMinor").GetBoolean());
            }
            cursor = page.GetProperty("nextCursor").ValueKind == JsonValueKind.Null ? null : page.GetProperty("nextCursor").GetString();
        } while (cursor is not null);
        Assert.Equal(ids.OrderBy(x => x), seen.OrderBy(x => x));
        Assert.Equal(seen.Count, seen.Distinct().Count());
        Assert.Equal(0, (await Json(ad.GetAsync($"/api/v1/admin/users?query={tag}&status=deleted"), HttpStatusCode.OK)).GetProperty("items").GetArrayLength());
        await ExpectProblem(ad.GetAsync("/api/v1/admin/users?status=bogus"), HttpStatusCode.BadRequest, "VALIDATION_FAILED");
        await ExpectProblem(ad.GetAsync($"/api/v1/admin/users/{Guid.NewGuid()}"), HttpStatusCode.NotFound, "USER_NOT_FOUND");
        Assert.Equal(HttpStatusCode.Accepted, (await ad.PostAsync($"/api/v1/admin/users/{ids[0]}/resend-verification")).StatusCode);
    }

    [Fact]
    public async Task Staff_invite_registration_grants_the_role_and_course_and_existing_accounts_can_accept()
    {
        var admin = await F.CreateUserAsync(Roles.Admin);
        using var ad = await TestClient.SignedInAsync(F, admin.Email, admin.Password);
        var email = $"staff-{Guid.NewGuid():N}@example.com";

        var created = await Json(ad.PostAsync("/api/v1/admin/staff-invites", new { email, role = "Instructor", courseId = fx.CourseId }), HttpStatusCode.Created);
        Assert.Equal("Instructor", created.GetProperty("role").GetString());
        var link = F.Email.LastTo(email).TextBody.Split('\n').Select(l => l.Trim()).First(l => l.Contains("/auth/register?staffInvite="));
        Assert.StartsWith("http://app.test/auth/register?staffInvite=", link);
        var token = HttpUtility.ParseQueryString(new Uri(link).Query)["staffInvite"]!;

        using var anon = await TestClient.CreateAsync(F);
        var lookup = await Json(anon.GetAsync($"/api/v1/auth/staff-invites/{token}"), HttpStatusCode.OK);
        Assert.Equal("valid", lookup.GetProperty("status").GetString());
        Assert.Equal("Test Course", lookup.GetProperty("courseTitle").GetString());

        // Another email cannot use the token; the invited email can.
        await ExpectProblem(anon.PostAsync("/api/v1/auth/register", new
        {
            email = "other-" + email, password = "Learning-is-fun-7", displayName = "Other", dateOfBirth = "1985-05-05", staffInviteToken = token,
        }), HttpStatusCode.BadRequest, "VALIDATION_FAILED");
        Assert.Equal(HttpStatusCode.Accepted, (await anon.PostAsync("/api/v1/auth/register", new
        {
            email, password = "Learning-is-fun-7", displayName = "New Teacher", dateOfBirth = "1985-05-05", staffInviteToken = token,
        })).StatusCode);
        await ExpectProblem(anon.PostAsync("/api/v1/auth/register", new
        {
            email = "late-" + email, password = "Learning-is-fun-7", displayName = "Late", dateOfBirth = "1985-05-05", staffInviteToken = token,
        }), HttpStatusCode.Gone, "STAFF_INVITE_INVALID");

        var userId = await F.WithDbAsync(async db =>
        {
            var u = await db.Users.SingleAsync(x => x.NormalizedEmail == email.ToUpperInvariant());
            u.EmailConfirmed = true;
            await db.SaveChangesAsync();
            return u.Id;
        });
        using var teacher = await TestClient.SignedInAsync(F, email, "Learning-is-fun-7");
        var me = await Json(teacher.GetAsync("/api/v1/auth/me"), HttpStatusCode.OK);
        Assert.Equal(["Instructor", "Student"], RolesOf(me));
        var courses = await Json(teacher.GetAsync("/api/v1/instructor/courses"), HttpStatusCode.OK);
        Assert.Equal("instructor", courses.EnumerateArray().Single(c => c.GetProperty("id").GetGuid() == fx.CourseId).GetProperty("myRole").GetString());

        var invites = await Json(ad.GetAsync("/api/v1/admin/staff-invites"), HttpStatusCode.OK);
        Assert.Equal("accepted", invites.EnumerateArray().Single(i => i.GetProperty("id").GetGuid() == created.GetProperty("id").GetGuid())
            .GetProperty("status").GetString());
        Assert.True(await F.WithDbAsync(db => db.AuditEvents.AnyAsync(e => e.Action == AuditActions.StaffInviteAccepted && e.ActorUserId == userId)));

        // Existing account: accepts while signed in with the invited email (another account gets 403).
        var existing = await F.CreateUserAsync();
        await Json(ad.PostAsync("/api/v1/admin/staff-invites", new { email = existing.Email, role = "Admin" }), HttpStatusCode.Created);
        var token2 = HttpUtility.ParseQueryString(new Uri(F.Email.LastTo(existing.Email).TextBody.Split('\n').Select(l => l.Trim())
            .First(l => l.Contains("staffInvite="))).Query)["staffInvite"]!;
        using (var wrong = await TestClient.SignedInAsync(F, (await F.CreateUserAsync()).Email, "Correct-horse-42"))
            await ExpectProblem(wrong.PostAsync($"/api/v1/auth/staff-invites/{token2}/accept"), HttpStatusCode.Forbidden, "AUTH_FORBIDDEN");
        using var ex = await TestClient.SignedInAsync(F, existing.Email, existing.Password);
        var accepted = await Json(ex.PostAsync($"/api/v1/auth/staff-invites/{token2}/accept"), HttpStatusCode.OK);
        Assert.Contains("Admin", RolesOf(accepted));
        await Json(ex.GetAsync("/api/v1/admin/users?limit=1"), HttpStatusCode.OK); // refreshed cookie carries the new role
        await ExpectProblem(ex.PostAsync($"/api/v1/auth/staff-invites/{token2}/accept"), HttpStatusCode.Gone, "STAFF_INVITE_INVALID");

        // Revoked invitations are invalid.
        var revokedEmail = $"revoked-{Guid.NewGuid():N}@example.com";
        var revoked = await Json(ad.PostAsync("/api/v1/admin/staff-invites", new { email = revokedEmail, role = "Instructor" }), HttpStatusCode.Created);
        var token3 = HttpUtility.ParseQueryString(new Uri(F.Email.LastTo(revokedEmail).TextBody.Split('\n').Select(l => l.Trim())
            .First(l => l.Contains("staffInvite="))).Query)["staffInvite"]!;
        Assert.Equal(HttpStatusCode.NoContent, (await ad.DeleteAsync($"/api/v1/admin/staff-invites/{revoked.GetProperty("id").GetGuid()}")).StatusCode);
        Assert.Equal("revoked", (await Json(anon.GetAsync($"/api/v1/auth/staff-invites/{token3}"), HttpStatusCode.OK)).GetProperty("status").GetString());
    }

    [Fact]
    public async Task Profile_display_name_is_validated_and_updated()
    {
        var u = await F.CreateUserAsync();
        using var c = await TestClient.SignedInAsync(F, u.Email, u.Password);
        await ExpectProblem(c.PutAsync("/api/v1/me/profile", new { displayName = "  " }), HttpStatusCode.BadRequest, "VALIDATION_FAILED");
        await ExpectProblem(c.PutAsync("/api/v1/me/profile", new { displayName = new string('x', 61) }), HttpStatusCode.BadRequest, "VALIDATION_FAILED");
        var me = await Json(c.PutAsync("/api/v1/me/profile", new { displayName = "  Asha Kumari " }), HttpStatusCode.OK);
        Assert.Equal("Asha Kumari", me.GetProperty("displayName").GetString());
        Assert.False(me.GetProperty("isMinor").GetBoolean());
    }
}
