"""Versioned prompt files: ``<PROMPTS_DIR>/<name>/v<N>.md``.

The highest version is used unless ``PROMPT_VERSIONS`` pins one (``{"tutor_system": 1}``). Every LLM run
records ``prompt_name``, ``prompt_version`` and ``prompt_hash`` (``sha256:<hex>`` of the LF-normalised text).
"""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass
from pathlib import Path

_VERSION_RE = re.compile(r"^v(\d+)\.md$")
REQUIRED_PROMPTS = ("tutor_system", "query_rewrite", "quiz_generation", "grading")


@dataclass(frozen=True)
class Prompt:
    name: str
    version: int
    text: str
    hash: str


class PromptNotFound(LookupError):
    pass


class PromptLibrary:
    def __init__(self, root: Path, pinned: dict[str, int] | None = None) -> None:
        self.root = root
        self.pinned = pinned or {}
        self._cache: dict[str, Prompt] = {}

    def versions(self, name: str) -> list[int]:
        folder = self.root / name
        if not folder.is_dir():
            return []
        found = [int(m.group(1)) for p in folder.iterdir() if (m := _VERSION_RE.match(p.name))]
        return sorted(found)

    def get(self, name: str) -> Prompt:
        if name in self._cache:
            return self._cache[name]
        versions = self.versions(name)
        if not versions:
            raise PromptNotFound(f"no prompt files for {name!r} in {self.root}")
        version = self.pinned.get(name, versions[-1])
        if version not in versions:
            raise PromptNotFound(f"prompt {name!r} v{version} not found (have {versions})")
        raw = (self.root / name / f"v{version}.md").read_bytes()
        # normalise line endings so the hash is identical on Windows and Linux checkouts
        text = raw.decode("utf-8").replace("\r\n", "\n").strip() + "\n"
        prompt = Prompt(
            name=name,
            version=version,
            text=text,
            hash="sha256:" + hashlib.sha256(text.encode("utf-8")).hexdigest(),
        )
        self._cache[name] = prompt
        return prompt

    def validate(self) -> None:
        for name in REQUIRED_PROMPTS:
            self.get(name)
