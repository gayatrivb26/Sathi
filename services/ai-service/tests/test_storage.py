"""Least-privilege storage access (contracts §11.8) and the readiness check."""

from __future__ import annotations

import httpx
import pytest
from botocore.stub import Stubber

from app.errors import AppError
from app.storage import MemoryStorage, S3Storage
from tests.conftest import _client, build_container, make_settings


def _s3() -> tuple[S3Storage, Stubber]:
    storage = S3Storage("http://minio.invalid:9000", "ai-user", "ai-secret", "sathi-documents")
    return storage, Stubber(storage._client)


async def test_ping_uses_a_prefix_scoped_list_not_head_bucket() -> None:
    storage, stub = _s3()
    stub.add_response(
        "list_objects_v2",
        {"KeyCount": 0, "IsTruncated": False},
        {"Bucket": "sathi-documents", "Prefix": "parsed/", "MaxKeys": 1},
    )
    with stub:  # any other call (HeadBucket, ListBuckets, CreateBucket) would fail the stubber
        assert await storage.ping() is True
    stub.assert_no_pending_responses()


@pytest.mark.parametrize("key", ["uploads/u/d/v1/x.pdf", "lessons/l/v1.md", "parsed/../uploads/x", "other/x"])
async def test_writes_outside_parsed_are_refused(key: str) -> None:
    storage, stub = _s3()
    with stub, pytest.raises(AppError):
        await storage.put_bytes(key, b"x", "text/plain")
    with stub, pytest.raises(AppError):
        await storage.delete_prefix(key)


async def test_parsed_writes_and_prefix_delete_use_object_level_calls() -> None:
    storage, stub = _s3()
    stub.add_response(
        "put_object",
        {},
        {"Bucket": "sathi-documents", "Key": "parsed/d/v1.json", "Body": b"{}", "ContentType": "application/json"},
    )
    stub.add_response(
        "list_objects_v2",
        {"Contents": [{"Key": "parsed/d/v1.json"}], "KeyCount": 1, "IsTruncated": False},
        {"Bucket": "sathi-documents", "Prefix": "parsed/d/"},
    )
    stub.add_response(
        "delete_objects",
        {"Deleted": [{"Key": "parsed/d/v1.json"}]},
        {"Bucket": "sathi-documents", "Delete": {"Objects": [{"Key": "parsed/d/v1.json"}]}},
    )
    with stub:
        await storage.put_bytes("parsed/d/v1.json", b"{}", "application/json")
        assert await storage.delete_prefix("parsed/d/") == 1
    stub.assert_no_pending_responses()


class _DownStorage(MemoryStorage):
    async def ping(self) -> bool:
        raise ConnectionError("minio down")


@pytest.mark.parametrize(("role", "status"), [("all", 503), ("ingest", 503)])
async def test_readiness_without_database_is_503(role: str, status: int) -> None:
    container = build_container(make_settings(ai_instance_role=role), None)
    async for client in _client(container):
        r = await client.get("/health/ready")
        assert r.status_code == status
        assert r.json()["checks"]["database"] == "failed"
        assert r.json()["checks"]["storage"] == "ok"


async def test_storage_failure_only_fails_readiness_of_the_ingest_instance(monkeypatch: pytest.MonkeyPatch) -> None:
    for role, expected in (("all", 200), ("ingest", 503)):
        container = build_container(make_settings(ai_instance_role=role), None, storage=_DownStorage())

        async def db_ok() -> bool:
            return True

        monkeypatch.setattr(container, "db", type("Db", (), {"ping": staticmethod(db_ok)})())
        async for client in _client(container):
            r: httpx.Response = await client.get("/health/ready")
            assert r.status_code == expected, role
            assert r.json()["checks"] == {**r.json()["checks"], "database": "ok", "storage": "failed"}
