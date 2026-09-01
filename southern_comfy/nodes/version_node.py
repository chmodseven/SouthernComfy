"""The ``SC Version`` node: an at-a-glance report of the running versions."""

from __future__ import annotations

from comfy_api.latest import io

from ..version import PACK_ID

__all__ = ["SCVersion"]

COMFYUI_LABEL = "ComfyUI Version"
PACK_LABEL = f"{PACK_ID} Version"


class SCVersion(io.ComfyNode):
    """Displays the running ComfyUI version and the Southern Comfy version.

    The node is purely informational. It declares no inputs and no outputs, so
    it never joins the execution graph and costs nothing to keep in a workflow.
    Its two labelled rows are populated by the ``web/sc_version.js``
    extension from the ``/southerncomfy/versions`` route.
    """

    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="SC_Version",
            display_name="SC Version",
            category="SouthernComfy/utils",
            description=(
                "Displays the version of the running ComfyUI installation and of "
                "the Southern Comfy node pack."
            ),
            search_aliases=[
                "southern comfy version",
                "comfyui version",
                "about",
            ],
            inputs=[],
            outputs=[],
        )

    @classmethod
    def execute(cls) -> io.NodeOutput:
        # Unreachable in practice: with no outputs the node is never scheduled.
        return io.NodeOutput()
