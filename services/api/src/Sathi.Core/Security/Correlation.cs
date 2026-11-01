using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;

namespace Sathi.Core.Security;

/// <summary>Reference IDs (contract §4): first 8 hex chars of the trace id, upper-case, "XXXX-XXXX".</summary>
public static class ReferenceId
{
    /// <summary>"7f3a91c2..." → "7F3A-91C2".</summary>
    public static string FromTraceId(string traceId)
    {
        var compact = ToStored(traceId);
        return compact.Length == 8 ? compact[..4] + "-" + compact[4..] : compact;
    }

    /// <summary>Stored form (no dash, upper-case): "7F3A91C2".</summary>
    public static string ToStored(string traceId)
    {
        if (string.IsNullOrEmpty(traceId)) return "";
        var hex = traceId.Replace("-", "");
        return (hex.Length >= 8 ? hex[..8] : hex).ToUpperInvariant();
    }

    /// <summary>"7F3A91C2" → "7F3A-91C2".</summary>
    public static string Format(string? stored) =>
        string.IsNullOrEmpty(stored) ? "" : stored.Length == 8 ? stored[..4] + "-" + stored[4..] : stored;

    /// <summary>
    /// Normalises user input: accepts "7F3A-91C2" or "7f3a91c2" and returns "7F3A91C2"; null if it is not 8 hex chars.
    /// </summary>
    public static string? TryNormalize(string input)
    {
        var s = input.Trim().Replace("-", "").ToUpperInvariant();
        return s.Length == 8 && s.All(Uri.IsHexDigit) ? s : null;
    }
}

/// <summary>Trace helpers.</summary>
public static class TraceIds
{
    /// <summary>Current W3C trace id (32 hex), or a fresh random id when no Activity is active.</summary>
    public static string Current() =>
        Activity.Current?.TraceId.ToHexString() ?? ActivityTraceId.CreateRandom().ToHexString();

    /// <summary>W3C traceparent of the current Activity (for job arguments), or null.</summary>
    public static string? CurrentTraceParent()
    {
        var a = Activity.Current;
        if (a is null || a.IdFormat != ActivityIdFormat.W3C) return null;
        return a.Id;
    }

    public static bool IsTraceId(string s) => s.Length == 32 && s.All(Uri.IsHexDigit);
}

/// <summary>
/// user_id_hash = HMAC-SHA256(key = UTF-8 LOG_HASH_SALT, msg = lower-case user id string), hex, first 16 chars.
/// Test vector: salt "test-salt", user "00000000-0000-0000-0000-000000000001" → "679ae057de8932a8".
/// </summary>
public static class UserIdHash
{
    public static string Compute(string salt, string userId)
    {
        var mac = HMACSHA256.HashData(Encoding.UTF8.GetBytes(salt), Encoding.UTF8.GetBytes(userId.ToLowerInvariant()));
        return Convert.ToHexStringLower(mac)[..16];
    }

    public static string Compute(string salt, Guid userId) => Compute(salt, userId.ToString("D"));
}

/// <summary>Injectable hasher bound to the configured salt.</summary>
public sealed class UserIdHasher(string salt)
{
    public string Hash(Guid userId) => UserIdHash.Compute(salt, userId);
    public string Hash(string userId) => UserIdHash.Compute(salt, userId);
}

/// <summary>Deterministic UUID v5 (RFC 4122) — used to give seeded content stable ids (upsert by slug).</summary>
public static class DeterministicGuid
{
    private static readonly Guid Namespace = new("6b1f3c2a-7c43-4f61-9b5e-2f0f5d6a9e11");

    public static Guid Create(string name)
    {
        var ns = Namespace.ToByteArray(bigEndian: true);
        var bytes = Encoding.UTF8.GetBytes(name);
        var hash = SHA1.HashData([.. ns, .. bytes]);
        var g = new byte[16];
        Array.Copy(hash, g, 16);
        g[6] = (byte)((g[6] & 0x0F) | 0x50);
        g[8] = (byte)((g[8] & 0x3F) | 0x80);
        return new Guid(g, bigEndian: true);
    }
}
