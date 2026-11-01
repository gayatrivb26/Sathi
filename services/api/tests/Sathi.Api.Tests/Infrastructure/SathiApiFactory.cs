using Hangfire;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Sathi.Core.Ai;
using Sathi.Core.Data;
using Sathi.Core.Domain;
using Sathi.Core.Email;
using Sathi.Core.Seeding;
using Sathi.Core.Storage;
using Serilog.Core;
using Testcontainers.PostgreSql;

namespace Sathi.Api.Tests.Infrastructure;

/// <summary>One pgvector container + one API host for all integration tests (xUnit collection fixture).</summary>
public sealed class IntegrationFixture : IAsyncLifetime
{
    private readonly PostgreSqlContainer _db = new PostgreSqlBuilder("pgvector/pgvector:0.8.0-pg17")
        .WithDatabase("sathi")
        .WithUsername("postgres")
        .WithPassword("postgres")
        .Build();

    public SathiApiFactory Factory { get; private set; } = null!;
    public Guid CourseId { get; private set; }

    public async Task InitializeAsync()
    {
        await _db.StartAsync();
        Factory = new SathiApiFactory(_db.GetConnectionString());

        await using var scope = Factory.Services.CreateAsyncScope();
        var sp = scope.ServiceProvider;
        var db = sp.GetRequiredService<AppDbContext>();
        await db.Database.MigrateAsync();
        await ActivatorUtilities.CreateInstance<IdentitySeeder>(sp).SeedRolesAsync();
        var content = Path.Combine(AppContext.BaseDirectory, "Fixtures", "content");
        await ActivatorUtilities.CreateInstance<CourseContentSeeder>(sp).SeedAsync(content, CancellationToken.None);
        CourseId = await db.Courses.Where(c => c.Slug == "test-course").Select(c => c.Id).SingleAsync();
    }

    public async Task DisposeAsync()
    {
        await Factory.DisposeAsync();
        await _db.DisposeAsync();
    }
}

[CollectionDefinition(Name)]
public sealed class IntegrationCollection : ICollectionFixture<IntegrationFixture>
{
    public const string Name = "integration";
}

/// <summary>A fresh RS256 key pair per test run (the dev key in appsettings.Development.json is never used by tests).</summary>
public static class TestKeys
{
    public const string KeyId = "test-k1";
    private static readonly System.Security.Cryptography.RSA Rsa = System.Security.Cryptography.RSA.Create(2048);
    public static readonly string PrivateKeyPemBase64 = Convert.ToBase64String(System.Text.Encoding.UTF8.GetBytes(Rsa.ExportPkcs8PrivateKeyPem()));
    public static readonly string PublicKeyPem = Rsa.ExportSubjectPublicKeyInfoPem();
}

public sealed class SathiApiFactory(string connectionString) : WebApplicationFactory<Program>
{
    public const string HashSalt = "test-salt";
    public static readonly TimeSpan SecurityStampInterval = TimeSpan.FromSeconds(2);
    public TimeSpan SecurityStampIntervalPlusMargin => SecurityStampInterval + TimeSpan.FromSeconds(1);

    public StubAiHandler Ai { get; } = new();
    public FakeEmailSender Email { get; } = new();
    public FakeObjectStorage Storage { get; } = new();
    public FakeBackgroundJobClient Jobs { get; } = new();
    public CapturingLogSink Logs { get; } = new();

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        builder.UseEnvironment("Testing");
        var settings = new Dictionary<string, string>
        {
            ["SATHI_ENV"] = "test",
            ["SATHI_VERSION"] = "test",
            ["ConnectionStrings:App"] = connectionString,
            ["ConnectionStrings:Hangfire"] = "Host=localhost;Port=1;Database=unused;Username=unused;Password=unused",
            ["Ai:BaseUrl"] = "http://ai-service.test",
            ["Ai:IngestBaseUrl"] = "http://ai-ingest.test",
            ["Ai:StreamTimeoutSeconds"] = "30",
            ["ServiceToken:PrivateKeyPem"] = TestKeys.PrivateKeyPemBase64,
            ["ServiceToken:KeyId"] = TestKeys.KeyId,
            ["Storage:Endpoint"] = "http://storage.test",
            ["Storage:AccessKey"] = "test",
            ["Storage:SecretKey"] = "test",
            ["Email:Host"] = "smtp.test",
            ["Email:Port"] = "1025",
            ["App:BaseUrl"] = "http://app.test",
            ["Logging:HashSalt"] = HashSalt,
            ["Quotas:MaxUploadBytes"] = "1048576",
            ["Quotas:MaxStorageBytesPerUser"] = "5242880",
            ["Quotas:ChatMessagesPerDay"] = "50",
            ["RateLimits:GlobalPerUserPerMinute"] = "100000",
            ["RateLimits:AuthPerIpPerMinute"] = "100000",
            ["RateLimits:ClientErrorsPerIpPerMinute"] = "100000",
            ["Tutor:PingSeconds"] = "1",
            ["Tutor:BrowserWriteTimeoutSeconds"] = "2",
            ["Serilog:DisableConsole"] = "true",
            ["Serilog:MinimumLevel"] = "Debug",
        };
        foreach (var (k, v) in settings) builder.UseSetting(k, v);

        builder.ConfigureTestServices(services =>
        {
            services.RemoveAll<IAppEmailSender>();
            services.AddSingleton<IAppEmailSender>(Email);
            services.RemoveAll<IObjectStorage>();
            services.AddSingleton<IObjectStorage>(Storage);
            services.RemoveAll<IBackgroundJobClient>();
            services.AddSingleton<IBackgroundJobClient>(Jobs);
            services.AddSingleton<ILogEventSink>(Logs);
            // Contract §11.2 uses 1 minute; tests shorten it so a role change reaches a live session quickly.
            services.Configure<SecurityStampValidatorOptions>(o => o.ValidationInterval = SecurityStampInterval);
            services.AddHttpClient(AiServiceClient.ClientName).ConfigurePrimaryHttpMessageHandler(() => Ai);
            services.AddHttpClient(AiServiceClient.IngestClientName).ConfigurePrimaryHttpMessageHandler(() => Ai);
        });
    }

    /// <summary>Creates a confirmed user directly (bypassing email) with the given roles.</summary>
    public async Task<(Guid Id, string Email, string Password)> CreateUserAsync(params string[] roles)
    {
        var email = $"user-{Guid.NewGuid():N}@example.com";
        const string password = "Correct-horse-42";
        await using var scope = Services.CreateAsyncScope();
        var users = scope.ServiceProvider.GetRequiredService<UserManager<AppUser>>();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var user = new AppUser { UserName = email, Email = email, EmailConfirmed = true, DisplayName = "Test " + email[5..13] };
        var result = await users.CreateAsync(user, password);
        if (!result.Succeeded) throw new InvalidOperationException(string.Join(",", result.Errors.Select(e => e.Code)));
        foreach (var r in roles.Length == 0 ? [Roles.Student] : roles) await users.AddToRoleAsync(user, r);
        db.UserPreferences.Add(new UserPreference { UserId = user.Id });
        await db.SaveChangesAsync();
        return (user.Id, email, password);
    }

    public async Task<T> WithDbAsync<T>(Func<AppDbContext, Task<T>> work)
    {
        await using var scope = Services.CreateAsyncScope();
        return await work(scope.ServiceProvider.GetRequiredService<AppDbContext>());
    }
}
