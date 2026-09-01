"""SouthernComfy - a supplemental pack of custom nodes for ComfyUI.

ComfyUI imports this module directly from ``custom_nodes``. It stays thin on
purpose: it detects the host's node API and hands registration to
``southern_comfy.nodes``.

Registration path selection
---------------------------
ComfyUI's loader prefers ``NODE_CLASS_MAPPINGS`` over ``comfy_entrypoint`` when
both are present, so exactly one of the two is exported. Recent ComfyUI
releases provide the V3 schema API (``comfy_api.latest``) and get the
``comfy_entrypoint`` path; older releases get empty V1 mappings plus an
actionable log message, which lets the pack load inertly instead of raising
during ComfyUI start-up.

Node rendering (legacy LiteGraph vs. Nodes 2.0 / Vue) is a frontend concern and
needs no branching here: nodes built from the standard schema and standard UI
outputs render correctly under both.
"""

from __future__ import annotations

import logging

from .southern_comfy.version import PACK_NAME, PACK_VERSION

# Explicit name: ComfyUI imports this module under a path-derived name, which
# would otherwise make console messages unreadable.
_LOGGER = logging.getLogger("SouthernComfy")

# Serves this pack's web assets at /extensions/SouthernComfy/, which is where
# the frontend looks for per-node help pages (web/docs/<node_id>.md).
WEB_DIRECTORY = "./web"

try:
    from comfy_api.latest import ComfyExtension, io
except ImportError:
    _LOGGER.error(
        "%s %s requires the ComfyUI V3 node API (comfy_api.latest), which this "
        "ComfyUI installation does not provide. Update ComfyUI to a recent "
        "release to enable these nodes.",
        PACK_NAME,
        PACK_VERSION,
    )

    NODE_CLASS_MAPPINGS: dict[str, type] = {}
    NODE_DISPLAY_NAME_MAPPINGS: dict[str, str] = {}

    __all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
else:
    from typing_extensions import override

    from .southern_comfy.api import register_routes
    from .southern_comfy.nodes import NODE_CLASSES

    register_routes()

    class SouthernComfyExtension(ComfyExtension):
        """Exposes the pack's nodes to ComfyUI's V3 extension loader."""

        @override
        async def get_node_list(self) -> list[type[io.ComfyNode]]:
            return list(NODE_CLASSES)

    async def comfy_entrypoint() -> SouthernComfyExtension:
        return SouthernComfyExtension()

    __all__ = ["comfy_entrypoint", "WEB_DIRECTORY"]
