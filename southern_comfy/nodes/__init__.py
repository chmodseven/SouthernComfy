"""Node registry for the SouthernComfy pack.

Adding a node means importing its class here and listing it in ``NODE_CLASSES``.
The package entry point consumes this tuple and nothing else, so registration
stays in exactly one place.
"""

from __future__ import annotations

from comfy_api.latest import io

from .version_node import SCVersion

__all__ = ["NODE_CLASSES"]

NODE_CLASSES: tuple[type[io.ComfyNode], ...] = (SCVersion,)
