"""SSRF-safe page fetcher.

* http/https only, no credentials in URLs, ports limited (default 80/443).
* DNS is resolved by us and **every** resolved address must be public: private, loopback, link-local,
  multicast, reserved, unspecified, CGNAT and cloud-metadata addresses are blocked (IPv4-mapped/6to4/Teredo
  IPv6 forms are unwrapped first).
* The connection is made to the validated IP (custom network backend), so DNS rebinding between check and
  connect does not help an attacker; TLS still verifies the original host name.
* Redirects are followed manually (max 3) and each hop is validated again.
* Body capped at 1.5 MB; total time capped at 5 s; only text/html, xhtml and text/plain are accepted.
"""

from __future__ import annotations

import asyncio
import ipaddress
import socket
import typing
from collections.abc import Awaitable, Callable, Iterable
from dataclasses import dataclass
from urllib.parse import urljoin, urlsplit

import httpcore
import httpx

Resolver = Callable[[str, int], Awaitable[list[str]]]

METADATA_IPS = {
    ipaddress.ip_address("169.254.169.254"),  # AWS/GCP/Azure/OpenStack
    ipaddress.ip_address("169.254.170.2"),  # ECS task metadata
    ipaddress.ip_address("100.100.100.200"),  # Alibaba
    ipaddress.ip_address("fd00:ec2::254"),  # AWS IPv6 IMDS
}
_EXTRA_BLOCKED = [
    ipaddress.ip_network("100.64.0.0/10"),  # CGNAT
    ipaddress.ip_network("192.0.0.0/24"),
    ipaddress.ip_network("198.18.0.0/15"),  # benchmarking
    ipaddress.ip_network("64:ff9b::/96"),  # NAT64 (could reach internal v4)
]
ALLOWED_CONTENT_TYPES = ("text/html", "application/xhtml+xml", "text/plain")


class FetchBlocked(Exception):
    """The URL (or a redirect target) is not allowed."""


class FetchFailed(Exception):
    """Network/HTTP/content failure."""


def _unwrap(ip: ipaddress.IPv4Address | ipaddress.IPv6Address) -> ipaddress.IPv4Address | ipaddress.IPv6Address:
    if isinstance(ip, ipaddress.IPv6Address):
        if ip.ipv4_mapped is not None:
            return ip.ipv4_mapped
        if ip.sixtofour is not None:
            return ip.sixtofour
        if ip.teredo is not None:
            return ip.teredo[1]
    return ip


def is_blocked_ip(value: str | ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    try:
        ip = ipaddress.ip_address(value) if isinstance(value, str) else value
    except ValueError:
        return True
    if ip in METADATA_IPS:
        return True
    inner = _unwrap(ip)
    for candidate in {ip, inner}:
        if (
            candidate in METADATA_IPS
            or candidate.is_private
            or candidate.is_loopback
            or candidate.is_link_local
            or candidate.is_multicast
            or candidate.is_reserved
            or candidate.is_unspecified
            or not candidate.is_global
            or any(candidate in net for net in _EXTRA_BLOCKED if candidate.version == net.version)
        ):
            return True
    return False


async def system_resolver(host: str, port: int) -> list[str]:
    loop = asyncio.get_running_loop()
    infos = await loop.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    return sorted({str(info[4][0]) for info in infos})


async def resolve_public(host: str, port: int, resolver: Resolver) -> list[str]:
    host = host.strip("[]")
    try:
        ipaddress.ip_address(host)
        addresses = [host]
    except ValueError:
        if host.lower() in ("localhost", "localhost.localdomain") or host.lower().endswith(
            (".localhost", ".local", ".internal", ".lan", ".home.arpa")
        ):
            raise FetchBlocked(f"host {host!r} is internal") from None
        try:
            addresses = await resolver(host, port)
        except OSError as exc:
            raise FetchFailed(f"dns failure for {host!r}") from exc
    if not addresses:
        raise FetchFailed(f"no addresses for {host!r}")
    blocked = [a for a in addresses if is_blocked_ip(a)]
    if blocked:
        raise FetchBlocked(f"host {host!r} resolves to a non-public address")
    return addresses


def validate_url(url: str, allowed_ports: Iterable[int]) -> tuple[str, int]:
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https"):
        raise FetchBlocked(f"scheme {parts.scheme!r} not allowed")
    if parts.username or parts.password:
        raise FetchBlocked("credentials in URL not allowed")
    host = parts.hostname
    if not host:
        raise FetchBlocked("missing host")
    try:
        port = parts.port or (443 if parts.scheme == "https" else 80)
    except ValueError as exc:
        raise FetchBlocked("invalid port") from exc
    if port not in set(allowed_ports):
        raise FetchBlocked(f"port {port} not allowed")
    return host, port


class SafeNetworkBackend(httpcore.AsyncNetworkBackend):
    """Resolves and validates at connect time, then connects to the validated IP."""

    def __init__(self, resolver: Resolver, allowed_ports: Iterable[int]) -> None:
        self._inner = httpcore.AnyIOBackend()
        self._resolver = resolver
        self._ports = set(allowed_ports)

    async def connect_tcp(
        self,
        host: str,
        port: int,
        timeout: float | None = None,
        local_address: str | None = None,
        socket_options: typing.Iterable[typing.Any] | None = None,
    ) -> httpcore.AsyncNetworkStream:
        if port not in self._ports:
            raise httpcore.ConnectError(f"port {port} not allowed")
        try:
            addresses = await resolve_public(host, port, self._resolver)
        except (FetchBlocked, FetchFailed) as exc:
            raise httpcore.ConnectError(str(exc)) from exc
        return await self._inner.connect_tcp(
            addresses[0], port, timeout=timeout, local_address=local_address, socket_options=socket_options
        )

    async def connect_unix_socket(self, *args: typing.Any, **kwargs: typing.Any) -> httpcore.AsyncNetworkStream:
        raise httpcore.ConnectError("unix sockets not allowed")

    async def sleep(self, seconds: float) -> None:
        await self._inner.sleep(seconds)


class SafeTransport(httpx.AsyncHTTPTransport):
    def __init__(self, resolver: Resolver, allowed_ports: Iterable[int]) -> None:
        super().__init__(trust_env=False, retries=0)
        ssl_context = httpx.create_ssl_context()
        self._pool = httpcore.AsyncConnectionPool(
            ssl_context=ssl_context,
            max_connections=20,
            max_keepalive_connections=0,
            network_backend=SafeNetworkBackend(resolver, allowed_ports),
        )


@dataclass
class FetchedPage:
    url: str
    status: int
    content_type: str
    body: str
    truncated: bool


class SafeFetcher:
    def __init__(
        self,
        *,
        timeout: float = 5.0,
        max_bytes: int = 1_572_864,
        max_redirects: int = 3,
        allowed_ports: Iterable[int] = (80, 443),
        resolver: Resolver | None = None,
        transport: httpx.AsyncBaseTransport | None = None,
        user_agent: str = "SathiTutorBot/0.1 (+https://sathi.app/bot)",
    ) -> None:
        self.timeout = timeout
        self.max_bytes = max_bytes
        self.max_redirects = max_redirects
        self.allowed_ports = list(allowed_ports)
        self.resolver = resolver or system_resolver
        self._transport = transport
        self.user_agent = user_agent

    def _client(self) -> httpx.AsyncClient:
        transport = self._transport or SafeTransport(self.resolver, self.allowed_ports)
        return httpx.AsyncClient(
            transport=transport,
            follow_redirects=False,
            trust_env=False,
            timeout=httpx.Timeout(self.timeout, connect=min(3.0, self.timeout)),
            headers={"User-Agent": self.user_agent, "Accept": "text/html,application/xhtml+xml,text/plain;q=0.8"},
        )

    async def fetch(self, url: str) -> FetchedPage:
        try:
            async with asyncio.timeout(self.timeout):
                return await self._fetch(url)
        except TimeoutError as exc:
            raise FetchFailed("timeout") from exc

    async def _fetch(self, url: str) -> FetchedPage:
        async with self._client() as client:
            current = url
            for _hop in range(self.max_redirects + 1):
                host, port = validate_url(current, self.allowed_ports)
                await resolve_public(host, port, self.resolver)  # explicit pre-check for every hop
                try:
                    async with client.stream("GET", current) as resp:
                        if resp.status_code in (301, 302, 303, 307, 308):
                            location = resp.headers.get("location")
                            if not location:
                                raise FetchFailed("redirect without location")
                            current = urljoin(current, location)
                            continue
                        if resp.status_code >= 400:
                            raise FetchFailed(f"http {resp.status_code}")
                        ctype = resp.headers.get("content-type", "").split(";")[0].strip().lower()
                        if ctype and not ctype.startswith(ALLOWED_CONTENT_TYPES):
                            raise FetchFailed(f"content-type {ctype!r} not allowed")
                        declared = resp.headers.get("content-length")
                        if declared and declared.isdigit() and int(declared) > self.max_bytes * 4:
                            raise FetchFailed("body too large")
                        buf = bytearray()
                        truncated = False
                        async for part in resp.aiter_bytes():
                            buf.extend(part)
                            if len(buf) >= self.max_bytes:
                                truncated = True
                                del buf[self.max_bytes :]
                                break
                        encoding = resp.charset_encoding or "utf-8"
                        try:
                            body = bytes(buf).decode(encoding, errors="replace")
                        except LookupError:
                            body = bytes(buf).decode("utf-8", errors="replace")
                        return FetchedPage(str(resp.url), resp.status_code, ctype or "text/html", body, truncated)
                except httpx.HTTPError as exc:
                    if "not allowed" in str(exc) or "non-public" in str(exc) or "internal" in str(exc):
                        raise FetchBlocked(str(exc)) from exc
                    raise FetchFailed(type(exc).__name__) from exc
            raise FetchBlocked("too many redirects")
