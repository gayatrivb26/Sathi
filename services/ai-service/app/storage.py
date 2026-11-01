"""S3-compatible object storage (MinIO locally, S3/Blob-compatible in production).

Least privilege (contracts §11.8): the AI service runs with its own scoped user and only ever performs
``GetObject`` on ``uploads/*`` and ``lessons/*``, ``GetObject``/``PutObject``/``DeleteObject`` on ``parsed/*``,
and ``ListBucket`` (``list_objects_v2`` with ``Prefix='parsed/'``) for prefix deletion and the readiness
check. It never creates buckets, lists all buckets or calls ``HeadBucket``.
"""

from __future__ import annotations

import asyncio
from typing import Protocol

from app.errors import AppError
from app.logging import get_logger

log = get_logger(__name__)

PARSED_PREFIX = "parsed/"


def require_writable(key: str) -> None:
    """The AI service may only write/delete under ``parsed/`` (its storage user has no other write rights)."""
    if not key.startswith(PARSED_PREFIX) or ".." in key:
        raise AppError("INTERNAL_ERROR", internal=f"refusing to write outside {PARSED_PREFIX}: {key!r}")


class ObjectStorage(Protocol):
    async def get_bytes(self, key: str, *, max_bytes: int | None = None) -> bytes: ...
    async def put_bytes(self, key: str, data: bytes, content_type: str) -> None: ...
    async def delete_prefix(self, prefix: str) -> int: ...
    async def ping(self) -> bool: ...


class StorageNotFound(AppError):
    def __init__(self, key: str) -> None:
        super().__init__("NOT_FOUND", "The file was not found in storage.", internal=f"missing object {key}")


class S3Storage:
    def __init__(self, endpoint: str, access_key: str, secret_key: str, bucket: str, region: str = "us-east-1") -> None:
        import boto3
        from botocore.config import Config

        self.bucket = bucket
        self._client = boto3.client(
            "s3",
            endpoint_url=endpoint,
            aws_access_key_id=access_key,
            aws_secret_access_key=secret_key,
            region_name=region,
            config=Config(
                s3={"addressing_style": "path"},
                retries={"max_attempts": 3, "mode": "standard"},
                connect_timeout=5,
                read_timeout=30,
                signature_version="s3v4",
            ),
        )

    def _get(self, key: str, max_bytes: int | None) -> bytes:
        from botocore.exceptions import ClientError

        try:
            obj = self._client.get_object(Bucket=self.bucket, Key=key)
        except ClientError as exc:
            if exc.response.get("Error", {}).get("Code") in ("NoSuchKey", "404", "NotFound"):
                raise StorageNotFound(key) from exc
            raise
        size = int(obj.get("ContentLength") or 0)
        if max_bytes is not None and size > max_bytes:
            raise AppError("INGEST_PARSE_FAILED", "The file is too large to process.", internal=f"size {size}")
        body: bytes = obj["Body"].read()
        return body

    async def get_bytes(self, key: str, *, max_bytes: int | None = None) -> bytes:
        try:
            return await asyncio.to_thread(self._get, key, max_bytes)
        except AppError:
            raise
        except Exception as exc:
            raise AppError("STORAGE_UNAVAILABLE", internal=f"{type(exc).__name__}") from exc

    async def put_bytes(self, key: str, data: bytes, content_type: str) -> None:
        require_writable(key)
        try:
            await asyncio.to_thread(
                self._client.put_object, Bucket=self.bucket, Key=key, Body=data, ContentType=content_type
            )
        except Exception as exc:
            raise AppError("STORAGE_UNAVAILABLE", internal=f"{type(exc).__name__}") from exc

    def _delete_prefix(self, prefix: str) -> int:
        require_writable(prefix)
        deleted = 0
        paginator = self._client.get_paginator("list_objects_v2")
        for page in paginator.paginate(Bucket=self.bucket, Prefix=prefix):
            keys = [{"Key": o["Key"]} for o in page.get("Contents", [])]
            if keys:
                self._client.delete_objects(Bucket=self.bucket, Delete={"Objects": keys})  # type: ignore[typeddict-item]
                deleted += len(keys)
        return deleted

    async def delete_prefix(self, prefix: str) -> int:
        return await asyncio.to_thread(self._delete_prefix, prefix)

    async def ping(self) -> bool:
        # A prefix-scoped list works with the AI service's scoped credentials (ListBucket); HeadBucket /
        # ListAllMyBuckets / bucket creation would need rights this service deliberately does not have.
        await asyncio.to_thread(self._client.list_objects_v2, Bucket=self.bucket, Prefix=PARSED_PREFIX, MaxKeys=1)
        return True


class MemoryStorage:
    """In-memory storage for tests and local experiments."""

    def __init__(self) -> None:
        self.objects: dict[str, tuple[bytes, str]] = {}

    async def get_bytes(self, key: str, *, max_bytes: int | None = None) -> bytes:
        if key not in self.objects:
            raise StorageNotFound(key)
        return self.objects[key][0]

    async def put_bytes(self, key: str, data: bytes, content_type: str) -> None:
        self.objects[key] = (data, content_type)

    async def delete_prefix(self, prefix: str) -> int:
        keys = [k for k in self.objects if k.startswith(prefix)]
        for k in keys:
            del self.objects[k]
        return len(keys)

    async def ping(self) -> bool:
        return True
