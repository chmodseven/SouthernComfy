"""The ``SC Version`` node: an at-a-glance report of the running versions."""

from __future__ import annotations

from comfy_api.latest import io

__all__ = ["SCVersion"]


class SCVersion(io.ComfyNode):
    """Displays the running ComfyUI version and the SouthernComfy version.

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
                "the SouthernComfy node pack."
            ),
            search_aliases=[
                "southerncomfy version",
                "comfyui version",
                "about",
                # Spelling tolerance only, so the node is still found by users
                # who type the pack name as two words. Not a name we use.
                "southern comfy",
            ],
            inputs=[],
            outputs=[],
        )

    @classmethod
    def execute(cls) -> io.NodeOutput:
        # Unreachable in practice: with no outputs the node is never scheduled.
        return io.NodeOutput()
