from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time
from typing import Any

import httpx
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec, rsa
from pydantic import ValidationError

from app.errors import AppError
from app.ids import reference_id, user_id_hash
from app.security import verify_service_token
from tests.conftest import (
    COURSE_X,
    PUBLIC_KEYS,
    SIGNING_KEY,
    USER_A,
    auth,
    generate_rsa_key,
    make_settings,
    make_token,
    public_key_entry,
    public_pem,
)

OTHER_KEY = generate_rsa_key()


def _b64(data: bytes) -> str:
    return base64.b64encode(data).decode()


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _claims(**overrides: Any) -> dict[str, Any]:
    now = int(time.time())
    claims: dict[str, Any] = {
        "iss": "sathi-api",
        "aud": "ai-service",
        "sub": str(USER_A),
        "scp": "tutor mastery",
        "rscope": {"course_ids": [], "user_id": str(USER_A)},
        "iat": now,
        "exp": now + 300,
    }
    claims.update(overrides)
    return claims


def _hand_made_token(header: dict[str, Any], claims: dict[str, Any], hmac_key: bytes | None) -> str:
    """Build a JWT by hand (PyJWT refuses to HMAC-sign with a PEM key, which is exactly the attack)."""
    signing_input = f"{_b64url(json.dumps(header).encode())}.{_b64url(json.dumps(claims).encode())}"
    sig = b"" if hmac_key is None else hmac.new(hmac_key, signing_input.encode(), hashlib.sha256).digest()
    return f"{signing_input}.{_b64url(sig)}"


def _rejected(token: str, **settings: Any) -> AppError:
    with pytest.raises(AppError) as exc:
        verify_service_token(token, make_settings(**settings))
    assert exc.value.code == "SERVICE_TOKEN_INVALID"
    assert exc.value.status == 401
    return exc.value


def test_user_id_hash_vector() -> None:
    assert user_id_hash("00000000-0000-0000-0000-000000000001", "test-salt") == "679ae057de8932a8"
    # input is lower-cased first
    assert user_id_hash("00000000-0000-0000-0000-000000000001".upper(), "test-salt") == "679ae057de8932a8"


def test_reference_id_format() -> None:
    assert reference_id("7f3a91c2e4b5" + "0" * 20) == "7F3A-91C2"
    assert reference_id("7f3a91c2e4b5" + "0" * 20, dashed=False) == "7F3A91C2"
    assert reference_id(None) is None


def test_valid_token_produces_principal() -> None:
    settings = make_settings()
    token = make_token(scopes="tutor ingest", course_ids=[COURSE_X])
    p = verify_service_token(token, settings)
    assert p.user_id == USER_A
    assert p.scopes == {"tutor", "ingest"}
    assert p.rscope.course_ids == (COURSE_X,)
    assert p.rscope.user_id == USER_A
    assert p.user_hash == "679ae057de8932a8"
    assert p.issuer == "sathi-api"


def test_system_token_has_no_user() -> None:
    p = verify_service_token(make_token(sub="system", iss="sathi-jobs", scopes="ingest"), make_settings())
    assert p.user_id is None
    assert p.rscope.user_id is None


@pytest.mark.parametrize(
    ("kwargs", "reason"),
    [
        ({"exp_in": -120}, "expired"),
        ({"aud": "someone-else"}, "wrong audience"),
        ({"iss": "evil"}, "issuer"),
        ({"key": OTHER_KEY}, "signature"),
        ({"kid": "k9"}, "unknown kid"),
    ],
)
def test_invalid_tokens_rejected(kwargs: dict[str, object], reason: str) -> None:
    with pytest.raises(AppError) as exc:
        verify_service_token(make_token(**kwargs), make_settings())  # type: ignore[arg-type]
    assert exc.value.code == "SERVICE_TOKEN_INVALID"
    assert exc.value.status == 401


def test_none_algorithm_rejected() -> None:
    import jwt

    token = jwt.encode(_claims(), key="", algorithm="none", headers={"kid": "k1"})
    err = _rejected(token)
    assert "not allowed" in (err.internal or "")
    for alg in ("none", "None", "NONE"):  # hand-made variants with an empty signature
        _rejected(_hand_made_token({"alg": alg, "typ": "JWT", "kid": "k1"}, _claims(), None))


def test_hs256_signed_with_public_key_pem_is_rejected() -> None:
    """Algorithm confusion: an HS256 token whose HMAC secret is the (public) PEM must never verify."""
    pem = public_pem(SIGNING_KEY)
    for secret in (pem, pem.strip(), base64.b64encode(pem)):
        token = _hand_made_token({"alg": "HS256", "typ": "JWT", "kid": "k1"}, _claims(), secret)
        err = _rejected(token)
        assert "HS256" in (err.internal or "")
    # also with a kid-less single-key configuration
    kidless = public_key_entry(SIGNING_KEY, None)
    _rejected(_hand_made_token({"alg": "HS256", "typ": "JWT"}, _claims(), pem), service_token_public_keys=kidless)


def test_hs256_with_a_shared_secret_is_rejected() -> None:
    import jwt

    token = jwt.encode(_claims(), "s" * 48, algorithm="HS256", headers={"kid": "k1"})
    _rejected(token)


@pytest.mark.parametrize("alg", ["RS384", "RS512", "PS256"])
def test_other_rsa_algorithms_rejected(alg: str) -> None:
    _rejected(make_token(algorithm=alg))


def test_tampered_payload_rejected() -> None:
    header, _, sig = make_token(scopes="tutor").split(".")
    forged = _b64url(json.dumps(_claims(scp="tutor admin")).encode())
    _rejected(f"{header}.{forged}.{sig}")


def test_malformed_token_rejected() -> None:
    for token in ("", "abc", "a.b.c", "eyJhbGciOiJSUzI1NiJ9..."):
        _rejected(token)


def test_key_rotation_selects_key_by_kid() -> None:
    keys = f"{PUBLIC_KEYS},{public_key_entry(OTHER_KEY, 'k0')}"
    settings = make_settings(service_token_public_keys=keys)
    assert verify_service_token(make_token(kid="k1"), settings).user_id == USER_A
    assert verify_service_token(make_token(key=OTHER_KEY, kid="k0"), settings).user_id == USER_A
    with pytest.raises(AppError):  # right key, wrong kid → signature mismatch
        verify_service_token(make_token(key=OTHER_KEY, kid="k1"), settings)
    with pytest.raises(AppError):  # no kid is ambiguous with several keys
        verify_service_token(make_token(kid=None), settings)


def test_token_without_kid_accepted_with_a_single_key() -> None:
    assert verify_service_token(make_token(kid=None), make_settings()).user_id == USER_A


def test_kidless_single_entry_verifies_any_kid() -> None:
    settings = make_settings(service_token_public_keys=public_key_entry(SIGNING_KEY, None))
    assert verify_service_token(make_token(kid="k7"), settings).user_id == USER_A
    assert verify_service_token(make_token(kid=None), settings).user_id == USER_A
    with pytest.raises(AppError):
        verify_service_token(make_token(key=OTHER_KEY), settings)


def _ec_public_pem() -> bytes:
    return (
        ec.generate_private_key(ec.SECP256R1())
        .public_key()
        .public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo)
    )


def _private_pem() -> bytes:
    return SIGNING_KEY.private_bytes(
        serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()
    )


@pytest.mark.parametrize(
    "value",
    [
        "",
        " , ",
        "k1:not-base64!!",
        "k1:" + _b64(b"hello"),
        "bad kid:" + _b64(public_pem(SIGNING_KEY)),
        f"{public_key_entry(SIGNING_KEY, 'k1')},{public_key_entry(OTHER_KEY, 'k1')}",
        f"{public_key_entry(SIGNING_KEY, None)},{public_key_entry(OTHER_KEY, 'k0')}",
        "k1:" + _b64(public_pem(rsa.generate_private_key(public_exponent=65537, key_size=1024))),  # noqa: S505 - must be rejected
        "k1:" + _b64(_ec_public_pem()),
        "k1:" + _b64(_private_pem()),
    ],
    ids=[
        "empty",
        "blank",
        "not-base64",
        "not-pem",
        "bad-kid",
        "duplicate-kid",
        "kidless-mixed",
        "rsa-1024",
        "ec-key",
        "private-key",
    ],
)
def test_invalid_public_key_config_fails_fast(value: str) -> None:
    with pytest.raises(ValidationError):
        make_settings(service_token_public_keys=value)


def test_public_keys_are_required_and_the_old_secret_is_gone() -> None:
    from app.config import Settings

    with pytest.raises(ValidationError) as exc:
        Settings(  # type: ignore[call-arg]
            database_url="postgresql+psycopg://u:p@localhost:1/x",
            log_hash_salt="s",
            storage_endpoint="http://localhost:9",
            storage_access_key="a",
            storage_secret_key="b",
            service_token_secret=_b64(b"s" * 48),
        )
    assert "service_token_public_keys" in str(exc.value)
    assert not hasattr(make_settings(), "service_token_secret")


async def test_endpoint_requires_token(nodb_client: httpx.AsyncClient) -> None:
    r = await nodb_client.post("/internal/v1/mastery/update", json={"prior": 0.4, "attempts": 1, "correct": True})
    assert r.status_code == 401
    body = r.json()
    assert r.headers["content-type"].startswith("application/problem+json")
    assert body["code"] == "SERVICE_TOKEN_INVALID"
    assert body["traceId"] and len(body["traceId"]) == 32
    assert body["referenceId"] == f"{body['traceId'][:4].upper()}-{body['traceId'][4:8].upper()}"


async def test_endpoint_rejects_expired_and_wrong_audience(nodb_client: httpx.AsyncClient) -> None:
    payload = {"prior": 0.4, "attempts": 1, "correct": True}
    for kwargs in ({"scopes": "mastery", "exp_in": -100}, {"scopes": "mastery", "aud": "sathi-api"}):
        r = await nodb_client.post("/internal/v1/mastery/update", json=payload, headers=auth(**kwargs))
        assert r.status_code == 401
        assert r.json()["code"] == "SERVICE_TOKEN_INVALID"


async def test_endpoint_rejects_algorithm_confusion(nodb_client: httpx.AsyncClient) -> None:
    token = _hand_made_token({"alg": "HS256", "typ": "JWT", "kid": "k1"}, _claims(), public_pem(SIGNING_KEY))
    r = await nodb_client.post(
        "/internal/v1/mastery/update",
        json={"prior": 0.4, "attempts": 1, "correct": True},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert r.status_code == 401
    assert r.json()["code"] == "SERVICE_TOKEN_INVALID"


async def test_endpoint_missing_scope_is_403(nodb_client: httpx.AsyncClient) -> None:
    r = await nodb_client.post(
        "/internal/v1/mastery/update",
        json={"prior": 0.4, "attempts": 1, "correct": True},
        headers=auth(scopes="tutor"),
    )
    assert r.status_code == 403
    assert r.json()["code"] == "AUTH_FORBIDDEN"


async def test_request_id_echoed(nodb_client: httpx.AsyncClient) -> None:
    r = await nodb_client.post(
        "/internal/v1/mastery/update",
        json={"prior": 0.42, "attempts": 3, "correct": True, "difficulty": 0.5},
        headers=auth(scopes="mastery"),
    )
    assert r.status_code == 200
    assert r.headers["x-request-id"] == "req-123"
    assert len(r.headers["x-trace-id"]) == 32
    assert r.json() == {"mastery": pytest.approx(0.513, abs=0.001)}
