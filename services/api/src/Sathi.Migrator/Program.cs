using Microsoft.AspNetCore.DataProtection;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Npgsql;
using Sathi.Core;
using Sathi.Core.Data;
using Sathi.Core.Domain;
using Sathi.Core.Observability;
using Sathi.Core.Options;
using Sathi.Core.Seeding;
using Serilog;

// Sathi.Migrator — one-shot: applies EF Core migrations for schema `app`, seeds roles/users/content, exits 0.
var builder = Host.CreateApplicationBuilder(args);
var env = SathiEnvironment.From(builder.Configuration, "migrator", builder.Environment.EnvironmentName);
Log.Logger = SathiLogging.CreateBootstrapLogger(env);

try
{
    var services = builder.Services;
    var config = builder.Configuration;
    services.AddSathiSerilog(config, env);
    services.AddSathiData(config);
    services.AddDataProtection().SetApplicationName("Sathi").PersistKeysToDbContext<AppDbContext>();
    services.AddSathiIdentityCore();
    services.AddScoped<IdentitySeeder>();
    services.AddScoped<CourseContentSeeder>();
    services.AddScoped<DemoDataSeeder>();

    using var host = builder.Build();
    var logger = host.Services.GetRequiredService<ILoggerFactory>().CreateLogger("Sathi.Migrator");
    var migrationEvent = new EventId(6001, "db.migration");
    using var cts = new CancellationTokenSource(TimeSpan.FromMinutes(10));
    var ct = cts.Token;

    await using (var scope = host.Services.CreateAsyncScope())
    {
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        await WaitForDatabaseAsync(db, logger, ct);

        var pending = (await db.Database.GetPendingMigrationsAsync(ct)).ToList();
        logger.LogInformation(migrationEvent, "Applying {count} pending migrations: {migrations}", pending.Count, string.Join(", ", pending));
        var sw = System.Diagnostics.Stopwatch.StartNew();
        await db.Database.MigrateAsync(ct);
        logger.LogInformation(migrationEvent, "Migrations applied in {duration_ms} ms", sw.ElapsedMilliseconds);
    }

    await using (var scope = host.Services.CreateAsyncScope())
    {
        var sp = scope.ServiceProvider;
        var identity = sp.GetRequiredService<IdentitySeeder>();
        await identity.SeedRolesAsync();

        // Accept both the shared .env names and the ASP.NET-style keys (Seed__AdminEmail, …).
        var adminEmail = First(config["SEED_ADMIN_EMAIL"], config["Seed:AdminEmail"]);
        var adminPassword = First(config["SEED_ADMIN_PASSWORD"], config["Seed:AdminPassword"]);
        if (!string.IsNullOrWhiteSpace(adminEmail) && !string.IsNullOrWhiteSpace(adminPassword))
            await identity.EnsureUserAsync(adminEmail.Trim(), adminPassword, "Administrator", Roles.Admin, Roles.Instructor);
        else
            logger.LogInformation("SEED_ADMIN_EMAIL/SEED_ADMIN_PASSWORD not set; skipping admin seed");

        var contentPath = ResolveContentPath(config["Seed:ContentPath"]);
        if (contentPath is null)
            logger.LogWarning("Course content not found (Seed:ContentPath={path}); skipping content seed", config["Seed:ContentPath"]);
        else
            await sp.GetRequiredService<CourseContentSeeder>().SeedAsync(contentPath, ct);

        if (bool.TryParse(First(config["SEED_DEMO_USERS"], config["Seed:DemoUsers"]), out var demo) && demo)
        {
            var instructor = await identity.EnsureUserAsync(IdentitySeeder.DemoInstructorEmail, IdentitySeeder.DemoInstructorPassword, "Priya Instructor", Roles.Instructor);
            var student = await identity.EnsureUserAsync(IdentitySeeder.DemoStudentEmail, IdentitySeeder.DemoStudentPassword, "Asha", Roles.Student);
            var demoSeeder = sp.GetRequiredService<DemoDataSeeder>();
            await demoSeeder.SeedAsync(student, ct);
            await demoSeeder.SeedClassAsync(instructor, student, ct);
        }
    }

    logger.LogInformation(migrationEvent, "Migrator finished");
    return 0;
}
catch (Exception ex) when (ex is not HostAbortedException)
{
    Log.Fatal(ex, "Migrator failed");
    return 1;
}
finally
{
    await Log.CloseAndFlushAsync();
}

static string? First(params string?[] values) => values.FirstOrDefault(v => !string.IsNullOrWhiteSpace(v));

static async Task WaitForDatabaseAsync(AppDbContext db, Microsoft.Extensions.Logging.ILogger logger, CancellationToken ct)
{
    for (var attempt = 1; ; attempt++)
    {
        try
        {
            await db.Database.OpenConnectionAsync(ct);
            await db.Database.CloseConnectionAsync();
            return;
        }
        catch (Exception ex) when (ex is NpgsqlException or InvalidOperationException && attempt < 30)
        {
            logger.LogWarning("Database not reachable yet (attempt {attempt}); retrying in 2 s", attempt);
            await Task.Delay(TimeSpan.FromSeconds(2), ct);
        }
    }
}

// Absolute paths are used as-is; relative ones are tried from the working directory and then upwards from the app directory.
static string? ResolveContentPath(string? configured)
{
    var path = string.IsNullOrWhiteSpace(configured) ? "content/ai-engineering" : configured;
    if (Path.IsPathRooted(path)) return File.Exists(Path.Combine(path, "course.json")) ? path : null;
    foreach (var start in new[] { Directory.GetCurrentDirectory(), AppContext.BaseDirectory })
    {
        var dir = new DirectoryInfo(start);
        while (dir is not null)
        {
            var candidate = Path.GetFullPath(Path.Combine(dir.FullName, path));
            if (File.Exists(Path.Combine(candidate, "course.json"))) return candidate;
            dir = dir.Parent;
        }
    }
    return null;
}
