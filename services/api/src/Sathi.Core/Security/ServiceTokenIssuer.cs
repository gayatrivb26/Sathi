using System.Security.Cryptography;
using Microsoft.Extensions.Options;
using Microsoft.IdentityModel.JsonWebTokens;
using Microsoft.IdentityModel.Tokens;
using Sathi.Core.Options;

namespace Sathi.Core.Security;

/// <summary>Scopes understood by the AI service (contract §6).</summary>
public static class ServiceScopes
{
    public const string Tutor = "tutor";
    public const string Ingest = "ingest";
    public const string Quiz = "quiz";
    public const string Grade = "grade";
    public const string Mastery = "mastery";
    public const string Runs = "runs";
    public const string Eval = "eval";
    public const string Admin = "admin";
}

/// <summary>Who a service call is made for, and what it may retrieve.</summary>
public sealed record ServiceTokenRequest(
    Guid? UserId,
    IReadOnlyCollection<string> Scopes,
    IReadOnlyCollection<Guid>? CourseIds = null,
    Guid? ScopeUserId = null,
    string? RequestId = null);

/// <summary>
/// Issues short-lived RS256 service tokens for the AI service (contract §6 + §11.7): header alg=RS256 + kid;
/// claims iss, aud="ai-service", sub (user id or "system"), uh, scp, rscope {course_ids, user_id}, rid, iat, exp = iat + 300 s.
/// Only the private key lives here; the AI service holds the public keys (SERVICE_TOKEN_PUBLIC_KEYS, kid:base64(SPKI PEM)).
/// </summary>
public sealed class ServiceTokenIssuer : IDisposable
{
    private readonly ServiceTokenOptions _options;
    private readonly UserIdHasher _hasher;
    private readonly RSA _rsa;
    private readonly SigningCredentials _credentials;
    private readonly JsonWebTokenHandler _handler = new() { SetDefaultTimesOnTokenCreation = false };
    private readonly TimeProvider _time;

    public ServiceTokenIssuer(IOptions<ServiceTokenOptions> options, UserIdHasher hasher, TimeProvider? time = null)
    {
        _options = options.Value;
        _hasher = hasher;
        _time = time ?? TimeProvider.System;
        _rsa = RSA.Create();
        _rsa.ImportFromPem(_options.DecodePem());
        // No provider caching: the cache is keyed by kid, so a cached provider could outlive (and reuse) a disposed RSA instance.
        var key = new RsaSecurityKey(_rsa) { KeyId = _options.KeyId, CryptoProviderFactory = new CryptoProviderFactory { CacheSignatureProviders = false } };
        _credentials = new SigningCredentials(key, SecurityAlgorithms.RsaSha256);
    }

    public string KeyId => _options.KeyId;

    /// <summary>SPKI PEM of the signing key's public half (what the AI service is configured with).</summary>
    public string ExportPublicKeyPem() => _rsa.ExportSubjectPublicKeyInfoPem();

    public void Dispose() => _rsa.Dispose();

    public string Issue(ServiceTokenRequest request)
    {
        var now = _time.GetUtcNow().UtcDateTime;
        var sub = request.UserId?.ToString("D") ?? "system";
        var claims = new Dictionary<string, object>
        {
            ["sub"] = sub,
            ["scp"] = string.Join(' ', request.Scopes.Distinct()),
            ["rscope"] = new Dictionary<string, object?>
            {
                ["course_ids"] = (request.CourseIds ?? []).Select(c => c.ToString("D")).ToArray(),
                ["user_id"] = request.ScopeUserId?.ToString("D"),
            },
            ["rid"] = request.RequestId ?? "",
        };
        if (request.UserId is { } uid) claims["uh"] = _hasher.Hash(uid);

        var descriptor = new SecurityTokenDescriptor
        {
            Issuer = _options.Issuer,
            Audience = _options.Audience,
            IssuedAt = now,
            Expires = now.AddSeconds(_options.LifetimeSeconds),
            Claims = claims,
            SigningCredentials = _credentials,
        };
        return _handler.CreateToken(descriptor);
    }
}
