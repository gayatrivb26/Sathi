"""HTTP routers and how they are mounted per ``AI_INSTANCE_ROLE``."""

from __future__ import annotations

from typing import Literal

from fastapi import FastAPI


def mount_routers(app: FastAPI, role: Literal["all", "ingest"]) -> None:
    """``all`` mounts everything; ``ingest`` (the ``ai-ingest`` instance) mounts ingestion, deletion and health."""
    from app.routers import admin, documents, evaluation, grading, health, ingest, mastery, quiz, runs, tutor

    app.include_router(health.router)
    app.include_router(ingest.router)
    app.include_router(documents.router)
    if role == "all":
        for r in (tutor, quiz, grading, mastery, runs, evaluation, admin):
            app.include_router(r.router)
