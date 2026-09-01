"""HTTP surface used by this pack's frontend extensions.

The ``SC Version`` node is purely informational, so it never takes part in graph
execution. Its values therefore reach the browser over this route rather than as
an execution result.
"""

from __future__ import annotations

import logging
from functools import cache

from .comfy_runtime import get_comfyui_version
from .version import PACK_VERSION

__all__ = ["VERSIONS_ROUTE", "register_routes"]

_LOGGER = logging.getLogger("SouthernComfy")

VERSIONS_ROUTE = "/southerncomfy/versions"


@cache
def register_routes() -> None:
    """Attach this pack's routes to the running ComfyUI server.

    Cached so that re-importing the pack cannot register a route twice, which
    aiohttp rejects.
    """
    try:
        from aiohttp import web
        from server import PromptServer
    except ImportError:
        _LOGGER.warning("SouthernComfy could not reach the ComfyUI server; routes disabled.")
        return

    server = getattr(PromptServer, "instance", None)
    routes = getattr(server, "routes", None)
    if routes is None:
        _LOGGER.warning("SouthernComfy found no ComfyUI route table; routes disabled.")
        return

    @routes.get(VERSIONS_ROUTE)
    async def _get_versions(_request):
        return web.json_response({"comfyui": get_comfyui_version(), "pack": PACK_VERSION})
