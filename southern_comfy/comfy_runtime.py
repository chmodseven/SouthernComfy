"""Introspection helpers for the ComfyUI installation hosting this pack.

Nodes should query the host through these helpers rather than importing
ComfyUI internals directly, so that version and capability probing lives in one
place and degrades gracefully on installations that differ from our own.
"""

from __future__ import annotations

import logging
from functools import lru_cache
from pathlib import Path

try:  # Python 3.11+
    import tomllib
except ModuleNotFoundError:  # pragma: no cover - Python 3.10
    tomllib = None  # type: ignore[assignment]

__all__ = ["UNKNOWN_VERSION", "get_comfyui_version"]

_LOGGER = logging.getLogger(__name__)

UNKNOWN_VERSION = "unknown"


def _version_from_generated_module() -> str | None:
    """Read ``comfyui_version.__version__``, ComfyUI's canonical version marker.

    ComfyUI regenerates this module from ``pyproject.toml`` whenever its version
    changes, so it is authoritative and present on every supported install.
    """
    try:
        from comfyui_version import __version__
    except Exception:  # noqa: BLE001 - any import failure means "not available"
        return None
    return __version__ or None


def _comfyui_root() -> Path | None:
    """Locate the ComfyUI installation root via a module we know lives there."""
    try:
        import folder_paths
    except Exception:  # noqa: BLE001
        return None
    module_file = getattr(folder_paths, "__file__", None)
    return Path(module_file).resolve().parent if module_file else None


def _version_from_pyproject() -> str | None:
    """Fall back to ComfyUI's own ``pyproject.toml`` if the marker is missing."""
    if tomllib is None:
        return None
    root = _comfyui_root()
    if root is None:
        return None
    pyproject = root / "pyproject.toml"
    try:
        with pyproject.open("rb") as handle:
            data = tomllib.load(handle)
    except (OSError, ValueError):
        return None
    return data.get("project", {}).get("version") or None


@lru_cache(maxsize=1)
def get_comfyui_version() -> str:
    """Return the host ComfyUI version, or ``UNKNOWN_VERSION`` if undetectable.

    The result is cached: a running ComfyUI process cannot change its version.
    """
    for resolve in (_version_from_generated_module, _version_from_pyproject):
        version = resolve()
        if version:
            return str(version)
    _LOGGER.warning("SouthernComfy could not determine the ComfyUI version.")
    return UNKNOWN_VERSION
