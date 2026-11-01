using System.ComponentModel.DataAnnotations;

namespace Sathi.Core.Options;

/// <summary>Connection strings (contract §2): ConnectionStrings__App, ConnectionStrings__Hangfire.</summary>
public sealed class ConnectionStringOptions
{
    public const string Section = "ConnectionStrings";

    [Required(AllowEmptyStrings = false)]
    public string App { get; set; } = "";

    /// <summary>Required by the jobs host and by the API (Hangfire client). Not used by the migrator.</summary>
    public string? Hangfire { get; set; }
}

/// <summary>Ai__BaseUrl, Ai__IngestBaseUrl, Ai__TimeoutSeconds.</summary>
public sealed class AiOptions
{
    public const string Section = "Ai";

    [Required, Url]
    public string BaseUrl { get; set; } = "";

    [Required, Url]
    public string IngestBaseUrl { get; set; } = "";

    [Range(5, 900)]
    public int TimeoutSeconds { get; set; } = 120;

    /// <summary>Upstream read timeout for the live tutor stream (contract §5.3.1: 180 s).</summary>
    [Range(5, 900)]
    public int StreamTimeoutSeconds { get; set; } = 180;
}

/// <summary>
/// RS256 service tokens (contract §11.7): ServiceToken__PrivateKeyPem = base64 of a PKCS#8 PEM RSA private key (≥ 2048 bit),
/// ServiceToken__KeyId = the JWT "kid" header (e.g. "k1"). The AI service verifies with the matching public key.
/// </summary>
public sealed class ServiceTokenOptions : IValidatableObject
{
    public const string Section = "ServiceToken";

    /// <summary>Base64 of the PKCS#8 PEM ("-----BEGIN PRIVATE KEY-----…"). A raw PEM string is accepted too.</summary>
    [Required(AllowEmptyStrings = false)]
    public string PrivateKeyPem { get; set; } = "";

    [Required(AllowEmptyStrings = false), RegularExpression("^[A-Za-z0-9._-]{1,64}$", ErrorMessage = "ServiceToken:KeyId must be 1–64 characters of A-Z, a-z, 0-9, '.', '_' or '-'.")]
    public string KeyId { get; set; } = "";

    /// <summary>"sathi-api" or "sathi-jobs"; set by the host.</summary>
    public string Issuer { get; set; } = "sathi-api";

    public string Audience { get; set; } = "ai-service";

    [Range(30, 3600)]
    public int LifetimeSeconds { get; set; } = 300;

    /// <summary>The PEM text (decodes the base64 form; passes a raw PEM through).</summary>
    public string DecodePem()
    {
        var value = (PrivateKeyPem ?? "").Trim();
        if (value.StartsWith("-----BEGIN", StringComparison.Ordinal)) return value;
        return System.Text.Encoding.UTF8.GetString(Convert.FromBase64String(value));
    }

    public IEnumerable<ValidationResult> Validate(ValidationContext validationContext)
    {
        string? error = null;
        try
        {
            using var rsa = System.Security.Cryptography.RSA.Create();
            rsa.ImportFromPem(DecodePem());
            if (rsa.KeySize < 2048) error = "ServiceToken:PrivateKeyPem must be an RSA key of at least 2048 bits.";
        }
        catch (Exception ex) when (ex is FormatException or ArgumentException or System.Security.Cryptography.CryptographicException)
        {
            error = "ServiceToken:PrivateKeyPem must be the base64 of a PKCS#8 PEM RSA private key.";
        }
        if (error is not null) yield return new ValidationResult(error, [nameof(PrivateKeyPem)]);
    }
}

/// <summary>Privacy__MinimumAge, Privacy__AgeOfMajority, Privacy__ConsentPolicyVersion (contract §11.4).</summary>
public sealed class PrivacyOptions : IValidatableObject
{
    public const string Section = "Privacy";

    [Range(1, 30)] public int MinimumAge { get; set; } = 8;
    [Range(1, 30)] public int AgeOfMajority { get; set; } = 18;

    [Required(AllowEmptyStrings = false)]
    public string ConsentPolicyVersion { get; set; } = "2026-10";

    public IEnumerable<ValidationResult> Validate(ValidationContext validationContext)
    {
        if (MinimumAge > AgeOfMajority)
            yield return new ValidationResult("Privacy:MinimumAge must not exceed Privacy:AgeOfMajority.", [nameof(MinimumAge)]);
    }
}

/// <summary>Storage__Endpoint, Storage__AccessKey, Storage__SecretKey, Storage__Bucket, Storage__UseSsl.</summary>
public sealed class StorageOptions
{
    public const string Section = "Storage";

    [Required, Url]
    public string Endpoint { get; set; } = "";

    [Required(AllowEmptyStrings = false)]
    public string AccessKey { get; set; } = "";

    [Required(AllowEmptyStrings = false)]
    public string SecretKey { get; set; } = "";

    [Required(AllowEmptyStrings = false)]
    public string Bucket { get; set; } = "sathi-documents";

    public bool UseSsl { get; set; }

    public string Region { get; set; } = "us-east-1";
}

/// <summary>Email__Host, Email__Port, Email__From, Email__User, Email__Password.</summary>
public sealed class EmailOptions
{
    public const string Section = "Email";

    [Required(AllowEmptyStrings = false)]
    public string Host { get; set; } = "";

    [Range(1, 65535)]
    public int Port { get; set; } = 1025;

    [Required(AllowEmptyStrings = false)]
    public string From { get; set; } = "Sathi <no-reply@sathi.local>";

    public string? User { get; set; }

    public string? Password { get; set; }
}

/// <summary>App__BaseUrl (public URL used in email links).</summary>
public sealed class AppUrlOptions
{
    public const string Section = "App";

    [Required, Url]
    public string BaseUrl { get; set; } = "";
}

/// <summary>Logging__HashSalt (LOG_HASH_SALT). Lives in the "Logging" section next to Microsoft logging config.</summary>
public sealed class LogHashOptions
{
    public const string Section = "Logging";

    [Required(AllowEmptyStrings = false)]
    public string HashSalt { get; set; } = "";
}

/// <summary>Quotas__* (contract §2 / §5).</summary>
public sealed class QuotaOptions
{
    public const string Section = "Quotas";

    [Range(1, 100000)] public int ChatMessagesPerDay { get; set; } = 200;
    [Range(0, 100000)] public int WebSearchesPerDay { get; set; } = 20;
    [Range(0, 100000)] public int UploadsPerDay { get; set; } = 20;
    [Range(1, long.MaxValue)] public long MaxUploadBytes { get; set; } = 26_214_400;
    [Range(1, long.MaxValue)] public long MaxStorageBytesPerUser { get; set; } = 209_715_200;
}

/// <summary>Grading__AutoAcceptConfidence.</summary>
public sealed class GradingOptions
{
    public const string Section = "Grading";

    [Range(0.0, 1.0)]
    public double AutoAcceptConfidence { get; set; } = 0.75;
}

/// <summary>Observability__SlowQueryMs, Observability__GrafanaUrl.</summary>
public sealed class ObservabilityOptions
{
    public const string Section = "Observability";

    [Range(1, 600000)]
    public int SlowQueryMs { get; set; } = 500;

    [Required, Url]
    public string GrafanaUrl { get; set; } = "http://localhost:3000";

    /// <summary>Grafana datasource UIDs used to build Explore links (provisioned by infrastructure).</summary>
    public string LokiDatasourceUid { get; set; } = "loki";
    public string TempoDatasourceUid { get; set; } = "tempo";
}

/// <summary>Rate limits (contract §5). Not in the env contract; defaults match it, tests raise them.</summary>
public sealed class RateLimitOptions
{
    public const string Section = "RateLimits";

    [Range(1, 1_000_000)] public int GlobalPerUserPerMinute { get; set; } = 120;
    [Range(1, 1_000_000)] public int AuthPerIpPerMinute { get; set; } = 10;
    [Range(1, 1_000_000)] public int ClientErrorsPerIpPerMinute { get; set; } = 30;
}

/// <summary>Tutor relay tuning.</summary>
public sealed class TutorOptions
{
    public const string Section = "Tutor";

    [Range(1, 300)] public int PingSeconds { get; set; } = 15;
    [Range(1, 50)] public int HistoryMessages { get; set; } = 8;
    [Range(1, 60)] public int BrowserWriteTimeoutSeconds { get; set; } = 10;

    /// <summary>An assistant message still "streaming" this long after creation is marked failed/STREAM_INTERRUPTED (contract §11.5).</summary>
    [Range(1, 1440)] public int StaleStreamMinutes { get; set; } = 3;
}
