using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Mvc.Testing;

namespace Sathi.Api.Tests.Infrastructure;

/// <summary>A browser-like client: keeps cookies and sends X-XSRF-TOKEN from the XSRF-TOKEN cookie, like Angular does.</summary>
public sealed class TestClient : IDisposable
{
    public static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    public HttpClient Http { get; }

    private TestClient(HttpClient http) => Http = http;

    public static async Task<TestClient> CreateAsync(SathiApiFactory factory, bool withCsrf = true)
    {
        var http = factory.CreateClient(new WebApplicationFactoryClientOptions { AllowAutoRedirect = false, HandleCookies = true });
        var client = new TestClient(http);
        if (withCsrf) await client.RefreshCsrfAsync();
        return client;
    }

    public static async Task<TestClient> SignedInAsync(SathiApiFactory factory, string email, string password)
    {
        var client = await CreateAsync(factory);
        var resp = await client.PostAsync("/api/v1/auth/login", new { email, password, rememberMe = false });
        if (resp.StatusCode != HttpStatusCode.OK)
            throw new InvalidOperationException($"Login failed: {(int)resp.StatusCode} {await resp.Content.ReadAsStringAsync()}");
        return client;
    }

    public async Task RefreshCsrfAsync()
    {
        var resp = await Http.GetAsync("/api/v1/auth/csrf");
        resp.EnsureSuccessStatusCode();
        CaptureCsrf(resp);
    }

    private void CaptureCsrf(HttpResponseMessage resp)
    {
        if (!resp.Headers.TryGetValues("Set-Cookie", out var cookies)) return;
        foreach (var c in cookies)
        {
            if (!c.StartsWith("XSRF-TOKEN=", StringComparison.Ordinal)) continue;
            var value = Uri.UnescapeDataString(c["XSRF-TOKEN=".Length..].Split(';')[0]);
            Http.DefaultRequestHeaders.Remove("X-XSRF-TOKEN");
            Http.DefaultRequestHeaders.Add("X-XSRF-TOKEN", value);
        }
    }

    public async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, HttpCompletionOption option = HttpCompletionOption.ResponseContentRead,
        CancellationToken ct = default)
    {
        var resp = await Http.SendAsync(request, option, ct);
        CaptureCsrf(resp);
        return resp;
    }

    public Task<HttpResponseMessage> GetAsync(string url) => SendAsync(new HttpRequestMessage(HttpMethod.Get, url));

    public Task<HttpResponseMessage> PostAsync(string url, object? body = null, string? idempotencyKey = null)
    {
        var req = new HttpRequestMessage(HttpMethod.Post, url) { Content = body is null ? null : JsonContent.Create(body, options: Json) };
        if (idempotencyKey is not null) req.Headers.Add("Idempotency-Key", idempotencyKey);
        return SendAsync(req);
    }

    public Task<HttpResponseMessage> PutAsync(string url, object body) =>
        SendAsync(new HttpRequestMessage(HttpMethod.Put, url) { Content = JsonContent.Create(body, options: Json) });

    public Task<HttpResponseMessage> DeleteAsync(string url) => SendAsync(new HttpRequestMessage(HttpMethod.Delete, url));

    public static async Task<JsonElement> ReadJsonAsync(HttpResponseMessage resp)
    {
        var text = await resp.Content.ReadAsStringAsync();
        return JsonDocument.Parse(string.IsNullOrEmpty(text) ? "{}" : text).RootElement.Clone();
    }

    public void Dispose() => Http.Dispose();
}

public static class SseParsing
{
    public sealed record Frame(string Event, JsonElement Data);

    /// <summary>Reads SSE frames from a stream until it ends or <paramref name="stopWhen"/> returns true.</summary>
    public static async Task<List<Frame>> ReadAsync(Stream stream, Func<Frame, bool>? stopWhen = null, CancellationToken ct = default)
    {
        var frames = new List<Frame>();
        await foreach (var e in Core.Ai.SseReader.ReadAsync(stream, ct))
        {
            var frame = new Frame(e.Event, JsonDocument.Parse(string.IsNullOrEmpty(e.Data) ? "{}" : e.Data).RootElement.Clone());
            frames.Add(frame);
            if (stopWhen?.Invoke(frame) == true) break;
        }
        return frames;
    }
}
