using System.IO.Compression;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Options;
using Microsoft.IdentityModel.JsonWebTokens;
using Microsoft.IdentityModel.Tokens;
using Sathi.Core.Ai;
using Sathi.Core.Documents;
using Sathi.Core.Errors;
using Sathi.Core.Learning;
using Sathi.Core.Options;
using Sathi.Core.Security;

namespace Sathi.Api.Tests.Unit;

public class UserIdHashTests
{
    [Fact]
    public void Matches_shared_test_vector()
    {
        // Same vector is asserted by the Python service.
        Assert.Equal("679ae057de8932a8", UserIdHash.Compute("test-salt", "00000000-0000-0000-0000-000000000001"));
        Assert.Equal("679ae057de8932a8", UserIdHash.Compute("test-salt", Guid.Parse("00000000-0000-0000-0000-000000000001")));
    }

    [Fact]
    public void Lower_cases_the_user_id_before_hashing() =>
        Assert.Equal(UserIdHash.Compute("s", "ABCDEF00-0000-0000-0000-000000000001"), UserIdHash.Compute("s", "abcdef00-0000-0000-0000-000000000001"));
}

public class ReferenceIdTests
{
    [Fact]
    public void Formats_first_eight_hex_upper_case_with_dash()
    {
        Assert.Equal("7F3A-91C2", ReferenceId.FromTraceId("7f3a91c2e4b5a6b7c8d9e0f1a2b3c4d5"));
        Assert.Equal("7F3A91C2", ReferenceId.ToStored("7f3a91c2e4b5a6b7c8d9e0f1a2b3c4d5"));
        Assert.Equal("7F3A-91C2", ReferenceId.Format("7F3A91C2"));
    }

    [Theory]
    [InlineData("7F3A-91C2", "7F3A91C2")]
    [InlineData("7f3a91c2", "7F3A91C2")]
    [InlineData(" 7f3a-91c2 ", "7F3A91C2")]
    [InlineData("7F3A-91C", null)]
    [InlineData("ZZZZ-ZZZZ", null)]
    public void Normalizes_user_input(string input, string? expected) => Assert.Equal(expected, ReferenceId.TryNormalize(input));
}

public class Sm2Tests
{
    [Fact]
    public void Correct_answers_grow_the_interval_1_3_then_ef()
    {
        var s = new Sm2State(2.5, 0, 0);
        s = Sm2.Next(s, 4);
        Assert.Equal((1, 1, 2.5), (s.Repetitions, s.IntervalDays, s.EaseFactor));
        s = Sm2.Next(s, 4);
        Assert.Equal((2, 3, 2.5), (s.Repetitions, s.IntervalDays, s.EaseFactor));
        s = Sm2.Next(s, 4);
        Assert.Equal((3, 8), (s.Repetitions, s.IntervalDays)); // round(3 · 2.5) = 7.5 → 8
        s = Sm2.Next(s, 5);
        Assert.Equal(4, s.Repetitions);
        Assert.Equal(20, s.IntervalDays); // round(8 · 2.5)
        Assert.Equal(2.6, s.EaseFactor, 4);
    }

    [Fact]
    public void A_lapse_resets_repetitions_and_lowers_ease()
    {
        var s = Sm2.Next(new Sm2State(2.5, 3, 8), 1);
        Assert.Equal(0, s.Repetitions);
        Assert.Equal(1, s.IntervalDays);
        Assert.Equal(1.96, s.EaseFactor, 4); // 2.5 + 0.1 − 4·(0.08 + 4·0.02)
    }

    [Fact]
    public void Ease_never_drops_below_1_3()
    {
        var s = new Sm2State(1.4, 0, 0);
        for (var i = 0; i < 5; i++) s = Sm2.Next(s, 0);
        Assert.Equal(1.3, s.EaseFactor, 4);
    }

    [Fact]
    public void Quality_mapping_and_time_estimate()
    {
        Assert.Equal(4, Sm2.QualityFor(true));
        Assert.Equal(1, Sm2.QualityFor(false));
        Assert.Equal(6, Sm2.EstimatedMinutes(5));
        Assert.Equal(0, Sm2.EstimatedMinutes(0));
    }

    [Fact]
    public void Apply_sets_due_date_from_interval()
    {
        var card = new Core.Domain.RevisionCard { EaseFactor = 2.5 };
        var now = new DateTime(2026, 1, 1, 12, 0, 0, DateTimeKind.Utc);
        Sm2.Apply(card, 4, now);
        Assert.Equal(now.AddDays(1), card.DueAt);
        Assert.Equal(4, card.LastQuality);
    }
}

public class ServiceTokenTests
{
    private static readonly System.Security.Cryptography.RSA Rsa = System.Security.Cryptography.RSA.Create(2048);
    private static readonly string PrivateKeyB64 = Convert.ToBase64String(Encoding.UTF8.GetBytes(Rsa.ExportPkcs8PrivateKeyPem()));

    private static ServiceTokenIssuer Issuer(string issuer, string salt = "test-salt") =>
        new(Microsoft.Extensions.Options.Options.Create(new ServiceTokenOptions { PrivateKeyPem = PrivateKeyB64, KeyId = "k-test", Issuer = issuer }),
            new UserIdHasher(salt));

    [Fact]
    public async Task Issues_rs256_token_with_kid_and_contract_claims_that_verifies_with_the_public_key()
    {
        using var issuer = Issuer("sathi-api");
        var user = Guid.Parse("00000000-0000-0000-0000-000000000001");
        var course = Guid.NewGuid();
        var token = issuer.Issue(new ServiceTokenRequest(user, ["tutor"], [course], user, "req-1"));

        // Round trip with only the public key (what the AI service holds), exported as SPKI PEM.
        using var verifier = System.Security.Cryptography.RSA.Create();
        verifier.ImportFromPem(issuer.ExportPublicKeyPem());
        var result = await new JsonWebTokenHandler().ValidateTokenAsync(token, new TokenValidationParameters
        {
            ValidIssuer = "sathi-api", ValidAudience = "ai-service", ValidAlgorithms = [SecurityAlgorithms.RsaSha256],
            IssuerSigningKey = new RsaSecurityKey(verifier) { KeyId = "k-test" },
        });
        Assert.True(result.IsValid, result.Exception?.Message);

        var jwt = new JsonWebToken(token);
        Assert.Equal("RS256", jwt.Alg);
        Assert.Equal("k-test", jwt.Kid);
        var header = JsonDocument.Parse(Base64UrlEncoder.Decode(token.Split('.')[0])).RootElement;
        Assert.Equal("k-test", header.GetProperty("kid").GetString());
        Assert.Equal(user.ToString(), jwt.Subject);
        Assert.Equal("679ae057de8932a8", jwt.GetClaim("uh").Value);
        Assert.Equal("tutor", jwt.GetClaim("scp").Value);
        Assert.Equal("req-1", jwt.GetClaim("rid").Value);
        Assert.Equal(300, (jwt.ValidTo - jwt.IssuedAt).TotalSeconds);

        var payload = JsonDocument.Parse(Base64UrlEncoder.Decode(token.Split('.')[1])).RootElement;
        var rscope = payload.GetProperty("rscope");
        Assert.Equal(JsonValueKind.Object, rscope.ValueKind);
        Assert.Equal(course.ToString(), rscope.GetProperty("course_ids")[0].GetString());
        Assert.Equal(user.ToString(), rscope.GetProperty("user_id").GetString());
        Assert.False(payload.TryGetProperty("nbf", out _));

        // A different key must not verify it (no HS256/shared-secret fallback).
        using var other = System.Security.Cryptography.RSA.Create(2048);
        var bad = await new JsonWebTokenHandler().ValidateTokenAsync(token, new TokenValidationParameters
        {
            ValidIssuer = "sathi-api", ValidAudience = "ai-service", IssuerSigningKey = new RsaSecurityKey(other) { KeyId = "k-test" },
        });
        Assert.False(bad.IsValid);
    }

    [Fact]
    public void System_tokens_use_sub_system_and_null_user_scope()
    {
        using var issuer = Issuer("sathi-jobs", "s");
        var jwt = new JsonWebToken(issuer.Issue(new ServiceTokenRequest(null, ["ingest", "admin"])));
        Assert.Equal("system", jwt.Subject);
        Assert.Equal("sathi-jobs", jwt.Issuer);
        Assert.Equal("ingest admin", jwt.GetClaim("scp").Value);
        var payload = JsonDocument.Parse(Base64UrlEncoder.Decode(jwt.EncodedPayload)).RootElement;
        Assert.Equal(JsonValueKind.Null, payload.GetProperty("rscope").GetProperty("user_id").ValueKind);
    }

    [Fact]
    public void Options_reject_missing_garbage_and_small_keys_and_accept_raw_pem()
    {
        static List<System.ComponentModel.DataAnnotations.ValidationResult> Validate(ServiceTokenOptions o) =>
            o.Validate(new System.ComponentModel.DataAnnotations.ValidationContext(o)).ToList();

        Assert.NotEmpty(Validate(new ServiceTokenOptions { PrivateKeyPem = "bm90IGEga2V5", KeyId = "k1" }));
        using var small = System.Security.Cryptography.RSA.Create(1024);
        Assert.NotEmpty(Validate(new ServiceTokenOptions
        {
            PrivateKeyPem = Convert.ToBase64String(Encoding.UTF8.GetBytes(small.ExportPkcs8PrivateKeyPem())), KeyId = "k1",
        }));
        Assert.Empty(Validate(new ServiceTokenOptions { PrivateKeyPem = PrivateKeyB64, KeyId = "k1" }));
        Assert.Empty(Validate(new ServiceTokenOptions { PrivateKeyPem = Rsa.ExportPkcs8PrivateKeyPem(), KeyId = "k1" }));
    }
}

public class SseReaderTests
{
    [Fact]
    public async Task Parses_events_comments_and_multiline_data()
    {
        const string wire = ": ping\n\nevent: status\ndata: {\"stage\":\"retrieving\"}\n\nevent: token\ndata: {\"text\":\"a\n" +
                            "data: b\"}\n\ndata: {\"x\":1}\n\n";
        var events = new List<SseEvent>();
        await foreach (var e in SseReader.ReadAsync(new MemoryStream(Encoding.UTF8.GetBytes(wire)), CancellationToken.None)) events.Add(e);
        Assert.Equal(3, events.Count);
        Assert.Equal("status", events[0].Event);
        Assert.Equal("{\"text\":\"a\nb\"}", events[1].Data);
        Assert.Equal("message", events[2].Event);
    }
}

public class UploadValidatorTests
{
    private const long Max = 1024 * 1024;

    private static byte[] Docx(bool withWordEntry)
    {
        using var ms = new MemoryStream();
        using (var zip = new ZipArchive(ms, ZipArchiveMode.Create, true))
        {
            var entry = zip.CreateEntry(withWordEntry ? "word/document.xml" : "other/file.xml");
            using var w = new StreamWriter(entry.Open());
            w.Write("<x/>");
        }
        return ms.ToArray();
    }

    [Fact]
    public void Accepts_valid_files()
    {
        Assert.Equal("application/pdf", UploadValidator.Validate("notes.pdf", Encoding.ASCII.GetBytes("%PDF-1.7 rest"), Max).ContentType);
        Assert.Equal("text/markdown", UploadValidator.Validate("notes.MD", Encoding.UTF8.GetBytes("# Hello ✓"), Max).ContentType);
        Assert.Equal("text/plain", UploadValidator.Validate("a.txt", Encoding.UTF8.GetBytes("plain"), Max).ContentType);
        Assert.StartsWith("application/vnd.openxmlformats", UploadValidator.Validate("a.docx", Docx(true), Max).ContentType);
    }

    [Theory]
    [InlineData("evil.exe")]
    [InlineData("noext")]
    [InlineData("image.png")]
    public void Rejects_disallowed_extensions(string name)
    {
        var ex = Assert.Throws<AppException>(() => UploadValidator.Validate(name, [1, 2, 3], Max));
        Assert.Equal((415, ErrorCodes.UploadInvalidType), (ex.Status, ex.Code));
    }

    [Fact]
    public void Rejects_content_that_does_not_match_extension()
    {
        Assert.Equal(415, Assert.Throws<AppException>(() => UploadValidator.Validate("fake.pdf", Encoding.ASCII.GetBytes("MZ\x90\x00"), Max)).Status);
        Assert.Equal(415, Assert.Throws<AppException>(() => UploadValidator.Validate("fake.docx", Docx(false), Max)).Status);
        Assert.Equal(415, Assert.Throws<AppException>(() => UploadValidator.Validate("bin.txt", [0x41, 0x00, 0x42], Max)).Status);
        Assert.Equal(415, Assert.Throws<AppException>(() => UploadValidator.Validate("bad.md", [0xC3, 0x28], Max)).Status);
    }

    [Fact]
    public void Rejects_oversized_files()
    {
        var ex = Assert.Throws<AppException>(() => UploadValidator.Validate("big.txt", new byte[Max + 1].Select(_ => (byte)'a').ToArray(), Max));
        Assert.Equal((413, ErrorCodes.UploadTooLarge), (ex.Status, ex.Code));
    }

    [Fact]
    public void Sanitizes_file_names() =>
        Assert.Equal("my_notes_v2_.pdf", UploadValidator.SanitizeFileName("../../my notes (v2).pdf"));
}

public class DeterministicGuidTests
{
    [Fact]
    public void Same_name_same_guid_and_version_5()
    {
        var a = DeterministicGuid.Create("lesson:course:intro");
        Assert.Equal(a, DeterministicGuid.Create("lesson:course:intro"));
        Assert.NotEqual(a, DeterministicGuid.Create("lesson:course:other"));
        Assert.Equal('5', a.ToString()[14]);
    }
}
