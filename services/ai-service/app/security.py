"""Service-token verification (contracts §6, §11.7).

RS256 JWT signed by .NET with an RSA private key; this service only holds the public keys
(``SERVICE_TOKEN_PUBLIC_KEYS``) and picks one by the JWT ``kid`` header. Only ``alg=RS256`` is accepted —
``HS256`` (including the classic "HMAC with the public key as secret" confusion attack) and ``none`` are
rejected before any signature check. ``iss`` ∈ {sathi-api, sathi-jobs}, ``aud = ai-service``; claims
``sub, uh, scp, rscope, rid, iat, exp``.
"""

from __future__ import annotations

import uuid
from collections.abc import Callable, Coroutine
from dataclasses import dataclass, field
from typing import Any

import jwt
from cryptography.hazmat.primitives.asymmetric.rsa import RSAPublicKey
from fastapi import Depends, Request

from app.config import Settings
from app.errors import AppError
from app.ids import user_id_hash
from app.logging import bind

ALLOWED_ISSUERS = frozenset({"sathi-api", "sathi-jobs"})
AUDIENCE = "ai-service"
ALL_SCOPES = frozenset({"tutor", "ingest", "quiz", "grade", "mastery", "runs", "eval", "admin"})
ALGORITHM = "RS256"


@dataclass(frozen=True)
class RetrievalScope:
    course_ids: tuple[uuid.UUID, ...] = ()
    user_id: uuid.UUID | None = None

    @property
    def is_empty(self) -> bool:
        return not self.course_ids and self.user_id is None


@dataclass(frozen=True)
class Principal:
    subject: str
    user_id: uuid.UUID | None
    user_hash: str | None
    scopes: frozenset[str]
    rscope: RetrievalScope
    issuer: str
    request_id: str | None = None
    claims: dict[str, Any] = field(default_factory=dict, compare=False, repr=False)

    def has(self, scope: str) -> bool:
        return scope in self.scopes


def _parse_uuid(value: Any) -> uuid.UUID | None:
    if value in (None, "", "system"):
        return None
    try:
        return uuid.UUID(str(value))
    except ValueError as exc:
        raise AppError("SERVICE_TOKEN_INVALID", internal=f"bad uuid claim {value!r}") from exc


def _verification_key(token: str, keys: dict[str | None, RSAPublicKey]) -> RSAPublicKey:
    """Check the (unverified) header: ``alg`` must be RS256 and ``kid`` must name a configured key."""
    try:
        header = jwt.get_unverified_header(token)
    except jwt.PyJWTError as exc:
        raise AppError("SERVICE_TOKEN_INVALID", internal=f"malformed token: {type(exc).__name__}") from exc
    alg = header.get("alg")
    if alg != ALGORITHM:
        raise AppError("SERVICE_TOKEN_INVALID", internal=f"algorithm {alg!r} not allowed")
    kid = header.get("kid")
    if kid is not None and not isinstance(kid, str):
        raise AppError("SERVICE_TOKEN_INVALID", internal="kid must be a string")
    if None in keys:  # single kid-less key: verifies every token
        return keys[None]
    if kid is None:
        if len(keys) == 1:
            return next(iter(keys.values()))
        raise AppError("SERVICE_TOKEN_INVALID", internal="token has no kid and several keys are configured")
    key = keys.get(kid)
    if key is None:
        raise AppError("SERVICE_TOKEN_INVALID", internal=f"unknown kid {kid!r}")
    return key


def verify_service_token(token: str, settings: Settings) -> Principal:
    key = _verification_key(token, settings.token_public_keys)
    try:
        claims: dict[str, Any] = jwt.decode(
            token,
            key,
            algorithms=[ALGORITHM],
            audience=AUDIENCE,
            leeway=settings.service_token_leeway_seconds,
            options={"require": ["exp", "iat", "iss", "aud", "sub"]},
        )
    except jwt.ExpiredSignatureError as exc:
        raise AppError("SERVICE_TOKEN_INVALID", internal="token expired") from exc
    except jwt.InvalidAudienceError as exc:
        raise AppError("SERVICE_TOKEN_INVALID", internal="wrong audience") from exc
    except jwt.PyJWTError as exc:
        raise AppError("SERVICE_TOKEN_INVALID", internal=f"invalid token: {type(exc).__name__}") from exc

    issuer = str(claims.get("iss"))
    if issuer not in ALLOWED_ISSUERS:
        raise AppError("SERVICE_TOKEN_INVALID", internal=f"issuer {issuer!r} not allowed")

    subject = str(claims["sub"])
    user_id = _parse_uuid(subject)
    raw_scope = claims.get("scp", "")
    scopes = frozenset(raw_scope.split()) if isinstance(raw_scope, str) else frozenset(map(str, raw_scope))

    rs = claims.get("rscope") or {}
    if not isinstance(rs, dict):
        raise AppError("SERVICE_TOKEN_INVALID", internal="rscope must be an object")
    course_ids = tuple(cid for cid in (_parse_uuid(c) for c in (rs.get("course_ids") or [])) if cid is not None)
    rscope = RetrievalScope(course_ids=course_ids, user_id=_parse_uuid(rs.get("user_id")))

    uh = claims.get("uh")
    if not uh and user_id is not None:
        uh = user_id_hash(str(user_id), settings.log_hash_salt.get_secret_value())
    return Principal(
        subject=subject,
        user_id=user_id,
        user_hash=str(uh) if uh else None,
        scopes=scopes,
        rscope=rscope,
        issuer=issuer,
        request_id=claims.get("rid"),
        claims=claims,
    )


def _bearer(request: Request) -> str:
    header = request.headers.get("authorization", "")
    scheme, _, token = header.partition(" ")
    if scheme.lower() != "bearer" or not token.strip():
        raise AppError("SERVICE_TOKEN_INVALID", internal="missing bearer token")
    return token.strip()


async def get_principal(request: Request) -> Principal:
    settings: Settings = request.app.state.container.settings
    principal = verify_service_token(_bearer(request), settings)
    bind(user_id_hash=principal.user_hash)
    request.state.principal = principal
    return principal


def require_scope(scope: str) -> Callable[..., Coroutine[Any, Any, Principal]]:
    if scope not in ALL_SCOPES:
        raise ValueError(f"unknown scope {scope}")

    async def dependency(principal: Principal = Depends(get_principal)) -> Principal:
        if not principal.has(scope):
            raise AppError("AUTH_FORBIDDEN", internal=f"missing scope {scope!r}")
        return principal

    return dependency
