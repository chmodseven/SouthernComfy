"""The ``SC Version`` node: reports host and pack versions."""

from __future__ import annotations

from comfy_api.latest import io, ui

from ..comfy_runtime import get_comfyui_version
from ..version import PACK_NAME, PACK_VERSION

__all__ = ["SCVersion"]


class SCVersion(io.ComfyNode):
    """Displays the running ComfyUI version and the Southern Comfy version.

    Useful when reporting issues or when a workflow needs to record the exact
    environment it was authored against.
    """

    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="SC_Version",
            display_name="SC Version",
            category="SouthernComfy/utils",
            description=(
                "Reports the version of the running ComfyUI installation and of "
                "the Southern Comfy node pack."
            ),
            search_aliases=[
                "southern comfy version",
                "comfyui version",
                "about",
            ],
            inputs=[],
            outputs=[
                io.String.Output(
                    "comfyui_version",
                    display_name="comfyui_version",
                    tooltip="Version of the running ComfyUI installation.",
                ),
                io.String.Output(
                    "pack_version",
                    display_name="pack_version",
                    tooltip="Version of the Southern Comfy node pack.",
                ),
            ],
            is_output_node=True,
        )

    @classmethod
    def execute(cls) -> io.NodeOutput:
        comfyui_version = get_comfyui_version()
        summary = f"ComfyUI: {comfyui_version}\n{PACK_NAME}: {PACK_VERSION}"
        return io.NodeOutput(
            comfyui_version,
            PACK_VERSION,
            ui=ui.PreviewText(summary),
        )
