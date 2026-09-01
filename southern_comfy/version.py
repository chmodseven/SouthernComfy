"""Version information for the Southern Comfy node pack.

This module is the single runtime source of truth for the pack version. The
``version`` field in ``pyproject.toml`` mirrors it for packaging and for the
ComfyUI Registry; the two must be bumped together.

Versioning follows ``MAJOR.MINOR.ITERATION``.
"""

from __future__ import annotations

__all__ = ["PACK_ID", "PACK_NAME", "PACK_VERSION"]

PACK_NAME = "Southern Comfy"
"""Human-readable pack name, used in prose and log messages."""

PACK_ID = "SouthernComfy"
"""Identifier form of the pack name: repository folder, category root, labels."""

PACK_VERSION = "0.0.1"
