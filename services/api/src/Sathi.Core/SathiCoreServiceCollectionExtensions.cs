using Hangfire;
using Hangfire.PostgreSql;
using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;
using Sathi.Core.Ai;
using Sathi.Core.Data;
using Sathi.Core.Documents;
using Sathi.Core.Domain;
using Sathi.Core.Email;
using Sathi.Core.Jobs;
using Sathi.Core.Learning;
using Sathi.Core.Observability;
using Sathi.Core.Options;
using Sathi.Core.Security;
using Sathi.Core.Storage;
using Sathi.Core.Usage;

namespace Sathi.Core;

public static class SathiCoreServiceCollectionExtensions
{
    public static OptionsBuilder<T> AddValidatedOptions<T>(this IServiceCollection services, IConfiguration configuration, string section)
        where T : class =>
        services.AddOptions<T>().Bind(configuration.GetSection(section)).ValidateDataAnnotations().ValidateOnStart();

    public static DbContextOptionsBuilder UseSathiNpgsql(this DbContextOptionsBuilder o, string connectionString) =>
        o.UseNpgsql(connectionString, n => n
                .MigrationsHistoryTable("__ef_migrations_history", AppDbContext.Schema)
                .MigrationsAssembly(typeof(AppDbContext).Assembly.FullName))
            .UseSnakeCaseNamingConvention()
            .ConfigureWarnings(w => w.Ignore(RelationalEventId.MultipleCollectionIncludeWarning));

    /// <summary>AppDbContext (schema app, snake_case) + slow-query interceptor.</summary>
    public static IServiceCollection AddSathiData(this IServiceCollection services, IConfiguration configuration)
    {
        services.AddValidatedOptions<ConnectionStringOptions>(configuration, ConnectionStringOptions.Section);
        services.AddValidatedOptions<ObservabilityOptions>(configuration, ObservabilityOptions.Section);
        services.AddSingleton<SlowQueryInterceptor>();
        services.AddDbContext<AppDbContext>((sp, o) => o
            .UseSathiNpgsql(sp.GetRequiredService<IOptions<ConnectionStringOptions>>().Value.App)
            .AddInterceptors(sp.GetRequiredService<SlowQueryInterceptor>()));
        return services;
    }

    /// <summary>Identity core (users, roles, EF stores, token providers) with the contract password/lockout policy.</summary>
    public static IdentityBuilder AddSathiIdentityCore(this IServiceCollection services)
    {
        return services.AddIdentityCore<AppUser>(o =>
            {
                o.Password.RequiredLength = 10;
                o.Password.RequireDigit = true;
                o.Password.RequireLowercase = false;
                o.Password.RequireUppercase = false;
                o.Password.RequireNonAlphanumeric = false;
                o.Password.RequiredUniqueChars = 1;
                o.Lockout.MaxFailedAccessAttempts = 5;
                o.Lockout.DefaultLockoutTimeSpan = TimeSpan.FromMinutes(15);
                o.Lockout.AllowedForNewUsers = true;
                o.User.RequireUniqueEmail = true;
                o.SignIn.RequireConfirmedEmail = true;
            })
            .AddRoles<AppRole>()
            .AddEntityFrameworkStores<AppDbContext>()
            .AddDefaultTokenProviders()
            .AddPasswordValidator<LetterRequiredPasswordValidator>();
    }

    /// <summary>Shared services used by api and jobs: options, AI client, storage, email, hashing, learning, usage, jobs.</summary>
    public static IServiceCollection AddSathiServices(this IServiceCollection services, IConfiguration configuration, string tokenIssuer)
    {
        services.AddValidatedOptions<AiOptions>(configuration, AiOptions.Section);
        services.AddValidatedOptions<ServiceTokenOptions>(configuration, ServiceTokenOptions.Section)
            .PostConfigure(o =>
            {
                o.Issuer = tokenIssuer;
                // Accept the shared .env names too (contract §11.7).
                if (string.IsNullOrWhiteSpace(o.PrivateKeyPem)) o.PrivateKeyPem = configuration["SERVICE_TOKEN_PRIVATE_KEY_PEM_B64"] ?? "";
                // Every token carries kid (the AI service rejects unknown kids when several keys are configured); default "k1".
                if (string.IsNullOrWhiteSpace(o.KeyId)) o.KeyId = configuration["SERVICE_TOKEN_KEY_ID"] is { Length: > 0 } kid ? kid : "k1";
            });
        services.AddValidatedOptions<PrivacyOptions>(configuration, PrivacyOptions.Section);
        services.AddValidatedOptions<TutorOptions>(configuration, TutorOptions.Section);
        services.AddValidatedOptions<StorageOptions>(configuration, StorageOptions.Section);
        services.AddValidatedOptions<EmailOptions>(configuration, EmailOptions.Section);
        services.AddValidatedOptions<AppUrlOptions>(configuration, AppUrlOptions.Section)
            .PostConfigure(o => { if (string.IsNullOrWhiteSpace(o.BaseUrl)) o.BaseUrl = configuration["APP_BASE_URL"] ?? ""; });
        services.AddLogHashing(configuration);
        services.AddValidatedOptions<QuotaOptions>(configuration, QuotaOptions.Section);
        services.AddValidatedOptions<GradingOptions>(configuration, GradingOptions.Section);

        services.AddSingleton(TimeProvider.System);
        services.AddSingleton<ServiceTokenIssuer>();
        services.AddHttpClient(AiServiceClient.ClientName, (sp, c) =>
        {
            c.BaseAddress = new Uri(sp.GetRequiredService<IOptions<AiOptions>>().Value.BaseUrl.TrimEnd('/') + "/");
            c.Timeout = Timeout.InfiniteTimeSpan;
        });
        services.AddHttpClient(AiServiceClient.IngestClientName, (sp, c) =>
        {
            c.BaseAddress = new Uri(sp.GetRequiredService<IOptions<AiOptions>>().Value.IngestBaseUrl.TrimEnd('/') + "/");
            c.Timeout = Timeout.InfiniteTimeSpan;
        });
        services.AddScoped<AiServiceClient>();
        services.AddSingleton<IObjectStorage, S3ObjectStorage>();
        services.AddSingleton<IAppEmailSender, SmtpEmailSender>();

        services.AddScoped<UsageService>();
        services.AddScoped<MasteryService>();
        services.AddScoped<RecommendationService>();
        services.AddScoped<AnswerEffects>();
        services.AddScoped<DocumentService>();
        services.AddScoped<JobScheduler>();
        return services;
    }

    /// <summary>Logging__HashSalt (falls back to LOG_HASH_SALT) + the UserIdHasher.</summary>
    public static IServiceCollection AddLogHashing(this IServiceCollection services, IConfiguration configuration)
    {
        services.AddValidatedOptions<LogHashOptions>(configuration, LogHashOptions.Section)
            .PostConfigure(o => { if (string.IsNullOrWhiteSpace(o.HashSalt)) o.HashSalt = configuration["LOG_HASH_SALT"] ?? ""; });
        services.AddSingleton(sp => new UserIdHasher(sp.GetRequiredService<IOptions<LogHashOptions>>().Value.HashSalt));
        return services;
    }

    /// <summary>Hangfire PostgreSQL storage in schema "hangfire" (contract §3.3).</summary>
    public static IGlobalConfiguration UseSathiHangfireStorage(this IGlobalConfiguration cfg, string connectionString, bool prepareSchema) =>
        cfg.SetDataCompatibilityLevel(CompatibilityLevel.Version_180)
            .UseSimpleAssemblyNameTypeSerializer()
            .UseRecommendedSerializerSettings()
            .UsePostgreSqlStorage(o => o.UseNpgsqlConnection(connectionString), new PostgreSqlStorageOptions
            {
                SchemaName = "hangfire",
                PrepareSchemaIfNecessary = prepareSchema,
                QueuePollInterval = TimeSpan.FromSeconds(2),
                InvisibilityTimeout = TimeSpan.FromMinutes(30),
            });
}

/// <summary>Password policy: at least one letter (digit + length are enforced by Identity options).</summary>
public sealed class LetterRequiredPasswordValidator : IPasswordValidator<AppUser>
{
    public Task<IdentityResult> ValidateAsync(UserManager<AppUser> manager, AppUser user, string? password) =>
        Task.FromResult(password is not null && password.Any(char.IsLetter)
            ? IdentityResult.Success
            : IdentityResult.Failed(new IdentityError { Code = "PasswordRequiresLetter", Description = "Passwords must contain at least one letter." }));
}
