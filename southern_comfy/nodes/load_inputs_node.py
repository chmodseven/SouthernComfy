"""The ``SC Load Inputs`` node: restores input values saved by ``SC Save Inputs``."""

from __future__ import annotations

from comfy_api.latest import io

__all__ = ["SCLoadInputs"]


class SCLoadInputs(io.ComfyNode):
    """Pastes the values from a saved run back into the workflow.

    The node declares no inputs and no outputs, so it never joins the execution
    graph -- and it could not do this work there even if it did. ComfyUI's
    execution is pull-based: a node is handed its own inputs and has no way to
    reach any other node, let alone write to one. Restoring therefore has to
    happen in the browser, against the live graph, and all of this node's
    behaviour lives in ``web/sc_load_inputs.js``.

    What the frontend does not do is decide. It sends the chosen file and the
    current graph to ``/southerncomfy/restore``, which checks the file really is
    one of ours and that its ``structure`` digest matches the workflow on the
    canvas, and hands back the values to apply or a reason it will not. That
    keeps the rules a record is written by and read by in one place.
    """

    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="SC_LoadInputs",
            display_name="SC Load Inputs",
            category="SouthernComfy/utils",
            description=(
                "Restores the input values of an earlier run from a file saved "
                "by SC Save Inputs, pasting them back into this workflow. The "
                "workflow must still have the structure the values were saved "
                "from."
            ),
            search_aliases=[
                "load inputs",
                "load parameters",
                "load settings",
                "restore inputs",
                "restore parameters",
                "run inputs",
                "parameters",
            ],
            inputs=[],
            outputs=[],
        )

    @classmethod
    def execute(cls) -> io.NodeOutput:
        # Unreachable in practice: with no outputs the node is never scheduled.
        return io.NodeOutput()
