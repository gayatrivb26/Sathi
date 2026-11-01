using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Sathi.Api.Tests.Infrastructure;
using Sathi.Core.Domain;

namespace Sathi.Api.Tests.Integration;

/// <summary>Contract §11.1: private courses, classes (join code / invites), co-instructors and instructor scoping.</summary>
[Collection(IntegrationCollection.Name)]
public class CourseAccessTests(IntegrationFixture fx) : IDisposable
{
    private SathiApiFactory F => fx.Factory;

    public void Dispose() => F.Ai.Reset();

    public sealed record PrivateCourse(Guid CourseId, Guid LessonId, Guid ConceptId, Guid ClassId, string JoinCode);

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

    /// <summary>A published private course with one lesson, one concept, one published MCQ and a class (through the instructor API).</summary>
    public static async Task<PrivateCourse> CreatePrivateCourseAsync(TestClient instructor)
    {
        var slug = "private-" + Guid.NewGuid().ToString("N")[..8];
        var course = await Json(instructor.PostAsync("/api/v1/instructor/courses",
            new { title = "Private " + slug, slug, description = "d", isPublished = true, visibility = "private" }), HttpStatusCode.Created);
        Assert.Equal("private", course.GetProperty("visibility").GetString());
        Assert.Equal("owner", course.GetProperty("myRole").GetString());
        var courseId = course.GetProperty("id").GetGuid();
        var module = await Json(instructor.PostAsync($"/api/v1/instructor/courses/{courseId}/modules", new { title = "M1", summary = "", position = 1 }),
            HttpStatusCode.Created);
        var concept = await Json(instructor.PostAsync($"/api/v1/instructor/courses/{courseId}/concepts",
            new { name = "Secret concept", slug = "secret", description = "", prerequisiteIds = Array.Empty<Guid>() }), HttpStatusCode.Created);
        var conceptId = concept.GetProperty("id").GetGuid();
        var lesson = await Json(instructor.PostAsync($"/api/v1/instructor/modules/{module.GetProperty("id").GetGuid()}/lessons", new
        {
            title = "Secret lesson", summary = "s", contentMarkdown = "# Private", estimatedMinutes = 5, position = 1,
            conceptIds = new[] { conceptId }, objectives = new[] { "Know it" },
        }), HttpStatusCode.Created);
        await Json(instructor.PostAsync("/api/v1/instructor/questions", new
        {
            conceptId, type = "mcq", stem = "Which is right?", explanation = "Because.", difficulty = 0.5, status = "published", isDiagnostic = true,
            options = new[] { new { label = "A", text = "Right", isCorrect = true }, new { label = "B", text = "Wrong", isCorrect = false } },
        }), HttpStatusCode.Created);
        var cls = await Json(instructor.PostAsync($"/api/v1/instructor/courses/{courseId}/classes", new { name = "Batch " + slug, description = "x" }),
            HttpStatusCode.Created);
        var code = cls.GetProperty("joinCode").GetString()!;
        Assert.Matches("^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$", code);
        return new PrivateCourse(courseId, lesson.GetProperty("id").GetGuid(), conceptId, cls.GetProperty("id").GetGuid(), code);
    }

    private static HttpRequestMessage Stream(Guid conversationId) => new(HttpMethod.Post, $"/api/v1/conversations/{conversationId}/messages/stream")
    {
        Content = JsonContent.Create(new { content = "Tell me the secret", level = "beginner", mode = "explain", webSearch = false }),
    };

    private async Task<TestClient> SignedInAsync(params string[] roles)
    {
        var u = await F.CreateUserAsync(roles);
        return await TestClient.SignedInAsync(F, u.Email, u.Password);
    }

    [Fact]
    public async Task Private_course_is_404_for_non_members_open_to_members_and_closed_again_after_leaving()
    {
        using var teacher = await SignedInAsync(Roles.Instructor);
        var pc = await CreatePrivateCourseAsync(teacher);
        using var student = await SignedInAsync();

        async Task AssertNoAccess()
        {
            var list = await Json(student.GetAsync("/api/v1/courses"), HttpStatusCode.OK);
            Assert.DoesNotContain(list.EnumerateArray(), c => c.GetProperty("id").GetGuid() == pc.CourseId);
            await ExpectProblem(student.GetAsync($"/api/v1/courses/{pc.CourseId}"), HttpStatusCode.NotFound, "NOT_FOUND");
            await ExpectProblem(student.PostAsync($"/api/v1/courses/{pc.CourseId}/enroll"), HttpStatusCode.NotFound, "NOT_FOUND");
            await ExpectProblem(student.GetAsync($"/api/v1/lessons/{pc.LessonId}"), HttpStatusCode.NotFound, "NOT_FOUND");
            await ExpectProblem(student.PostAsync($"/api/v1/lessons/{pc.LessonId}/progress", new { percent = 10, completed = false }), HttpStatusCode.NotFound, "NOT_FOUND");
            await ExpectProblem(student.PostAsync("/api/v1/practice/sessions", new { courseId = pc.CourseId, count = 1 }), HttpStatusCode.NotFound, "NOT_FOUND");
            await ExpectProblem(student.PostAsync($"/api/v1/courses/{pc.CourseId}/diagnostic"), HttpStatusCode.NotFound, "NOT_FOUND");
            await ExpectProblem(student.GetAsync($"/api/v1/home?courseId={pc.CourseId}"), HttpStatusCode.NotFound, "NOT_FOUND");
            await ExpectProblem(student.GetAsync($"/api/v1/progress?courseId={pc.CourseId}"), HttpStatusCode.NotFound, "NOT_FOUND");
            await ExpectProblem(student.GetAsync($"/api/v1/revision/due?courseId={pc.CourseId}"), HttpStatusCode.NotFound, "NOT_FOUND");
            await ExpectProblem(student.PostAsync("/api/v1/conversations", new { courseId = pc.CourseId }), HttpStatusCode.NotFound, "NOT_FOUND");
        }

        await AssertNoAccess();

        // Join by code: dash- and case-insensitive; enrols and sets the active course.
        var joined = await Json(student.PostAsync("/api/v1/classes/join", new { code = pc.JoinCode.Replace("-", "").ToLowerInvariant() }), HttpStatusCode.OK);
        Assert.Equal(pc.ClassId, joined.GetProperty("classId").GetGuid());
        var summary = joined.GetProperty("course");
        Assert.Equal(pc.CourseId, summary.GetProperty("id").GetGuid());
        Assert.Equal("private", summary.GetProperty("visibility").GetString());
        Assert.True(summary.GetProperty("enrolled").GetBoolean());
        Assert.Equal(pc.ClassId, summary.GetProperty("classes")[0].GetProperty("id").GetGuid());
        var me = await Json(student.GetAsync("/api/v1/auth/me"), HttpStatusCode.OK);
        Assert.Equal(pc.CourseId, me.GetProperty("preferences").GetProperty("activeCourseId").GetGuid());
        var myClasses = await Json(student.GetAsync("/api/v1/me/classes"), HttpStatusCode.OK);
        Assert.Contains(myClasses.EnumerateArray(), c => c.GetProperty("classId").GetGuid() == pc.ClassId);

        // Member: everything opens.
        var list = await Json(student.GetAsync("/api/v1/courses"), HttpStatusCode.OK);
        Assert.Contains(list.EnumerateArray(), c => c.GetProperty("id").GetGuid() == pc.CourseId);
        await Json(student.GetAsync($"/api/v1/courses/{pc.CourseId}"), HttpStatusCode.OK);
        Assert.Equal("Secret lesson", (await Json(student.GetAsync($"/api/v1/lessons/{pc.LessonId}"), HttpStatusCode.OK)).GetProperty("title").GetString());
        var practice = await Json(student.PostAsync("/api/v1/practice/sessions", new { courseId = pc.CourseId, count = 1 }), HttpStatusCode.OK);
        var attemptId = practice.GetProperty("attemptId").GetGuid();
        await Json(student.GetAsync("/api/v1/home"), HttpStatusCode.OK);
        var convoId = (await Json(student.PostAsync("/api/v1/conversations", new { courseId = pc.CourseId }), HttpStatusCode.Created)).GetProperty("id").GetGuid();
        using (var resp = await student.SendAsync(Stream(convoId), HttpCompletionOption.ResponseHeadersRead))
        {
            Assert.Equal(HttpStatusCode.OK, resp.StatusCode);
            Assert.Equal("done", (await SseParsing.ReadAsync(await resp.Content.ReadAsStreamAsync()))[^1].Event);
        }
        // The tutor's retrieval scope includes the private course for a member.
        var jwt = new Microsoft.IdentityModel.JsonWebTokens.JsonWebToken(
            F.Ai.Requests.Last(r => r.Path == "/internal/v1/tutor/stream").Headers["Authorization"]["Bearer ".Length..]);
        var rscope = JsonDocument.Parse(Microsoft.IdentityModel.Tokens.Base64UrlEncoder.Decode(jwt.EncodedPayload)).RootElement.GetProperty("rscope");
        Assert.Contains(pc.CourseId.ToString(), rscope.GetProperty("course_ids").EnumerateArray().Select(e => e.GetString()));

        // Leaving removes access everywhere, including the tutor and old attempts.
        Assert.Equal(HttpStatusCode.NoContent, (await student.DeleteAsync($"/api/v1/me/classes/{pc.ClassId}")).StatusCode);
        await AssertNoAccess();
        await ExpectProblem(student.SendAsync(Stream(convoId)), HttpStatusCode.NotFound, "NOT_FOUND");
        await ExpectProblem(student.GetAsync($"/api/v1/conversations/{convoId}"), HttpStatusCode.NotFound, "NOT_FOUND");
        await ExpectProblem(student.GetAsync($"/api/v1/attempts/{attemptId}"), HttpStatusCode.NotFound, "NOT_FOUND");
        var convos = await Json(student.GetAsync("/api/v1/conversations"), HttpStatusCode.OK);
        Assert.DoesNotContain(convos.GetProperty("items").EnumerateArray(), c => c.GetProperty("id").GetGuid() == convoId);
        me = await Json(student.GetAsync("/api/v1/auth/me"), HttpStatusCode.OK);
        Assert.Equal(JsonValueKind.Null, me.GetProperty("preferences").GetProperty("activeCourseId").ValueKind);
        Assert.Equal(0, (await Json(student.GetAsync("/api/v1/me/classes"), HttpStatusCode.OK)).GetArrayLength());
        await ExpectProblem(student.DeleteAsync($"/api/v1/me/classes/{pc.ClassId}"), HttpStatusCode.NotFound, "NOT_FOUND");

        // The instructor (course owner) still sees the private course; an unrelated instructor does not.
        await Json(teacher.GetAsync($"/api/v1/courses/{pc.CourseId}"), HttpStatusCode.OK);
        using var otherTeacher = await SignedInAsync(Roles.Instructor);
        await ExpectProblem(otherTeacher.GetAsync($"/api/v1/courses/{pc.CourseId}"), HttpStatusCode.NotFound, "NOT_FOUND");
    }

    [Fact]
    public async Task Join_codes_disabled_regenerated_archived()
    {
        using var teacher = await SignedInAsync(Roles.Instructor);
        var pc = await CreatePrivateCourseAsync(teacher);
        using var student = await SignedInAsync();

        await ExpectProblem(student.PostAsync("/api/v1/classes/join", new { code = "ZZZZ-ZZZZ" }), HttpStatusCode.NotFound, "CLASS_CODE_INVALID");
        await ExpectProblem(student.PostAsync("/api/v1/classes/join", new { code = "not a code" }), HttpStatusCode.NotFound, "CLASS_CODE_INVALID");

        var disabled = await Json(teacher.PutAsync($"/api/v1/instructor/classes/{pc.ClassId}", new { name = "Renamed", description = (string?)null, joinEnabled = false }),
            HttpStatusCode.OK);
        Assert.False(disabled.GetProperty("joinEnabled").GetBoolean());
        await ExpectProblem(student.PostAsync("/api/v1/classes/join", new { code = pc.JoinCode }), HttpStatusCode.Conflict, "CLASS_JOIN_DISABLED");

        await Json(teacher.PutAsync($"/api/v1/instructor/classes/{pc.ClassId}", new { name = "Renamed", description = "d", joinEnabled = true }), HttpStatusCode.OK);
        var regenerated = await Json(teacher.PostAsync($"/api/v1/instructor/classes/{pc.ClassId}/regenerate-code"), HttpStatusCode.OK);
        var newCode = regenerated.GetProperty("joinCode").GetString()!;
        Assert.NotEqual(pc.JoinCode, newCode);
        await ExpectProblem(student.PostAsync("/api/v1/classes/join", new { code = pc.JoinCode }), HttpStatusCode.NotFound, "CLASS_CODE_INVALID");
        await Json(student.PostAsync("/api/v1/classes/join", new { code = newCode }), HttpStatusCode.OK);
        // Joining twice is idempotent.
        await Json(student.PostAsync("/api/v1/classes/join", new { code = newCode }), HttpStatusCode.OK);

        var members = await Json(teacher.GetAsync($"/api/v1/instructor/classes/{pc.ClassId}/members"), HttpStatusCode.OK);
        Assert.Equal(1, members.GetArrayLength());
        Assert.Equal("code", members[0].GetProperty("joinedVia").GetString());
        var classes = await Json(teacher.GetAsync($"/api/v1/instructor/courses/{pc.CourseId}/classes"), HttpStatusCode.OK);
        Assert.Equal(1, classes.EnumerateArray().Single(c => c.GetProperty("id").GetGuid() == pc.ClassId).GetProperty("memberCount").GetInt32());

        // Class-scoped insights count the class members.
        var insights = await Json(teacher.GetAsync($"/api/v1/instructor/insights?classId={pc.ClassId}"), HttpStatusCode.OK);
        Assert.Equal(1, insights.GetProperty("enrolled").GetInt32());
        await Json(teacher.GetAsync($"/api/v1/instructor/grading-queue?classId={pc.ClassId}"), HttpStatusCode.OK);

        // Archiving the class closes the course for its members; unarchiving reopens it.
        await Json(student.GetAsync($"/api/v1/courses/{pc.CourseId}"), HttpStatusCode.OK);
        var archived = await Json(teacher.PostAsync($"/api/v1/instructor/classes/{pc.ClassId}/archive"), HttpStatusCode.OK);
        Assert.NotEqual(JsonValueKind.Null, archived.GetProperty("archivedAt").ValueKind);
        await ExpectProblem(student.GetAsync($"/api/v1/courses/{pc.CourseId}"), HttpStatusCode.NotFound, "NOT_FOUND");
        await Json(teacher.PostAsync($"/api/v1/instructor/classes/{pc.ClassId}/unarchive"), HttpStatusCode.OK);
        await Json(student.GetAsync($"/api/v1/courses/{pc.CourseId}"), HttpStatusCode.OK);

        // Instructor removes the member.
        var studentId = members[0].GetProperty("userId").GetGuid();
        Assert.Equal(HttpStatusCode.NoContent, (await teacher.DeleteAsync($"/api/v1/instructor/classes/{pc.ClassId}/members/{studentId}")).StatusCode);
        await ExpectProblem(student.GetAsync($"/api/v1/courses/{pc.CourseId}"), HttpStatusCode.NotFound, "NOT_FOUND");
    }

    [Fact]
    public async Task Invites_are_emailed_accepted_by_the_invited_email_only_and_expire()
    {
        using var teacher = await SignedInAsync(Roles.Instructor);
        var pc = await CreatePrivateCourseAsync(teacher);
        var invited = await F.CreateUserAsync();
        var member = await F.CreateUserAsync();
        using (var m = await TestClient.SignedInAsync(F, member.Email, member.Password))
            await Json(m.PostAsync("/api/v1/classes/join", new { code = pc.JoinCode }), HttpStatusCode.OK);

        var result = await Json(teacher.PostAsync($"/api/v1/instructor/classes/{pc.ClassId}/invites",
            new { emails = new[] { invited.Email.ToUpperInvariant(), "not-an-email", member.Email, invited.Email } }), HttpStatusCode.OK);
        Assert.Equal(1, result.GetProperty("invited").GetInt32());
        Assert.Equal(["not-an-email"], result.GetProperty("invalid").EnumerateArray().Select(e => e.GetString()!).ToArray());
        Assert.Equal([member.Email.ToLowerInvariant()], result.GetProperty("alreadyMembers").EnumerateArray().Select(e => e.GetString()!).ToArray());

        var mail = F.Email.LastTo(invited.Email);
        var link = mail.TextBody.Split('\n').Select(l => l.Trim()).First(l => l.StartsWith("http://app.test/join/", StringComparison.Ordinal));
        var token = link["http://app.test/join/".Length..];
        Assert.Equal(43, token.Length); // 32 bytes, base64url
        var stored = await F.WithDbAsync(db => db.ClassInvites.AsNoTracking().SingleAsync(i => i.ClassId == pc.ClassId));
        Assert.NotEqual(token, stored.TokenHash);
        Assert.Equal(64, stored.TokenHash.Length); // SHA-256 hex only

        // Anonymous lookup.
        using (var anon = await TestClient.CreateAsync(F))
        {
            var lookup = await Json(anon.GetAsync($"/api/v1/classes/invites/{token}"), HttpStatusCode.OK);
            Assert.Equal("valid", lookup.GetProperty("status").GetString());
            Assert.StartsWith(invited.Email[0] + "***@", lookup.GetProperty("emailMasked").GetString());
            Assert.Equal(HttpStatusCode.NotFound, (await anon.GetAsync("/api/v1/classes/invites/nope")).StatusCode);
        }

        // Someone else cannot use it.
        using (var other = await SignedInAsync())
            await ExpectProblem(other.PostAsync($"/api/v1/classes/invites/{token}/accept"), HttpStatusCode.Forbidden, "CLASS_INVITE_EMAIL_MISMATCH");

        using var invitedClient = await TestClient.SignedInAsync(F, invited.Email, invited.Password);
        var accepted = await Json(invitedClient.PostAsync($"/api/v1/classes/invites/{token}/accept"), HttpStatusCode.OK);
        Assert.Equal(pc.ClassId, accepted.GetProperty("classId").GetGuid());
        await Json(invitedClient.GetAsync($"/api/v1/lessons/{pc.LessonId}"), HttpStatusCode.OK);
        await Json(invitedClient.PostAsync($"/api/v1/classes/invites/{token}/accept"), HttpStatusCode.OK); // idempotent
        var invites = await Json(teacher.GetAsync($"/api/v1/instructor/classes/{pc.ClassId}/invites"), HttpStatusCode.OK);
        Assert.Equal("accepted", invites[0].GetProperty("status").GetString());

        // Expired and revoked invitations.
        var late = await F.CreateUserAsync();
        await Json(teacher.PostAsync($"/api/v1/instructor/classes/{pc.ClassId}/invites", new { emails = new[] { late.Email } }), HttpStatusCode.OK);
        var lateToken = F.Email.LastTo(late.Email).TextBody.Split('\n').Select(l => l.Trim()).First(l => l.StartsWith("http://app.test/join/"))["http://app.test/join/".Length..];
        await F.WithDbAsync(db => db.ClassInvites.Where(i => i.EmailNormalized == late.Email.ToLowerInvariant())
            .ExecuteUpdateAsync(s => s.SetProperty(i => i.ExpiresAt, DateTime.UtcNow.AddMinutes(-1))));
        using var lateClient = await TestClient.SignedInAsync(F, late.Email, late.Password);
        await ExpectProblem(lateClient.PostAsync($"/api/v1/classes/invites/{lateToken}/accept"), HttpStatusCode.Gone, "CLASS_INVITE_EXPIRED");

        // Resend issues a new link (old one stops working); revoke closes it.
        var inviteId = await F.WithDbAsync(db => db.ClassInvites.Where(i => i.EmailNormalized == late.Email.ToLowerInvariant()).Select(i => i.Id).SingleAsync());
        Assert.Equal(HttpStatusCode.NoContent, (await teacher.PostAsync($"/api/v1/instructor/invites/{inviteId}/resend")).StatusCode);
        var freshToken = F.Email.LastTo(late.Email).TextBody.Split('\n').Select(l => l.Trim()).First(l => l.StartsWith("http://app.test/join/"))["http://app.test/join/".Length..];
        Assert.NotEqual(lateToken, freshToken);
        Assert.Equal(HttpStatusCode.NotFound, (await lateClient.PostAsync($"/api/v1/classes/invites/{lateToken}/accept")).StatusCode);
        Assert.Equal(HttpStatusCode.NoContent, (await teacher.DeleteAsync($"/api/v1/instructor/invites/{inviteId}")).StatusCode);
        await ExpectProblem(lateClient.PostAsync($"/api/v1/classes/invites/{freshToken}/accept"), HttpStatusCode.Gone, "CLASS_INVITE_EXPIRED");
    }

    [Fact]
    public async Task Instructors_manage_only_their_own_courses_and_co_instructors_follow_the_owner_rules()
    {
        var a = await F.CreateUserAsync(Roles.Instructor);
        var b = await F.CreateUserAsync(Roles.Instructor);
        var student = await F.CreateUserAsync();
        using var ia = await TestClient.SignedInAsync(F, a.Email, a.Password);
        using var ib = await TestClient.SignedInAsync(F, b.Email, b.Password);
        var pc = await CreatePrivateCourseAsync(ia);
        var c = pc.CourseId;

        // B has no row for A's course: everything is 404 and the course is not listed.
        var bList = await Json(ib.GetAsync("/api/v1/instructor/courses"), HttpStatusCode.OK);
        Assert.DoesNotContain(bList.EnumerateArray(), x => x.GetProperty("id").GetGuid() == c);
        await ExpectProblem(ib.GetAsync($"/api/v1/instructor/courses/{c}"), HttpStatusCode.NotFound, "NOT_FOUND");
        await ExpectProblem(ib.PutAsync($"/api/v1/instructor/courses/{c}", new { title = "Hijack", slug = "hijack-" + Guid.NewGuid().ToString("N")[..6], isPublished = true }),
            HttpStatusCode.NotFound, "NOT_FOUND");
        await ExpectProblem(ib.DeleteAsync($"/api/v1/instructor/courses/{c}"), HttpStatusCode.NotFound, "NOT_FOUND");
        await ExpectProblem(ib.PostAsync($"/api/v1/instructor/courses/{c}/classes", new { name = "x" }), HttpStatusCode.NotFound, "NOT_FOUND");
        await ExpectProblem(ib.GetAsync($"/api/v1/instructor/classes/{pc.ClassId}/members"), HttpStatusCode.NotFound, "NOT_FOUND");
        await ExpectProblem(ib.PostAsync($"/api/v1/instructor/classes/{pc.ClassId}/regenerate-code"), HttpStatusCode.NotFound, "NOT_FOUND");
        await ExpectProblem(ib.GetAsync($"/api/v1/instructor/questions?courseId={c}"), HttpStatusCode.NotFound, "NOT_FOUND");
        await ExpectProblem(ib.GetAsync($"/api/v1/instructor/insights?courseId={c}"), HttpStatusCode.NotFound, "NOT_FOUND");
        await ExpectProblem(ib.GetAsync($"/api/v1/instructor/insights?classId={pc.ClassId}"), HttpStatusCode.NotFound, "NOT_FOUND");
        await ExpectProblem(ib.PostAsync($"/api/v1/instructor/courses/{c}/instructors", new { email = b.Email }), HttpStatusCode.NotFound, "NOT_FOUND");

        // Owner adds co-instructors: unknown user, non-instructor, then B.
        await ExpectProblem(ia.PostAsync($"/api/v1/instructor/courses/{c}/instructors", new { email = "nobody-" + Guid.NewGuid().ToString("N") + "@example.com" }),
            HttpStatusCode.NotFound, "USER_NOT_FOUND");
        await ExpectProblem(ia.PostAsync($"/api/v1/instructor/courses/{c}/instructors", new { email = student.Email }), HttpStatusCode.Conflict, "USER_NOT_INSTRUCTOR");
        var added = await Json(ia.PostAsync($"/api/v1/instructor/courses/{c}/instructors", new { email = b.Email }), HttpStatusCode.Created);
        Assert.Equal("instructor", added.GetProperty("role").GetString());
        var team = await Json(ia.GetAsync($"/api/v1/instructor/courses/{c}/instructors"), HttpStatusCode.OK);
        Assert.Equal(["owner", "instructor"], team.EnumerateArray().Select(x => x.GetProperty("role").GetString()!).ToArray());

        // B can now edit, but owner-only actions stay with A.
        var bCourse = await Json(ib.GetAsync($"/api/v1/instructor/courses/{c}"), HttpStatusCode.OK);
        Assert.Equal("instructor", bCourse.GetProperty("myRole").GetString());
        await Json(ib.GetAsync($"/api/v1/instructor/classes/{pc.ClassId}/members"), HttpStatusCode.OK);
        await ExpectProblem(ib.PostAsync($"/api/v1/instructor/courses/{c}/instructors", new { email = a.Email }), HttpStatusCode.Forbidden, "AUTH_FORBIDDEN");
        await ExpectProblem(ib.DeleteAsync($"/api/v1/instructor/courses/{c}"), HttpStatusCode.Forbidden, "AUTH_FORBIDDEN");
        await ExpectProblem(ib.DeleteAsync($"/api/v1/instructor/courses/{c}/instructors/{a.Id}"), HttpStatusCode.Forbidden, "AUTH_FORBIDDEN");

        // The last owner cannot leave; a co-instructor can remove themselves.
        await ExpectProblem(ia.DeleteAsync($"/api/v1/instructor/courses/{c}/instructors/{a.Id}"), HttpStatusCode.Conflict, "COURSE_LAST_OWNER");
        Assert.Equal(HttpStatusCode.NoContent, (await ib.DeleteAsync($"/api/v1/instructor/courses/{c}/instructors/{b.Id}")).StatusCode);
        await ExpectProblem(ib.GetAsync($"/api/v1/instructor/courses/{c}"), HttpStatusCode.NotFound, "NOT_FOUND");

        // Visibility can be changed; delete only without students.
        var updated = await Json(ia.PutAsync($"/api/v1/instructor/courses/{c}", new
        {
            title = "Now public", slug = "now-public-" + Guid.NewGuid().ToString("N")[..6], description = "d", isPublished = true, visibility = "public",
        }), HttpStatusCode.OK);
        Assert.Equal("public", updated.GetProperty("visibility").GetString());
        using (var s = await TestClient.SignedInAsync(F, student.Email, student.Password))
            await Json(s.PostAsync($"/api/v1/courses/{c}/enroll"), HttpStatusCode.OK);
        await ExpectProblem(ia.DeleteAsync($"/api/v1/instructor/courses/{c}"), HttpStatusCode.Conflict, "COURSE_HAS_STUDENTS");

        var empty = await Json(ia.PostAsync("/api/v1/instructor/courses", new
        {
            title = "Empty", slug = "empty-" + Guid.NewGuid().ToString("N")[..8], description = "", isPublished = false, visibility = "private",
        }), HttpStatusCode.Created);
        Assert.Equal(HttpStatusCode.NoContent, (await ia.DeleteAsync($"/api/v1/instructor/courses/{empty.GetProperty("id").GetGuid()}")).StatusCode);
        Assert.True(await F.WithDbAsync(db => db.AuditEvents.AnyAsync(e => e.Action == AuditActions.CourseDeleted && e.ActorUserId == a.Id)));

        // Admin manages every course (myRole "admin" without a row).
        var admin = await F.CreateUserAsync(Roles.Admin);
        using var ad = await TestClient.SignedInAsync(F, admin.Email, admin.Password);
        var adminView = await Json(ad.GetAsync($"/api/v1/instructor/courses/{c}"), HttpStatusCode.OK);
        Assert.Equal("admin", adminView.GetProperty("myRole").GetString());
    }
}
