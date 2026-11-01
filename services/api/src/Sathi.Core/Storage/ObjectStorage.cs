using Amazon.Runtime;
using Amazon.S3;
using Amazon.S3.Model;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using Sathi.Core.Options;

namespace Sathi.Core.Storage;

/// <summary>S3-compatible object storage (MinIO locally, S3/compatible in production).</summary>
public interface IObjectStorage
{
    Task PutAsync(string key, Stream content, string contentType, CancellationToken ct);
    Task DeleteAsync(string key, CancellationToken ct);
    Task DeletePrefixAsync(string prefix, CancellationToken ct);
    Task<bool> IsHealthyAsync(CancellationToken ct);
}

public sealed class S3ObjectStorage : IObjectStorage, IDisposable
{
    private readonly AmazonS3Client _client;
    private readonly StorageOptions _options;

    public S3ObjectStorage(IOptions<StorageOptions> options, ILogger<S3ObjectStorage> logger)
    {
        _options = options.Value;
        var endpoint = _options.Endpoint;
        if (!endpoint.StartsWith("http", StringComparison.OrdinalIgnoreCase))
            endpoint = (_options.UseSsl ? "https://" : "http://") + endpoint;
        var config = new AmazonS3Config
        {
            ServiceURL = endpoint,
            ForcePathStyle = true,
            AuthenticationRegion = _options.Region,
            UseHttp = !_options.UseSsl,
            RequestChecksumCalculation = RequestChecksumCalculation.WHEN_REQUIRED,
            ResponseChecksumValidation = ResponseChecksumValidation.WHEN_REQUIRED,
            Timeout = TimeSpan.FromSeconds(60),
            MaxErrorRetry = 2,
        };
        _client = new AmazonS3Client(new BasicAWSCredentials(_options.AccessKey, _options.SecretKey), config);
    }

    public async Task PutAsync(string key, Stream content, string contentType, CancellationToken ct)
    {
        // No bucket creation here (contract 11.8): apps use a scoped MinIO user without CreateBucket; minio-init creates the bucket.
        await _client.PutObjectAsync(new PutObjectRequest
        {
            BucketName = _options.Bucket,
            Key = key,
            InputStream = content,
            ContentType = contentType,
            AutoCloseStream = false,
            UseChunkEncoding = false,
        }, ct);
    }

    public async Task DeleteAsync(string key, CancellationToken ct)
    {
        await _client.DeleteObjectAsync(_options.Bucket, key, ct);
    }

    public async Task DeletePrefixAsync(string prefix, CancellationToken ct)
    {
        string? token = null;
        do
        {
            ListObjectsV2Response page;
            try
            {
                page = await _client.ListObjectsV2Async(new ListObjectsV2Request
                {
                    BucketName = _options.Bucket, Prefix = prefix, ContinuationToken = token,
                }, ct);
            }
            catch (AmazonS3Exception ex) when (ex.ErrorCode == "NoSuchBucket")
            {
                return;
            }
            var objects = page.S3Objects ?? [];
            if (objects.Count > 0)
            {
                await _client.DeleteObjectsAsync(new DeleteObjectsRequest
                {
                    BucketName = _options.Bucket,
                    Objects = objects.Select(o => new KeyVersion { Key = o.Key }).ToList(),
                }, ct);
            }
            token = page.IsTruncated == true ? page.NextContinuationToken : null;
        } while (token is not null);
    }

    public async Task<bool> IsHealthyAsync(CancellationToken ct)
    {
        try
        {
            // ListBucket on a prefix the scoped app user may read (never HeadBucket/PutBucket).
            await _client.ListObjectsV2Async(new ListObjectsV2Request { BucketName = _options.Bucket, Prefix = "uploads/", MaxKeys = 1 }, ct);
            return true;
        }
        catch (Exception ex) when (ex is AmazonServiceException or HttpRequestException)
        {
            return false;
        }
    }

    public void Dispose() => _client.Dispose();
}
