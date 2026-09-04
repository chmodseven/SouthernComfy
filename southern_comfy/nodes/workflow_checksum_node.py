"""The ``SC Workflow Checksum`` node: a digest of the surrounding workflow."""

from __future__ import annotations

from comfy_api.latest import io

from ..workflow_hash import SCOPES, compute_checksum

__all__ = ["SCWorkflowChecksum"]

# Scope labels shown to the user. The stored value is the scope key itself, so
# a saved workflow keeps working if these descriptions are ever reworded.
_SCOPE_TOOLTIP = (
    "What the checksum covers.\n"
    "- everything: any change at all.\n"
    "- structure: nodes, wiring and bypass state only. Unaffected by moving "
    "nodes or editing values, so it is the scope to compare before restoring "
    "saved input values.\n"
    "- layout: as above plus positions, sizes, titles, colors, groups and "
    "per-node settings, but still ignoring values.\n"
    "- inputs: the widget values alone, independent of node identity, so the "
    "same values digest the same after a node is re-added or a subgraph is "
    "packed and unpacked.\n"
    "\n"
    "Note: any widget set to randomize or increment -- a KSampler seed, "
    "typically -- is advanced by ComfyUI the moment you press Run. The inputs "
    "and everything scopes therefore change with every run, and the value on "
    "this node is one step ahead of the value its output sent downstream, "
    "which describes the workflow that actually ran. Set such widgets to fixed "
    "if you need the two to agree."
)


class SCWorkflowChecksum(io.ComfyNode):
    """Reports a deterministic checksum of the workflow it sits in.

    The digest is computed from the workflow ComfyUI supplies as hidden
    metadata, so the node sees the whole canvas rather than only its own
    inputs. Which changes move the number is governed by ``scope``; see
    ``southern_comfy.workflow_hash`` for what each scope covers and for the
    three things deliberately excluded from all of them.

    The value shown on the node face is kept live by
    ``web/sc_workflow_checksum.js``, which recomputes it through the pack's
    checksum route as the canvas is edited. The output socket carries the full
    digest for downstream nodes.
    """

    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="SC_WorkflowChecksum",
            display_name="SC Workflow Checksum",
            category="SouthernComfy/utils",
            description=(
                "Produces a checksum of the current workflow, over a selectable "
                "scope: everything, structure only, layout, or "
                "input values only. Useful for detecting changes to a workflow, "
                "to its values, or to both."
            ),
            search_aliases=[
                "checksum",
                "hash",
                "guid",
                "workflow hash",
                "workflow changed",
                "fingerprint",
            ],
            inputs=[
                io.Combo.Input(
                    "scope",
                    options=list(SCOPES),
                    default=SCOPES[0],
                    tooltip=_SCOPE_TOOLTIP,
                ),
            ],
            outputs=[
                io.String.Output(display_name="CHECKSUM"),
            ],
            hidden=[io.Hidden.extra_pnginfo],
        )

    @classmethod
    def fingerprint_inputs(cls, **_kwargs) -> float:
        """Force a re-run on every execution, so the output is never stale.

        ComfyUI keys its execution cache on a node's *declared* inputs. This
        node's only declared input is ``scope``, while what it actually reports
        depends on the whole surrounding workflow -- which reaches it as hidden
        metadata the cache knows nothing about. Left alone, the node is judged
        unchanged forever: it is skipped as ``execution_cached`` and hands on a
        digest from an entirely different graph.

        Recomputing the digest here to use as a precise cache key is not
        possible. ComfyUI calls this through
        ``get_input_data(node["inputs"], class_def, node_id, None)``, without
        ``dynprompt`` or ``extra_data``, so both ``prompt`` and
        ``extra_pnginfo`` arrive empty -- the workflow simply is not available
        at this point. Reporting "always changed" is therefore the only honest
        answer, and NaN is ComfyUI's idiom for it, since NaN never equals the
        previous NaN.

        The cost is that this node, and anything downstream of it, re-executes
        on every run. Hashing a workflow takes well under a millisecond, and
        what hangs off a checksum is metadata handling rather than heavy
        compute, so that is the right trade.
        """
        return float("nan")

    @classmethod
    def execute(cls, scope: str) -> io.NodeOutput:
        # extra_pnginfo is absent when a prompt arrives without workflow
        # metadata, such as one submitted straight to the API. compute_checksum
        # treats that as an empty workflow rather than failing the run.
        extra = cls.hidden.extra_pnginfo or {}
        workflow = extra.get("workflow") if isinstance(extra, dict) else None
        return io.NodeOutput(compute_checksum(workflow, scope))
