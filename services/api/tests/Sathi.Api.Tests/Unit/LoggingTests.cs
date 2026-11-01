using System.Globalization;
using System.Text.Json;
using Sathi.Api.Tests.Infrastructure;
using Sathi.Core.Observability;
using Serilog;
using Serilog.Context;
using Serilog.Core;
using Serilog.Events;

namespace Sathi.Api.Tests.Unit;

public class LoggingTests
{
    private static (Logger Logger, CapturingLogSink Sink) Create()
    {
        var sink = new CapturingLogSink();
        var logger = new LoggerConfiguration()
            .MinimumLevel.Debug()
            .Destructure.With(new RedactingDestructuringPolicy())
            .Enrich.WithProperty("service", "api")
            .Enrich.WithProperty("env", "test")
            .Enrich.WithProperty("version", "1.2.3")
            .Enrich.FromLogContext()
            .Enrich.With(new RedactionEnricher())
            .WriteTo.Sink(sink)
            .CreateLogger();
        return (logger, sink);
    }

    [Fact]
    public void Writes_contract_field_names()
    {
        var (logger, sink) = Create();
        using (LogContext.PushProperty("request_id", "req-123"))
        using (LogContext.PushProperty("user_id_hash", "679ae057de8932a8"))
            logger.Information("Hello {Name} took {duration_ms} ms", "world", 12);
        var line = JsonDocument.Parse(sink.Lines.Single()).RootElement;

        Assert.Equal("info", line.GetProperty("level").GetString());
        Assert.Equal("Hello world took 12 ms", line.GetProperty("message").GetString());
        Assert.Equal("api", line.GetProperty("service").GetString());
        Assert.Equal("test", line.GetProperty("env").GetString());
        Assert.Equal("1.2.3", line.GetProperty("version").GetString());
        Assert.Equal("req-123", line.GetProperty("request_id").GetString());
        Assert.Equal("679ae057de8932a8", line.GetProperty("user_id_hash").GetString());
        Assert.Equal(12, line.GetProperty("duration_ms").GetInt32());
        Assert.Equal("world", line.GetProperty("name").GetString());
        Assert.True(DateTime.TryParse(line.GetProperty("timestamp").GetString(), CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out _));
    }

    [Fact]
    public void Errors_carry_exception_fields()
    {
        var (logger, sink) = Create();
        logger.Error(new InvalidOperationException("boom"), "Failed");
        var line = JsonDocument.Parse(sink.Lines.Single()).RootElement;
        Assert.Equal("error", line.GetProperty("level").GetString());
        Assert.Equal("System.InvalidOperationException", line.GetProperty("exception_type").GetString());
        Assert.Equal("boom", line.GetProperty("exception_message").GetString());
        Assert.Contains("InvalidOperationException", line.GetProperty("stack").GetString());
    }

    [Fact]
    public void Seeded_secrets_never_appear_in_output()
    {
        const string password = "Hunter2-Super-Secret!";
        const string email = "leaky.learner@example.org";
        const string apiKey = "sk-ant-api03-ABCDEFGHIJKLMNOP";
        const string bearer = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl";

        var (logger, sink) = Create();
        logger.Information("Register request {@Body}", new { Email = email, Password = password, DisplayName = "Asha" });
        logger.Information("Header was {Authorization}", "Bearer " + bearer);
        logger.Information("Config {ApiKey} and {api_key} and {token}", apiKey, apiKey, bearer);
        logger.Information("User wrote {text}", $"my email is {email} and key {apiKey}, Bearer {bearer}");
        logger.Warning("Literal message with " + email);
        using (LogContext.PushProperty("cookie", "sathi.auth=abc123secretcookie"))
            logger.Information("With cookie in context");
        logger.Error(new Exception($"failed for {email} with Bearer {bearer}"), "Exception path");
        logger.Information("Dictionary {@Data}", new Dictionary<string, object> { ["password"] = password, ["safe"] = "ok" });

        var all = sink.All;
        Assert.DoesNotContain(password, all);
        Assert.DoesNotContain(email, all);
        Assert.DoesNotContain(apiKey, all);
        Assert.DoesNotContain(bearer, all);
        Assert.DoesNotContain("abc123secretcookie", all);
        Assert.Contains("Asha", all);
        Assert.Contains("\"safe\":\"ok\"", all);
        Assert.Contains(Redactor.Mask, all);
    }

    [Theory]
    [InlineData(LogEventLevel.Debug, "debug")]
    [InlineData(LogEventLevel.Verbose, "debug")]
    [InlineData(LogEventLevel.Information, "info")]
    [InlineData(LogEventLevel.Warning, "warning")]
    [InlineData(LogEventLevel.Error, "error")]
    [InlineData(LogEventLevel.Fatal, "error")]
    public void Maps_levels(LogEventLevel level, string expected) => Assert.Equal(expected, SathiJsonFormatter.Level(level));

    [Fact]
    public void Level_switch_parses_names()
    {
        Assert.True(LogLevelControl.TryParseLevel("debug", out var d));
        Assert.Equal(LogEventLevel.Debug, d);
        Assert.True(LogLevelControl.TryParseLevel("Information", out var i));
        Assert.Equal(LogEventLevel.Information, i);
        Assert.False(LogLevelControl.TryParseLevel("loud", out _));
    }
}
