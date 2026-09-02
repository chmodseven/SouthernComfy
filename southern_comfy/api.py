"""HTTP surface used by this pack's frontend extensions.

Two kinds of value reach the browser this way rather than as execution results:

* ``SC Version`` is purely informational and never joins the graph, so it has
  no execution result to carry its values.
* ``SC Workflow Checksum`` must update as the canvas is edited, long before any
  run happens. Routing it through the server keeps the hashing algorithm in
  ``southern_comfy.workflow_hash`` alone -- a second implementation in
  JavaScript would be free to drift out of agreement with the Python one, and
  the two disagreeing would be worse than useless.
"""

from __future__ import annotations

import logging
from functools import cache

from .comfy_runtime import get_comfyui_version
from .version import PACK_VERSION
from .workflow_hash import compute_all

__all__ = ["CHECKSUM_ROUTE", "VERSIONS_ROUTE", "register_routes"]

_LOGGER = logging.getLogger("SouthernComfy")

VERSIONS_ROUTE = "/southerncomfy/versions"
CHECKSUM_ROUTE = "/southerncomfy/checksum"


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

    @routes.post(CHECKSUM_ROUTE)
    async def _post_checksum(request):
        try:
            body = await request.json()
        except ValueError:
            return web.json_response({"error": "expected a JSON body"}, status=400)

        workflow = body.get("workflow") if isinstance(body, dict) else None
        if not isinstance(workflow, dict):
            return web.json_response({"error": "expected a 'workflow' object"}, status=400)

        return web.json_response(compute_all(workflow))
