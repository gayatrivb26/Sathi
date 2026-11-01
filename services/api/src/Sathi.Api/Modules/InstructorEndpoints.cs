using System.Text.Json;
using System.Text.RegularExpressions;
using FluentValidation;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;
using Sathi.Api.Infrastructure;
using Sathi.Core.Access;
using Sathi.Core.Ai;
using Sathi.Core.Data;
using Sathi.Core.Documents;
using Sathi.Core.Domain;
using Sathi.Core.Errors;
using Sathi.Core.Jobs;
using Sathi.Core.Learning;
using Sathi.Core.Security;
using Sathi.Core.Usage;

namespace Sathi.Api.Modules;

public sealed record CourseEditRequest(string Title, string Slug, string? Description, bool IsPublished, string? Visibility);
public sealed record ModuleEditRequest(string Title, string? Summary, int Position);
public sealed record LessonEditRequest(string Title, string? Summary, string? ContentMarkdown, int EstimatedMinutes, int Position,
    List<Guid>? ConceptIds, List<string>? Objectives);
public sealed record ConceptEditRequest(string Name, string Slug, string? Description, List<Guid>? PrerequisiteIds);
public sealed record OptionEdit(string Label, string Text, bool IsCorrect);
public sealed record RubricEdit(List<RubricCriterion> Criteria, string ModelAnswer);
public sealed record QuestionEditRequest(Guid ConceptId, Guid? LessonId, string Type, string Stem, string? Explanation, double Difficulty,
    string Status, bool IsDiagnostic, List<OptionEdit>? Options, RubricEdit? Rubric);
public sealed record GenerateQuestionsRequest(Guid CourseId, Guid ConceptId, int Count, double Difficulty);
public sealed record GradingReviewRequest(double FinalScore, string? Feedback);
public sealed record AddInstructorRequest(string Email);

/// <summary>Contract §11.1 InstructorCourse (+ createdAt/updatedAt).</summary>
public sealed record InstructorCourseDto(Guid Id, string Slug, string Title, string Description, bool IsPublished, string Visibility,
    int ModuleCount, int LessonCount, int ConceptCount, int QuestionCount, int StudentCount, int ClassCount, string MyRole,
    DateTime CreatedAt, DateTime UpdatedAt);
public sealed record InstructorLessonDto(Guid Id, Guid ModuleId, string Title, string Summary, string ContentMarkdown, int EstimatedMinutes, int Position,
    int Version, DateTime UpdatedAt, IReadOnlyList<Guid> ConceptIds, IReadOnlyList<string> Objectives);
public sealed record InstructorModuleDto(Guid Id, Guid CourseId, string Title, string Summary, int Position);
public sealed record InstructorModuleOutlineDto(Guid Id, string Title, string Summary, int Position, IReadOnlyList<InstructorLessonDto> Lessons);
public sealed record InstructorConceptDto(Guid Id, Guid CourseId, string Slug, string Name, string Description, IReadOnlyList<Guid> PrerequisiteIds);
public sealed record InstructorCourseDetailDto(Guid Id, string Slug, string Title, string Description, bool IsPublished, string Visibility, string MyRole,
    IReadOnlyList<InstructorModuleOutlineDto> Modules, IReadOnlyList<InstructorConceptDto> Concepts);
public sealed record CourseInstructorDto(Guid UserId, string DisplayName, string Email, string Role, DateTime AddedAt);
public sealed record QuestionOptionDto(Guid Id, string Label, string Text, bool IsCorrect, int Position);
public sealed record RubricDto(int Version, IReadOnlyList<RubricCriterion> Criteria, string ModelAnswer);
public sealed record QuestionDto(Guid Id, Guid CourseId, Guid ConceptId, string? ConceptName, Guid? LessonId, string Type, string Stem, string Explanation,
    double Difficulty, string Source, string Status, bool IsDiagnostic, DateTime CreatedAt, DateTime UpdatedAt,
    IReadOnlyList<QuestionOptionDto> Options, RubricDto? Rubric);
public sealed record RunRefDto(Guid RunId, string ReferenceId);
public sealed record GradingQueueItemDto(Guid GradingId, string StudentDisplayName, string QuestionStem, string? AnswerText, double AiScore, double MaxScore,
    double Confidence, string AiFeedback, RubricDto? Rubric, DateTime SubmittedAt);
public sealed record ConceptInsightDto(Guid ConceptId, string Name, double? AverageMastery, int StudentsBelowHalf);
public sealed record InsightsDto(int Enrolled, int ActiveLast7Days, int QuestionsAsked7Days, double? HelpfulRate, IReadOnlyList<ConceptInsightDto> ConceptMastery,
    int PendingReviews);

public sealed partial class CourseEditValidator : AbstractValidator<CourseEditRequest>
{
    [GeneratedRegex("^[a-z0-9]+(?:-[a-z0-9]+)*$")]
    public static partial Regex Slug();

    public CourseEditValidator()
    {
        RuleFor(x => x.Title).NotEmpty().MaximumLength(200);
        RuleFor(x => x.Slug).NotEmpty().MaximumLength(100).Matches(Slug()).WithMessage("Use lowercase letters, digits and dashes.");
        RuleFor(x => x.Description).MaximumLength(4000);
        RuleFor(x => x.Visibility).Must(v => v is null || CourseVisibilities.All.Contains(v)).WithMessage("Visibility must be public or private.");
    }
}

public sealed class ModuleEditValidator : AbstractValidator<ModuleEditRequest>
{
    public ModuleEditValidator()
    {
        RuleFor(x => x.Title).NotEmpty().MaximumLength(200);
        RuleFor(x => x.Position).GreaterThanOrEqualTo(1);
    }
}

public sealed class LessonEditValidator : AbstractValidator<LessonEditRequest>
{
    public LessonEditValidator()
    {
        RuleFor(x => x.Title).NotEmpty().MaximumLength(200);
        RuleFor(x => x.EstimatedMinutes).InclusiveBetween(1, 600);
        RuleFor(x => x.Position).GreaterThanOrEqualTo(1);
        RuleFor(x => x.ContentMarkdown).MaximumLength(500_000);
    }
}

public sealed class ConceptEditValidator : AbstractValidator<ConceptEditRequest>
{
    public ConceptEditValidator()
    {
        RuleFor(x => x.Name).NotEmpty().MaximumLength(200);
        RuleFor(x => x.Slug).NotEmpty().MaximumLength(100).Matches(CourseEditValidator.Slug()).WithMessage("Use lowercase letters, digits and dashes.");
    }
}

public sealed class QuestionEditValidator : AbstractValidator<QuestionEditRequest>
{
    public QuestionEditValidator()
    {
        RuleFor(x => x.ConceptId).NotEmpty();
        RuleFor(x => x.Type).Must(t => t is QuestionTypes.Mcq or QuestionTypes.Short).WithMessage("Type must be mcq or short.");
        RuleFor(x => x.Stem).NotEmpty().MaximumLength(4000);
        RuleFor(x => x.Difficulty).InclusiveBetween(0, 1);
        RuleFor(x => x.Status).Must(s => QuestionStatuses.All.Contains(s)).WithMessage("Status must be draft, published or archived.");
        When(x => x.Type == QuestionTypes.Mcq, () =>
        {
            RuleFor(x => x.Options).NotNull().Must(o => o!.Count is >= 2 and <= 6).WithMessage("Give 2–6 options.");
            RuleFor(x => x.Options).Must(o => o is null || o.Count(x => x.IsCorrect) == 1).WithMessage("Exactly one option must be correct.");
            RuleFor(x => x.Options).Must(o => o is null || o.Select(x => x.Label.Trim()).Distinct().Count() == o.Count).WithMessage("Option labels must be unique.");
        });
        When(x => x.Type == QuestionTypes.Short, () =>
        {
            RuleFor(x => x.Rubric).NotNull().WithMessage("Short-answer questions need a rubric.");
            RuleFor(x => x.Rubric!.Criteria).NotEmpty().When(x => x.Rubric is not null).WithMessage("Add at least one rubric criterion.");
        });
    }
}

public sealed class GenerateQuestionsValidator : AbstractValidator<GenerateQuestionsRequest>
{
    public GenerateQuestionsValidator()
    {
        RuleFor(x => x.CourseId).NotEmpty();
        RuleFor(x => x.ConceptId).NotEmpty();
        RuleFor(x => x.Count).InclusiveBetween(1, 10);
        RuleFor(x => x.Difficulty).InclusiveBetween(0, 1);
    }
}

public sealed class GradingReviewValidator : AbstractValidator<GradingReviewRequest>
{
    public GradingReviewValidator()
    {
        RuleFor(x => x.FinalScore).GreaterThanOrEqualTo(0);
        RuleFor(x => x.Feedback).MaximumLength(4000);
    }
}

public sealed class AddInstructorValidator : AbstractValidator<AddInstructorRequest>
{
    public AddInstructorValidator() => RuleFor(x => x.Email).NotEmpty().WithMessage("Email is required.").EmailAddress().WithMessage("Enter a valid email address.");
}

public static class InstructorEndpoints
{
    public static void MapInstructor(this RouteGroupBuilder api)
    {
        var g = api.MapGroup("/instructor").RequireAuthorization("Staff").WithTags("Instructor").WithProblems(401, 403, 404);

        g.MapGet("/courses", ListCoursesAsync).Doc("ListInstructorCourses", "Courses the instructor manages (all for Admin)");
        g.MapGet("/courses/{id:guid}", GetCourseAsync).Doc("GetInstructorCourse", "Full editable course outline");
        g.MapPost("/courses", CreateCourseAsync).Validate<CourseEditRequest>().WithProblems(400, 409)
            .Doc("CreateCourse", "Create a course; the creator becomes its owner");
        g.MapPut("/courses/{id:guid}", UpdateCourseAsync).Validate<CourseEditRequest>().WithProblems(400, 409)
            .Doc("UpdateCourse", "Edit title, slug, description, publication and visibility");
        g.MapDelete("/courses/{id:guid}", DeleteCourseAsync).WithProblems(409)
            .Doc("DeleteCourse", "Delete a course without students (owner or Admin); otherwise 409 COURSE_HAS_STUDENTS");

        g.MapGet("/courses/{id:guid}/instructors", ListInstructorsAsync).Doc("ListCourseInstructors", "Owners and co-instructors of a course");
        g.MapPost("/courses/{id:guid}/instructors", AddInstructorAsync).Validate<AddInstructorRequest>().WithProblems(400, 409)
            .Doc("AddCourseInstructor", "Add a co-instructor by email (owner or Admin; the user must have the Instructor role)");
        g.MapDelete("/courses/{id:guid}/instructors/{userId:guid}", RemoveInstructorAsync).WithProblems(409)
            .Doc("RemoveCourseInstructor", "Remove a co-instructor (owner, Admin or yourself); 409 COURSE_LAST_OWNER");

        g.MapPost("/courses/{id:guid}/modules", CreateModuleAsync).Validate<ModuleEditRequest>().WithProblems(400).Doc("CreateModule", "Add a module");
        g.MapPut("/modules/{id:guid}", UpdateModuleAsync).Validate<ModuleEditRequest>().WithProblems(400).Doc("UpdateModule", "Edit a module");
        g.MapDelete("/modules/{id:guid}", DeleteModuleAsync).Doc("DeleteModule", "Delete a module and its lessons");

        g.MapPost("/modules/{id:guid}/lessons", CreateLessonAsync).Validate<LessonEditRequest>().WithProblems(400)
            .Doc("CreateLesson", "Add a lesson (enqueues indexing)");
        g.MapPut("/lessons/{id:guid}", UpdateLessonAsync).Validate<LessonEditRequest>().WithProblems(400)
            .Doc("UpdateLesson", "Edit a lesson; changed content bumps the version and re-indexes");
        g.MapDelete("/lessons/{id:guid}", DeleteLessonAsync).Doc("DeleteLesson", "Delete a lesson");

        g.MapPost("/courses/{id:guid}/concepts", CreateConceptAsync).Validate<ConceptEditRequest>().WithProblems(400, 409).Doc("CreateConcept", "Add a concept");
        g.MapPut("/concepts/{id:guid}", UpdateConceptAsync).Validate<ConceptEditRequest>().WithProblems(400, 409).Doc("UpdateConcept", "Edit a concept");

        g.MapGet("/courses/{id:guid}/documents", async (Guid id, HttpContext ctx, AppDbContext db, DocumentService docs, CancellationToken ct) =>
        {
            await EditableCourseAsync(db, ctx, id, ct);
            return await docs.ListAsync(db.Documents.Where(d => d.CourseId == id && d.Scope == DocumentScopes.Course && d.SourceType == SourceTypes.Upload), ct);
        }).Doc("ListCourseDocuments", "Course-scope uploads");
        g.MapPost("/courses/{id:guid}/documents", async (Guid id, HttpContext ctx, AppDbContext db, DocumentService docs,
            Microsoft.Extensions.Options.IOptions<Core.Options.QuotaOptions> q, CancellationToken ct) =>
        {
            await EditableCourseAsync(db, ctx, id, ct);
            return await DocumentsEndpoints.UploadAsync(ctx, docs, q.Value, DocumentScopes.Course, id, ct);
        }).DisableAntiforgery().Accepts<IFormFile>("multipart/form-data").WithProblems(400, 413, 415, 429)
            .Doc("UploadCourseDocument", "Upload a course document (same rules as notes; Idempotency-Key supported)");

        g.MapGet("/questions", ListQuestionsAsync).Doc("ListQuestions", "Question bank of a managed course");
        g.MapPost("/questions", CreateQuestionAsync).Validate<QuestionEditRequest>().WithProblems(400).Doc("CreateQuestion", "Create a question");
        g.MapPut("/questions/{id:guid}", UpdateQuestionAsync).Validate<QuestionEditRequest>().WithProblems(400).Doc("UpdateQuestion", "Edit a question");
        g.MapPost("/questions/generate", GenerateAsync).Validate<GenerateQuestionsRequest>().WithProblems(400)
            .Doc("GenerateQuestions", "Generate draft questions with AI (background job)");

        g.MapGet("/grading-queue", GradingQueueAsync).Doc("GetGradingQueue", "Short answers needing review (optionally one course or class)");
        g.MapPost("/grading/{gradingId:guid}/review", ReviewAsync).Validate<GradingReviewRequest>().WithProblems(400, 409)
            .Doc("ReviewGrading", "Record the instructor's final score");
        g.MapGet("/insights", InsightsAsync).WithProblems(400).Doc("GetInsights", "Course (or class) learning insights");
    }

    // ---------------- access ----------------

    private static IQueryable<Course> Editable(AppDbContext db, HttpContext ctx) => CourseAccess.Manageable(db, ctx.User.Viewer());

    public static async Task<Course> EditableCourseAsync(AppDbContext db, HttpContext ctx, Guid courseId, CancellationToken ct) =>
        await Editable(db, ctx).FirstOrDefaultAsync(c => c.Id == courseId, ct) ?? throw AppException.NotFound("Course not found.");

    /// <summary>"owner" / "instructor" from course_instructors, "admin" for an Admin without a row.</summary>
    public static async Task<string> MyRoleAsync(AppDbContext db, HttpContext ctx, Guid courseId, CancellationToken ct)
    {
        var userId = ctx.User.GetUserId();
        var role = await db.CourseInstructors.Where(ci => ci.CourseId == courseId && ci.UserId == userId).Select(ci => ci.Role).FirstOrDefaultAsync(ct);
        return role ?? CourseInstructorRoles.Admin;
    }

    /// <summary>Owner or Admin, else 403.</summary>
    private static async Task EnsureOwnerAsync(AppDbContext db, HttpContext ctx, Guid courseId, CancellationToken ct)
    {
        if (ctx.User.IsInRole(Roles.Admin)) return;
        if (await MyRoleAsync(db, ctx, courseId, ct) != CourseInstructorRoles.Owner)
            throw AppException.Forbidden("Only the course owner or an administrator can do this.");
    }

    private static async Task<CourseModule> EditableModuleAsync(AppDbContext db, HttpContext ctx, Guid moduleId, CancellationToken ct)
    {
        var module = await db.CourseModules.FirstOrDefaultAsync(m => m.Id == moduleId, ct) ?? throw AppException.NotFound("Module not found.");
        await EditableCourseAsync(db, ctx, module.CourseId, ct);
        return module;
    }

    private static async Task<(Lesson Lesson, Guid CourseId)> EditableLessonAsync(AppDbContext db, HttpContext ctx, Guid lessonId, CancellationToken ct)
    {
        var lesson = await db.Lessons.Include(l => l.Module).Include(l => l.LessonConcepts).Include(l => l.Objectives)
            .FirstOrDefaultAsync(l => l.Id == lessonId, ct) ?? throw AppException.NotFound("Lesson not found.");
        await EditableCourseAsync(db, ctx, lesson.Module!.CourseId, ct);
        return (lesson, lesson.Module.CourseId);
    }

    /// <summary>Students of a course: enrolments that are not the course's own instructors.</summary>
    private static IQueryable<Guid> CourseStudents(AppDbContext db, Guid courseId) =>
        db.Enrollments.Where(e => e.CourseId == courseId && !db.CourseInstructors.Any(ci => ci.CourseId == courseId && ci.UserId == e.UserId))
            .Select(e => e.UserId);

    // ---------------- courses ----------------

    private static async Task<List<InstructorCourseDto>> CourseDtosAsync(AppDbContext db, HttpContext ctx, IQueryable<Course> courses, CancellationToken ct)
    {
        var userId = ctx.User.GetUserId();
        var isAdmin = ctx.User.IsInRole(Roles.Admin);
        var rows = await courses.AsNoTracking().OrderBy(c => c.Title).Select(c => new
        {
            c.Id, c.Slug, c.Title, c.Description, c.IsPublished, c.Visibility, c.CreatedAt, c.UpdatedAt,
            Modules = db.CourseModules.Count(m => m.CourseId == c.Id),
            Lessons = db.Lessons.Count(l => l.Module!.CourseId == c.Id),
            Concepts = db.Concepts.Count(x => x.CourseId == c.Id),
            Questions = db.Questions.Count(q => q.CourseId == c.Id),
            Students = db.Enrollments.Count(e => e.CourseId == c.Id && !db.CourseInstructors.Any(ci => ci.CourseId == c.Id && ci.UserId == e.UserId)),
            Classes = db.Classes.Count(k => k.CourseId == c.Id && k.ArchivedAt == null),
            Role = db.CourseInstructors.Where(ci => ci.CourseId == c.Id && ci.UserId == userId).Select(ci => ci.Role).FirstOrDefault(),
        }).ToListAsync(ct);
        return rows.Select(r => new InstructorCourseDto(r.Id, r.Slug, r.Title, r.Description, r.IsPublished, r.Visibility, r.Modules, r.Lessons, r.Concepts,
            r.Questions, r.Students, r.Classes, r.Role ?? (isAdmin ? CourseInstructorRoles.Admin : CourseInstructorRoles.Instructor), r.CreatedAt, r.UpdatedAt)).ToList();
    }

    private static Task<List<InstructorCourseDto>> ListCoursesAsync(HttpContext ctx, AppDbContext db, CancellationToken ct) =>
        CourseDtosAsync(db, ctx, Editable(db, ctx), ct);

    private static async Task<InstructorCourseDetailDto> GetCourseAsync(Guid id, HttpContext ctx, AppDbContext db, CancellationToken ct)
    {
        var course = await EditableCourseAsync(db, ctx, id, ct);
        var modules = await db.CourseModules.AsNoTracking().Where(m => m.CourseId == id).OrderBy(m => m.Position)
            .Include(m => m.Lessons).ThenInclude(l => l.LessonConcepts)
            .Include(m => m.Lessons).ThenInclude(l => l.Objectives).ToListAsync(ct);
        var concepts = await db.Concepts.AsNoTracking().Where(c => c.CourseId == id).OrderBy(c => c.Id).ToListAsync(ct);
        var ids = concepts.Select(c => c.Id).ToList();
        var prereqs = await db.ConceptPrerequisites.AsNoTracking().Where(p => ids.Contains(p.ConceptId)).ToListAsync(ct);
        return new InstructorCourseDetailDto(course.Id, course.Slug, course.Title, course.Description, course.IsPublished, course.Visibility,
            await MyRoleAsync(db, ctx, id, ct),
            modules.Select(m => new InstructorModuleOutlineDto(m.Id, m.Title, m.Summary, m.Position,
                m.Lessons.OrderBy(l => l.Position).Select(LessonDto).ToList())).ToList(),
            concepts.Select(c => new InstructorConceptDto(c.Id, c.CourseId, c.Slug, c.Name, c.Description,
                prereqs.Where(p => p.ConceptId == c.Id).Select(p => p.PrerequisiteConceptId).ToList())).ToList());
    }

    private static async Task<Created<InstructorCourseDto>> CreateCourseAsync(CourseEditRequest req, HttpContext ctx, AppDbContext db, CancellationToken ct)
    {
        if (await db.Courses.AnyAsync(c => c.Slug == req.Slug, ct)) throw AppException.Conflict("A course with this slug already exists.");
        var userId = ctx.User.GetUserId();
        var c = new Course
        {
            Title = req.Title.Trim(), Slug = req.Slug, Description = req.Description ?? "", Domain = req.Slug, IsPublished = req.IsPublished,
            Visibility = req.Visibility ?? CourseVisibilities.Public, CreatedBy = userId,
        };
        db.Courses.Add(c);
        db.CourseInstructors.Add(new CourseInstructor { CourseId = c.Id, UserId = userId, Role = CourseInstructorRoles.Owner, AddedAt = DateTime.UtcNow });
        db.Audit(userId, AuditActions.CourseCreated, "course", c.Id, new { c.Slug, c.Visibility, c.IsPublished });
        await db.SaveChangesAsync(ct);
        var dto = (await CourseDtosAsync(db, ctx, db.Courses.Where(x => x.Id == c.Id), ct)).Single();
        return TypedResults.Created($"/api/v1/instructor/courses/{c.Id}", dto);
    }

    private static async Task<InstructorCourseDto> UpdateCourseAsync(Guid id, CourseEditRequest req, HttpContext ctx, AppDbContext db, CancellationToken ct)
    {
        var c = await EditableCourseAsync(db, ctx, id, ct);
        if (req.Slug != c.Slug && await db.Courses.AnyAsync(x => x.Slug == req.Slug && x.Id != id, ct))
            throw AppException.Conflict("A course with this slug already exists.");
        var before = new { c.IsPublished, c.Visibility };
        c.Title = req.Title.Trim();
        c.Slug = req.Slug;
        c.Description = req.Description ?? "";
        c.IsPublished = req.IsPublished;
        if (req.Visibility is not null) c.Visibility = req.Visibility;
        c.UpdatedAt = DateTime.UtcNow;
        if (before.IsPublished != c.IsPublished || before.Visibility != c.Visibility)
            db.Audit(ctx.User.GetUserId(), AuditActions.CourseUpdated, "course", c.Id, new { before, after = new { c.IsPublished, c.Visibility } });
        await db.SaveChangesAsync(ct);
        return (await CourseDtosAsync(db, ctx, db.Courses.Where(x => x.Id == c.Id), ct)).Single();
    }

    private static async Task<NoContent> DeleteCourseAsync(Guid id, HttpContext ctx, AppDbContext db, CancellationToken ct)
    {
        var c = await EditableCourseAsync(db, ctx, id, ct);
        await EnsureOwnerAsync(db, ctx, id, ct);
        if (await CourseStudents(db, id).AnyAsync(ct))
            throw new AppException(409, ErrorCodes.CourseHasStudents, "Students are enrolled in this course. Unpublish it instead.");

        // Indexed copies (lessons and course uploads) are removed asynchronously through the outbox.
        var lessonDocs = await db.Lessons.Where(l => l.Module!.CourseId == id && l.DocumentId != null).Select(l => l.DocumentId!.Value).ToListAsync(ct);
        var courseDocs = await db.Documents.Where(d => d.CourseId == id && d.Scope == DocumentScopes.Course && d.DeletedAt == null).Select(d => d.Id).ToListAsync(ct);
        await RetireDocumentsAsync(db, ctx, lessonDocs.Concat(courseDocs).Distinct().ToList(), "course_deleted", ct);
        db.Courses.Remove(c);
        db.Audit(ctx.User.GetUserId(), AuditActions.CourseDeleted, "course", id, new { c.Slug });
        await db.SaveChangesAsync(ct);
        return TypedResults.NoContent();
    }

    // ---------------- co-instructors ----------------

    private static async Task<List<CourseInstructorDto>> ListInstructorsAsync(Guid id, HttpContext ctx, AppDbContext db, CancellationToken ct)
    {
        await EditableCourseAsync(db, ctx, id, ct);
        return await (from ci in db.CourseInstructors
                      join u in db.Users on ci.UserId equals u.Id
                      where ci.CourseId == id
                      orderby ci.Role == CourseInstructorRoles.Owner descending, ci.AddedAt
                      select new CourseInstructorDto(u.Id, u.DisplayName, u.Email ?? "", ci.Role, ci.AddedAt)).AsNoTracking().ToListAsync(ct);
    }

    private static async Task<Created<CourseInstructorDto>> AddInstructorAsync(Guid id, AddInstructorRequest req, HttpContext ctx, AppDbContext db,
        UserManager<AppUser> users, CancellationToken ct)
    {
        await EditableCourseAsync(db, ctx, id, ct);
        await EnsureOwnerAsync(db, ctx, id, ct);
        var user = await users.FindByEmailAsync(req.Email.Trim());
        if (user is null || user.DeletedAt is not null) throw new AppException(404, ErrorCodes.UserNotFound, "No account uses that email address.");
        if (!await users.IsInRoleAsync(user, Roles.Instructor))
            throw new AppException(409, ErrorCodes.UserNotInstructor, "That person isn't an instructor yet. An administrator can invite them as staff.");

        var row = await db.CourseInstructors.FirstOrDefaultAsync(ci => ci.CourseId == id && ci.UserId == user.Id, ct);
        if (row is null)
        {
            row = new CourseInstructor { CourseId = id, UserId = user.Id, Role = CourseInstructorRoles.Instructor, AddedAt = DateTime.UtcNow };
            db.CourseInstructors.Add(row);
            db.Audit(ctx.User.GetUserId(), AuditActions.CourseInstructorAdded, "course", id, new { userId = user.Id });
            await db.SaveChangesAsync(ct);
        }
        return TypedResults.Created($"/api/v1/instructor/courses/{id}/instructors",
            new CourseInstructorDto(user.Id, user.DisplayName, user.Email ?? "", row.Role, row.AddedAt));
    }

    private static async Task<NoContent> RemoveInstructorAsync(Guid id, Guid userId, HttpContext ctx, AppDbContext db, CancellationToken ct)
    {
        await EditableCourseAsync(db, ctx, id, ct);
        if (userId != ctx.User.GetUserId()) await EnsureOwnerAsync(db, ctx, id, ct);
        var row = await db.CourseInstructors.FirstOrDefaultAsync(ci => ci.CourseId == id && ci.UserId == userId, ct)
                  ?? throw AppException.NotFound("That person isn't an instructor of this course.");
        if (row.Role == CourseInstructorRoles.Owner
            && !await db.CourseInstructors.AnyAsync(ci => ci.CourseId == id && ci.UserId != userId && ci.Role == CourseInstructorRoles.Owner, ct))
            throw new AppException(409, ErrorCodes.CourseLastOwner, "A course needs at least one owner.");
        db.CourseInstructors.Remove(row);
        db.Audit(ctx.User.GetUserId(), AuditActions.CourseInstructorRemoved, "course", id, new { userId });
        await db.SaveChangesAsync(ct);
        return TypedResults.NoContent();
    }

    // ---------------- modules ----------------

    private static InstructorModuleDto ModuleDto(CourseModule m) => new(m.Id, m.CourseId, m.Title, m.Summary, m.Position);

    private static async Task<Created<InstructorModuleDto>> CreateModuleAsync(Guid id, ModuleEditRequest req, HttpContext ctx, AppDbContext db, CancellationToken ct)
    {
        await EditableCourseAsync(db, ctx, id, ct);
        var m = new CourseModule { CourseId = id, Title = req.Title.Trim(), Summary = req.Summary ?? "", Position = req.Position };
        db.CourseModules.Add(m);
        await db.SaveChangesAsync(ct);
        return TypedResults.Created($"/api/v1/instructor/modules/{m.Id}", ModuleDto(m));
    }

    private static async Task<InstructorModuleDto> UpdateModuleAsync(Guid id, ModuleEditRequest req, HttpContext ctx, AppDbContext db, CancellationToken ct)
    {
        var m = await EditableModuleAsync(db, ctx, id, ct);
        m.Title = req.Title.Trim();
        m.Summary = req.Summary ?? "";
        m.Position = req.Position;
        await db.SaveChangesAsync(ct);
        return ModuleDto(m);
    }

    private static async Task<NoContent> DeleteModuleAsync(Guid id, HttpContext ctx, AppDbContext db, CancellationToken ct)
    {
        var m = await EditableModuleAsync(db, ctx, id, ct);
        var docIds = await db.Lessons.Where(l => l.ModuleId == id && l.DocumentId != null).Select(l => l.DocumentId!.Value).ToListAsync(ct);
        await RetireDocumentsAsync(db, ctx, docIds, "lesson_deleted", ct);
        db.CourseModules.Remove(m);
        await db.SaveChangesAsync(ct);
        return TypedResults.NoContent();
    }

    private static async Task RetireDocumentsAsync(AppDbContext db, HttpContext ctx, IReadOnlyCollection<Guid> docIds, string reason, CancellationToken ct)
    {
        if (docIds.Count == 0) return;
        var now = DateTime.UtcNow;
        var docs = await db.Documents.Where(d => docIds.Contains(d.Id) && d.DeletedAt == null).ToListAsync(ct);
        foreach (var d in docs)
        {
            d.DeletedAt = now;
            var prefix = d.SourceType == SourceTypes.Upload ? $"uploads/courses/{d.CourseId}/{d.Id}/" : null;
            db.Outbox(OutboxTypes.DocumentDeleted, new { documentId = d.Id, storagePrefix = prefix });
            db.Audit(ctx.User.GetUserId(), AuditActions.DocumentDelete, "document", d.Id, new { reason });
        }
    }

    // ---------------- lessons ----------------

    private static InstructorLessonDto LessonDto(Lesson l) => new(l.Id, l.ModuleId, l.Title, l.Summary, l.ContentMarkdown, l.EstimatedMinutes, l.Position,
        l.Version, l.UpdatedAt, l.LessonConcepts.Select(x => x.ConceptId).ToList(), l.Objectives.OrderBy(o => o.Position).Select(o => o.Text).ToList());

    private static async Task ApplyLessonAsync(AppDbContext db, Lesson lesson, Guid courseId, LessonEditRequest req, CancellationToken ct)
    {
        lesson.Title = req.Title.Trim();
        lesson.Summary = req.Summary ?? "";
        lesson.EstimatedMinutes = req.EstimatedMinutes;
        lesson.Position = req.Position;
        lesson.UpdatedAt = DateTime.UtcNow;

        var wanted = (req.ConceptIds ?? []).Distinct().ToList();
        var valid = await db.Concepts.Where(c => c.CourseId == courseId && wanted.Contains(c.Id)).Select(c => c.Id).ToListAsync(ct);
        if (valid.Count != wanted.Count) throw AppException.Validation("conceptIds", "Some concepts are not part of this course.");
        lesson.LessonConcepts.RemoveAll(x => !wanted.Contains(x.ConceptId));
        foreach (var cid in wanted.Where(c => lesson.LessonConcepts.All(x => x.ConceptId != c)))
            lesson.LessonConcepts.Add(new LessonConcept { LessonId = lesson.Id, ConceptId = cid });

        var objectives = (req.Objectives ?? []).Where(o => !string.IsNullOrWhiteSpace(o)).Select(o => o.Trim()).ToList();
        db.LearningObjectives.RemoveRange(lesson.Objectives);
        lesson.Objectives.Clear();
        for (var i = 0; i < objectives.Count; i++)
            lesson.Objectives.Add(new LearningObjective { LessonId = lesson.Id, Text = objectives[i], Position = i + 1 });
    }

    private static async Task<Created<InstructorLessonDto>> CreateLessonAsync(Guid id, LessonEditRequest req, HttpContext ctx, AppDbContext db, JobScheduler jobs,
        CancellationToken ct)
    {
        var module = await EditableModuleAsync(db, ctx, id, ct);
        var lesson = new Lesson { ModuleId = module.Id, ContentMarkdown = (req.ContentMarkdown ?? "").Replace("\r\n", "\n"), Version = 1 };
        db.Lessons.Add(lesson);
        await ApplyLessonAsync(db, lesson, module.CourseId, req, ct);
        await db.SaveChangesAsync(ct);
        jobs.EnqueueIndexLesson(lesson.Id, lesson.Version, TraceIds.CurrentTraceParent());
        return TypedResults.Created($"/api/v1/instructor/lessons/{lesson.Id}", LessonDto(lesson));
    }

    private static async Task<InstructorLessonDto> UpdateLessonAsync(Guid id, LessonEditRequest req, HttpContext ctx, AppDbContext db, JobScheduler jobs,
        CancellationToken ct)
    {
        var (lesson, courseId) = await EditableLessonAsync(db, ctx, id, ct);
        var content = (req.ContentMarkdown ?? lesson.ContentMarkdown).Replace("\r\n", "\n");
        var changed = content != lesson.ContentMarkdown || req.Title.Trim() != lesson.Title;
        lesson.ContentMarkdown = content;
        if (changed) lesson.Version += 1;
        await ApplyLessonAsync(db, lesson, courseId, req, ct);
        await db.SaveChangesAsync(ct);
        if (changed) jobs.EnqueueIndexLesson(lesson.Id, lesson.Version, TraceIds.CurrentTraceParent());
        return LessonDto(lesson);
    }

    private static async Task<NoContent> DeleteLessonAsync(Guid id, HttpContext ctx, AppDbContext db, CancellationToken ct)
    {
        var (lesson, _) = await EditableLessonAsync(db, ctx, id, ct);
        if (lesson.DocumentId is { } did) await RetireDocumentsAsync(db, ctx, [did], "lesson_deleted", ct);
        db.Lessons.Remove(lesson);
        await db.SaveChangesAsync(ct);
        return TypedResults.NoContent();
    }

    // ---------------- concepts ----------------

    private static async Task ApplyPrerequisitesAsync(AppDbContext db, Guid conceptId, Guid courseId, List<Guid>? prerequisiteIds, CancellationToken ct)
    {
        var wanted = (prerequisiteIds ?? []).Where(p => p != conceptId).Distinct().ToList();
        var valid = await db.Concepts.Where(c => c.CourseId == courseId && wanted.Contains(c.Id)).Select(c => c.Id).ToListAsync(ct);
        if (valid.Count != wanted.Count) throw AppException.Validation("prerequisiteIds", "Some prerequisites are not part of this course.");
        await db.ConceptPrerequisites.Where(p => p.ConceptId == conceptId).ExecuteDeleteAsync(ct);
        foreach (var p in wanted) db.ConceptPrerequisites.Add(new ConceptPrerequisite { ConceptId = conceptId, PrerequisiteConceptId = p });
    }

    private static async Task<Created<InstructorConceptDto>> CreateConceptAsync(Guid id, ConceptEditRequest req, HttpContext ctx, AppDbContext db, CancellationToken ct)
    {
        await EditableCourseAsync(db, ctx, id, ct);
        if (await db.Concepts.AnyAsync(c => c.CourseId == id && c.Slug == req.Slug, ct)) throw AppException.Conflict("A concept with this slug already exists.");
        var c = new Concept { CourseId = id, Name = req.Name.Trim(), Slug = req.Slug, Description = req.Description ?? "" };
        db.Concepts.Add(c);
        await db.SaveChangesAsync(ct);
        await ApplyPrerequisitesAsync(db, c.Id, id, req.PrerequisiteIds, ct);
        await db.SaveChangesAsync(ct);
        return TypedResults.Created($"/api/v1/instructor/concepts/{c.Id}",
            new InstructorConceptDto(c.Id, c.CourseId, c.Slug, c.Name, c.Description, req.PrerequisiteIds ?? []));
    }

    private static async Task<InstructorConceptDto> UpdateConceptAsync(Guid id, ConceptEditRequest req, HttpContext ctx, AppDbContext db, CancellationToken ct)
    {
        var c = await db.Concepts.FirstOrDefaultAsync(x => x.Id == id, ct) ?? throw AppException.NotFound("Concept not found.");
        await EditableCourseAsync(db, ctx, c.CourseId, ct);
        if (req.Slug != c.Slug && await db.Concepts.AnyAsync(x => x.CourseId == c.CourseId && x.Slug == req.Slug && x.Id != id, ct))
            throw AppException.Conflict("A concept with this slug already exists.");
        c.Name = req.Name.Trim();
        c.Slug = req.Slug;
        c.Description = req.Description ?? "";
        await ApplyPrerequisitesAsync(db, c.Id, c.CourseId, req.PrerequisiteIds, ct);
        await db.SaveChangesAsync(ct);
        return new InstructorConceptDto(c.Id, c.CourseId, c.Slug, c.Name, c.Description, req.PrerequisiteIds ?? []);
    }

    // ---------------- questions ----------------

    private static RubricDto? ToRubric(Rubric? r) => r is null
        ? null
        : new RubricDto(r.Version, JsonSerializer.Deserialize<List<RubricCriterion>>(r.CriteriaJson, AiJson.Options) ?? [], r.ModelAnswer);

    private static async Task<QuestionDto> QuestionDtoAsync(AppDbContext db, Question q, CancellationToken ct)
    {
        var rubric = await db.Rubrics.AsNoTracking().Where(r => r.QuestionId == q.Id).OrderByDescending(r => r.Version).FirstOrDefaultAsync(ct);
        return ToQuestionDto(q, rubric);
    }

    private static QuestionDto ToQuestionDto(Question q, Rubric? rubric) => new(
        q.Id, q.CourseId, q.ConceptId, q.Concept?.Name, q.LessonId, q.Type, q.Stem, q.Explanation, q.Difficulty, q.Source, q.Status,
        q.IsDiagnostic, q.CreatedAt, q.UpdatedAt,
        q.Options.OrderBy(o => o.Position).Select(o => new QuestionOptionDto(o.Id, o.Label, o.Text, o.IsCorrect, o.Position)).ToList(),
        ToRubric(rubric));

    private static async Task<List<QuestionDto>> ListQuestionsAsync(Guid courseId, string? status, Guid? conceptId, HttpContext ctx, AppDbContext db,
        CancellationToken ct)
    {
        await EditableCourseAsync(db, ctx, courseId, ct);
        var q = db.Questions.AsNoTracking().Include(x => x.Options).Include(x => x.Concept).Where(x => x.CourseId == courseId);
        if (!string.IsNullOrWhiteSpace(status)) q = q.Where(x => x.Status == status);
        if (conceptId is { } cid) q = q.Where(x => x.ConceptId == cid);
        var list = await q.OrderByDescending(x => x.UpdatedAt).Take(500).ToListAsync(ct);
        var ids = list.Select(x => x.Id).ToList();
        var rubrics = (await db.Rubrics.AsNoTracking().Where(r => ids.Contains(r.QuestionId)).ToListAsync(ct))
            .GroupBy(r => r.QuestionId).ToDictionary(g => g.Key, g => g.OrderByDescending(r => r.Version).First());
        return list.Select(x => ToQuestionDto(x, rubrics.GetValueOrDefault(x.Id))).ToList();
    }

    private static async Task ApplyQuestionAsync(AppDbContext db, Question q, QuestionEditRequest req, CancellationToken ct)
    {
        q.ConceptId = req.ConceptId;
        q.LessonId = req.LessonId;
        q.Type = req.Type;
        q.Stem = req.Stem.Trim();
        q.Explanation = req.Explanation ?? "";
        q.Difficulty = req.Difficulty;
        q.Status = req.Status;
        q.IsDiagnostic = req.IsDiagnostic;
        q.UpdatedAt = DateTime.UtcNow;

        var options = req.Type == QuestionTypes.Mcq ? req.Options ?? [] : [];
        for (var i = 0; i < options.Count; i++)
        {
            var label = options[i].Label.Trim();
            var opt = q.Options.FirstOrDefault(o => o.Label == label);
            if (opt is null)
            {
                opt = new QuestionOption { QuestionId = q.Id, Label = label };
                q.Options.Add(opt);
                db.QuestionOptions.Add(opt);
            }
            opt.Text = options[i].Text;
            opt.IsCorrect = options[i].IsCorrect;
            opt.Position = i;
        }
        foreach (var extra in q.Options.Where(o => options.All(x => x.Label.Trim() != o.Label)).ToList())
        {
            q.Options.Remove(extra);
            db.QuestionOptions.Remove(extra);
        }

        if (req.Rubric is { } r)
        {
            var json = JsonSerializer.Serialize(r.Criteria, AiJson.Options);
            var latest = await db.Rubrics.Where(x => x.QuestionId == q.Id).OrderByDescending(x => x.Version).FirstOrDefaultAsync(ct);
            if (latest is null || latest.ModelAnswer != r.ModelAnswer || !JsonElement.DeepEquals(JsonDocument.Parse(latest.CriteriaJson).RootElement, JsonDocument.Parse(json).RootElement))
                db.Rubrics.Add(new Rubric { QuestionId = q.Id, Version = (latest?.Version ?? 0) + 1, CriteriaJson = json, ModelAnswer = r.ModelAnswer });
        }
    }

    private static async Task ValidateQuestionTargetsAsync(AppDbContext db, Guid courseId, QuestionEditRequest req, CancellationToken ct)
    {
        if (req.LessonId is { } lid && !await db.Lessons.AnyAsync(l => l.Id == lid && l.Module!.CourseId == courseId, ct))
            throw AppException.Validation("lessonId", "That lesson is not part of this course.");
    }

    private static async Task<Created<QuestionDto>> CreateQuestionAsync(QuestionEditRequest req, HttpContext ctx, AppDbContext db, CancellationToken ct)
    {
        var concept = await db.Concepts.FirstOrDefaultAsync(c => c.Id == req.ConceptId, ct) ?? throw AppException.Validation("conceptId", "Unknown concept.");
        await EditableCourseAsync(db, ctx, concept.CourseId, ct);
        await ValidateQuestionTargetsAsync(db, concept.CourseId, req, ct);
        var q = new Question { CourseId = concept.CourseId, Source = QuestionSources.Instructor, CreatedBy = ctx.User.GetUserId() };
        db.Questions.Add(q);
        await ApplyQuestionAsync(db, q, req, ct);
        await db.SaveChangesAsync(ct);
        q.Concept = concept;
        return TypedResults.Created($"/api/v1/instructor/questions/{q.Id}", await QuestionDtoAsync(db, q, ct));
    }

    private static async Task<QuestionDto> UpdateQuestionAsync(Guid id, QuestionEditRequest req, HttpContext ctx, AppDbContext db, CancellationToken ct)
    {
        var q = await db.Questions.Include(x => x.Options).Include(x => x.Concept).FirstOrDefaultAsync(x => x.Id == id, ct)
                ?? throw AppException.NotFound("Question not found.");
        await EditableCourseAsync(db, ctx, q.CourseId, ct);
        if (!await db.Concepts.AnyAsync(c => c.Id == req.ConceptId && c.CourseId == q.CourseId, ct))
            throw AppException.Validation("conceptId", "That concept is not part of this course.");
        await ValidateQuestionTargetsAsync(db, q.CourseId, req, ct);
        await ApplyQuestionAsync(db, q, req, ct);
        await db.SaveChangesAsync(ct);
        q.Concept = await db.Concepts.FirstAsync(c => c.Id == q.ConceptId, ct);
        return await QuestionDtoAsync(db, q, ct);
    }

    private static async Task<Accepted<RunRefDto>> GenerateAsync(GenerateQuestionsRequest req, HttpContext ctx, AppDbContext db, JobScheduler jobs,
        UserIdHasher hasher, CancellationToken ct)
    {
        await EditableCourseAsync(db, ctx, req.CourseId, ct);
        if (!await db.Concepts.AnyAsync(c => c.Id == req.ConceptId && c.CourseId == req.CourseId, ct))
            throw AppException.Validation("conceptId", "That concept is not part of this course.");
        var userId = ctx.User.GetUserId();
        var run = RunLedger.NewRun(AiRunTypes.QuizGeneration, userId, hasher);
        db.AiRuns.Add(run);
        await db.SaveChangesAsync(ct);
        run.HangfireJobId = jobs.EnqueueGenerateQuestions(req.CourseId, req.ConceptId, req.Count, req.Difficulty, userId, TraceIds.CurrentTraceParent(), run.Id);
        await db.SaveChangesAsync(CancellationToken.None);
        return TypedResults.Accepted($"/api/v1/admin/runs/lookup/{run.Id}", new RunRefDto(run.Id, ReferenceId.Format(run.ReferenceId)));
    }

    // ---------------- grading ----------------

    /// <summary>A managed class (404 otherwise).</summary>
    private static async Task<CourseClass> EditableClassAsync(AppDbContext db, HttpContext ctx, Guid classId, CancellationToken ct)
    {
        var editable = Editable(db, ctx).Select(c => c.Id);
        return await db.Classes.AsNoTracking().FirstOrDefaultAsync(k => k.Id == classId && editable.Contains(k.CourseId), ct)
               ?? throw AppException.NotFound("Class not found.");
    }

    private static async Task<List<GradingQueueItemDto>> GradingQueueAsync(Guid? courseId, Guid? classId, HttpContext ctx, AppDbContext db, CancellationToken ct)
    {
        var editable = Editable(db, ctx).Select(c => c.Id);
        var q = from g in db.GradingResults.AsNoTracking()
                join a in db.SubmittedAnswers on g.SubmittedAnswerId equals a.Id
                join t in db.QuizAttempts on a.AttemptId equals t.Id
                join u in db.Users on t.UserId equals u.Id
                join qu in db.Questions on a.QuestionId equals qu.Id
                where g.Status == GradingStatuses.NeedsReview && editable.Contains(qu.CourseId)
                select new { g, a, t.UserId, u.DisplayName, qu.Stem, qu.CourseId, qu.Id };
        if (courseId is { } cid) q = q.Where(x => x.CourseId == cid);
        if (classId is { } kid)
        {
            var cls = await EditableClassAsync(db, ctx, kid, ct);
            var members = db.ClassMembers.Where(m => m.ClassId == kid && m.RemovedAt == null).Select(m => m.UserId);
            q = q.Where(x => x.CourseId == cls.CourseId && members.Contains(x.UserId));
        }
        var rows = await q.OrderBy(x => x.a.SubmittedAt).Take(200).ToListAsync(ct);
        var qids = rows.Select(r => r.Id).Distinct().ToList();
        var rubrics = (await db.Rubrics.AsNoTracking().Where(r => qids.Contains(r.QuestionId)).ToListAsync(ct))
            .GroupBy(r => r.QuestionId).ToDictionary(g => g.Key, g => g.OrderByDescending(r => r.Version).First());

        return rows.Select(r => new GradingQueueItemDto(r.g.Id, r.DisplayName, r.Stem, r.a.FreeText, r.g.Score, r.g.MaxScore, r.g.Confidence, r.g.Feedback,
            ToRubric(rubrics.GetValueOrDefault(r.Id)), r.a.SubmittedAt)).ToList();
    }

    private static async Task<NoContent> ReviewAsync(Guid gradingId, GradingReviewRequest req, HttpContext ctx, AppDbContext db, AnswerEffects effects,
        CancellationToken ct)
    {
        var g = await db.GradingResults.FirstOrDefaultAsync(x => x.Id == gradingId, ct) ?? throw AppException.NotFound("Grading not found.");
        var answer = await db.SubmittedAnswers.FirstAsync(a => a.Id == g.SubmittedAnswerId, ct);
        var question = await db.Questions.FirstAsync(q => q.Id == answer.QuestionId, ct);
        await EditableCourseAsync(db, ctx, question.CourseId, ct);
        if (g.Status == GradingStatuses.Reviewed) throw AppException.Conflict("This answer has already been reviewed.");

        var max = g.MaxScore;
        if (max <= 0)
        {
            var rubric = await db.Rubrics.AsNoTracking().Where(r => r.QuestionId == question.Id).OrderByDescending(r => r.Version).FirstOrDefaultAsync(ct);
            max = rubric is null ? 1 : Math.Max(1, (JsonSerializer.Deserialize<List<RubricCriterion>>(rubric.CriteriaJson, AiJson.Options) ?? []).Sum(c => c.Points));
            g.MaxScore = max;
        }
        if (req.FinalScore > max) throw AppException.Validation("finalScore", $"The score can be at most {max}.");

        var reviewer = ctx.User.GetUserId();
        g.Status = GradingStatuses.Reviewed;
        g.FinalScore = req.FinalScore;
        g.ReviewerFeedback = string.IsNullOrWhiteSpace(req.Feedback) ? null : req.Feedback.Trim();
        g.ReviewedBy = reviewer;
        g.ReviewedAt = DateTime.UtcNow;
        var attempt = await db.QuizAttempts.AsNoTracking().FirstAsync(a => a.Id == answer.AttemptId, ct);
        var fraction = req.FinalScore / max;
        await effects.ApplyAsync(answer, question, attempt.UserId, fraction >= AnswerEffects.CorrectFraction, fraction, MasterySources.Grading, ct);
        db.Audit(reviewer, AuditActions.GradingReview, "grading_result", g.Id, new { finalScore = req.FinalScore, maxScore = max, aiScore = g.Score });
        await db.SaveChangesAsync(ct);
        return TypedResults.NoContent();
    }

    // ---------------- insights ----------------

    private static async Task<InsightsDto> InsightsAsync(Guid? courseId, Guid? classId, HttpContext ctx, AppDbContext db, CancellationToken ct)
    {
        IQueryable<Guid> students;
        Guid cid;
        if (classId is { } kid)
        {
            var cls = await EditableClassAsync(db, ctx, kid, ct);
            if (courseId is { } given && given != cls.CourseId) throw AppException.NotFound("Class not found.");
            cid = cls.CourseId;
            students = db.ClassMembers.Where(m => m.ClassId == kid && m.RemovedAt == null).Select(m => m.UserId);
        }
        else
        {
            cid = courseId ?? throw AppException.Validation("courseId", "Choose a course or a class.");
            await EditableCourseAsync(db, ctx, cid, ct);
            students = CourseStudents(db, cid);
        }

        var since7 = DateTime.UtcNow.AddDays(-7);
        var since30 = DateTime.UtcNow.AddDays(-30);
        var enrolled = await students.CountAsync(ct);

        var courseConvos = db.Conversations.Where(c => c.CourseId == cid && students.Contains(c.UserId));
        var activeChat = await db.Messages.Where(m => m.Role == MessageRoles.User && m.CreatedAt >= since7)
            .Join(courseConvos, m => m.ConversationId, c => c.Id, (m, c) => c.UserId).Distinct().ToListAsync(ct);
        var activeQuiz = await db.QuizAttempts.Where(a => a.StartedAt >= since7 && students.Contains(a.UserId))
            .Join(db.Quizzes.Where(q => q.CourseId == cid), a => a.QuizId, q => q.Id, (a, q) => a.UserId).Distinct().ToListAsync(ct);
        var courseLessons = db.Lessons.Where(l => l.Module!.CourseId == cid).Select(l => l.Id);
        var activeLessons = await db.LessonProgress.Where(p => p.LastViewedAt >= since7 && courseLessons.Contains(p.LessonId) && students.Contains(p.UserId))
            .Select(p => p.UserId).Distinct().ToListAsync(ct);
        var active = activeChat.Concat(activeQuiz).Concat(activeLessons).Distinct().Count();

        var questions7 = await db.Messages.Where(m => m.Role == MessageRoles.User && m.CreatedAt >= since7)
            .Join(courseConvos, m => m.ConversationId, c => c.Id, (m, c) => m.Id).CountAsync(ct);

        var ratings = await db.MessageFeedback.Where(f => f.CreatedAt >= since30)
            .Join(db.Messages, f => f.MessageId, m => m.Id, (f, m) => new { f.Rating, m.ConversationId })
            .Join(courseConvos, x => x.ConversationId, c => c.Id, (x, c) => x.Rating).ToListAsync(ct);
        double? helpful = ratings.Count == 0 ? null : Math.Round(ratings.Count(r => r > 0) / (double)ratings.Count, 4);

        var concepts = await db.Concepts.AsNoTracking().Where(c => c.CourseId == cid).OrderBy(c => c.Id).ToListAsync(ct);
        var conceptIds = concepts.Select(c => c.Id).ToList();
        var mastery = await db.ConceptMastery.AsNoTracking().Where(m => conceptIds.Contains(m.ConceptId) && students.Contains(m.UserId))
            .Select(m => new { m.ConceptId, m.Mastery }).ToListAsync(ct);

        var pending = await (from g in db.GradingResults
                             join a in db.SubmittedAnswers on g.SubmittedAnswerId equals a.Id
                             join t in db.QuizAttempts on a.AttemptId equals t.Id
                             join q in db.Questions on a.QuestionId equals q.Id
                             where g.Status == GradingStatuses.NeedsReview && q.CourseId == cid && students.Contains(t.UserId)
                             select g.Id).CountAsync(ct);

        return new InsightsDto(enrolled, active, questions7, helpful,
            concepts.Select(c =>
            {
                var values = mastery.Where(m => m.ConceptId == c.Id).Select(m => m.Mastery).ToList();
                return new ConceptInsightDto(c.Id, c.Name, values.Count == 0 ? null : Math.Round(values.Average(), 4), values.Count(v => v < 0.5));
            }).ToList(),
            pending);
    }
}
