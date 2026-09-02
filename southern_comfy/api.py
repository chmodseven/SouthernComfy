"""HTTP surface used by this pack's frontend extensions.

Two kinds of value reach the browser this way rather than as execution results:

* ``SC Version`` is purely informational and never joins the graph, so it has
  no execution result to carry its values.
* ``SC Workflow Checksum`` must update as the canvas is edited, long before any
  run happens. Routing it through the server keeps the hashing algorithm in
  ``southern_comfy.workflow_hash`` alone -- a second implementation in
  JavaScript would be free to drift out of agreement with the Python one, and
  the two disagreeing would be worse than useless.
* ``SC Load Inputs`` must decide whether a saved record still fits the workflow
  on the canvas, which is the same digest question, and must judge whether the
  file is one of ours at all. Both answers come from here so that the rules a
  record is written by and the rules it is read by cannot drift apart.
"""

from __future__ import annotations

import logging
from functools import cache

from .comfy_runtime import get_comfyui_version
from .run_inputs import describe_mismatch, validate
from .version import PACK_VERSION
from .workflow_hash import compute_all

__all__ = ["CHECKSUM_ROUTE", "RESTORE_ROUTE", "VERSIONS_ROUTE", "register_routes"]

_LOGGER = logging.getLogger("SouthernComfy")

VERSIONS_ROUTE = "/southerncomfy/versions"
CHECKSUM_ROUTE = "/southerncomfy/checksum"
RESTORE_ROUTE = "/southerncomfy/restore"


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

    @routes.post(RESTORE_ROUTE)
    async def _post_restore(request):
        """Vet a saved run-inputs record against the workflow on the canvas.

        The frontend does the restoring -- only it can reach a live widget --
        but it does none of the deciding. It sends the file it was given and the
        graph as it stands; this returns the values to apply, or refuses with a
        reason to show the user. Keeping the gate here means the record's format
        and the digest it is judged by are defined in exactly one place.
        """
        try:
            body = await request.json()
        except ValueError:
            return web.json_response({"error": "Expected a JSON body."}, status=400)

        if not isinstance(body, dict):
            return web.json_response({"error": "Expected a JSON object."}, status=400)

        record = body.get("record")
        complaint = validate(record)
        if complaint is not None:
            return web.json_response({"error": f"This file {complaint}."}, status=400)

        workflow = body.get("workflow")
        if not isinstance(workflow, dict):
            return web.json_response({"error": "Expected a 'workflow' object."}, status=400)

        mismatch = describe_mismatch(record, compute_all(workflow))
        if mismatch is not None:
            # 409: the file is perfectly valid, it just does not belong to this
            # graph. Worth distinguishing from a malformed one.
            return web.json_response({"error": f"This file {mismatch}."}, status=409)

        return web.json_response({"nodes": record["nodes"], "saved_at": record.get("saved_at")})
