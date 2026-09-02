"""The record of input values a run was invoked with.

``SC Save Inputs`` writes one of these to ``output/`` after a run; ``SC Load
Inputs`` reads it back and pastes the values into the current workflow. Both
sides live here so the format is described in exactly one place, and, like
``southern_comfy.workflow_hash``, the module takes plain dictionaries and imports
nothing from ComfyUI -- which keeps it usable from a node, from an HTTP route,
and from a plain Python session when checking a saved file by hand.

Two sources, two purposes
-------------------------
ComfyUI hands an executing node two views of the run, and the record keeps both
because they answer different questions.

``nodes``
    Widget values, straight from the workflow. This is the *restorable* half:
    what the user typed, node by node, in the form the frontend itself writes.
    Restoring means putting these back on the widgets they came from.

``resolved``
    The values the backend actually received, from the prompt. Inputs supplied
    by a link are omitted -- they are outputs of other nodes rather than
    anything a user set -- so what remains is the literal configuration the run
    executed with. This half is never restored; it is the honest record of what
    happened, for later inspection and comparison.

They usually agree. Where they differ, the difference is the interesting part:
a widget converted to an input still carries its last typed value in the
workflow while the prompt shows the value that actually arrived over the link.

Restoring is a frontend job
---------------------------
Nothing here pushes values back into a graph, and no node can. ComfyUI's
execution is pull-based: a node sees its own inputs and cannot reach any other
node, so a restore has to happen in the browser, against the live graph. This
module only produces and validates the record.

What is left out
----------------
Both exclusions below apply to ``nodes``, the restorable half. ``resolved``
records whatever the backend was sent, without exception, because its job is to
describe the run rather than to be replayed.

* **Observer nodes** (``workflow_hash.OBSERVER_NODE_TYPES``) contribute no
  widget values. They display a value they computed from the workflow rather
  than holding one the user chose, and that displayed value lands in
  ``widgets_values`` like any other. Saving it would preserve a stale reading,
  and restoring it would overwrite a live one. Their genuine inputs are not
  lost: those reach the backend and so appear under ``resolved``.
* **Subgraph instance nodes**, whose widgets are promoted copies of ones still
  held by the nodes inside the definition. The originals are captured from the
  definition, so taking the copies as well would record every packed value
  twice -- and restore it twice, once through each path.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from .version import PACK_VERSION
from .workflow_hash import OBSERVER_NODE_TYPES, compute_all, iter_nodes, subgraph_ids

__all__ = [
    "FORMAT",
    "FORMAT_VERSION",
    "capture",
    "describe_mismatch",
    "validate",
]

#: Marker identifying a file as one of ours, checked before anything is restored.
FORMAT = "southerncomfy.run_inputs"

#: Incremented only if the shape below changes in a way a reader must know about.
FORMAT_VERSION = 1

#: Scope whose digest decides whether a saved record still fits a workflow.
#:
#: ``structure`` covers the nodes, their types and their wiring, and nothing
#: else -- so it changes precisely when saved values would no longer line up,
#: and stays put when the user has merely moved nodes around or edited values,
#: which is the normal state of affairs when restoring.
COMPATIBILITY_SCOPE = "structure"

#: A prompt input supplied by a link is ``[origin_node_id, origin_slot]``.
_LINK_FIELDS = 2

#: Digest characters shown when reporting a mismatch; enough to tell two apart.
_SHORT = 12


def _timestamp() -> str:
    """Local time with its UTC offset, so a saved run is readable months later."""
    return datetime.now().astimezone().isoformat(timespec="seconds")


def _widget_values(node: dict) -> dict | list | None:
    """A node's widget values, preferring the name-keyed form.

    The frontend writes both: ``widgets_values`` positionally, and
    ``widgets_values_named`` keyed by widget name. The named form is what a
    restore wants -- an index is only meaningful against the exact widget list
    that produced it, so inserting a widget in a node's definition would
    silently shift every value after it onto the wrong control. Names survive
    that. The positional form is kept as a fallback for frontends that do not
    write the named one; a reader tells the two apart by type.

    A node with no widgets writes ``[]`` in one form and ``null`` in the other,
    and both mean the same thing.
    """
    named = node.get("widgets_values_named")
    if isinstance(named, dict) and named:
        return named
    positional = node.get("widgets_values")
    if isinstance(positional, list) and positional:
        return positional
    return None


def _node_values(workflow: dict) -> list[dict]:
    """Every user-set widget value in the workflow, node by node."""
    packed = subgraph_ids(workflow)

    entries: list[dict] = []
    for node, subgraph in iter_nodes(workflow):
        node_type = node.get("type")
        if node_type in OBSERVER_NODE_TYPES or str(node_type) in packed:
            continue

        values = _widget_values(node)
        if values is None:
            continue

        entry: dict[str, Any] = {"id": node.get("id"), "type": node_type}
        title = node.get("title")
        if isinstance(title, str) and title:
            entry["title"] = title
        # Present only for a node inside a subgraph body. Its id is unique
        # within that body, not across the workflow, so the container is needed
        # to find it again.
        if subgraph is not None:
            entry["subgraph"] = subgraph
        entry["values"] = values
        entries.append(entry)

    return entries


def _resolved_inputs(prompt: dict) -> dict[str, dict]:
    """Literal input values per node, as the backend received them.

    Inputs arriving over a link are dropped: they are another node's output, not
    a value anyone set, and recording them would make the file look as though it
    held far more configuration than it does.
    """
    resolved: dict[str, dict] = {}
    for node_id, node in prompt.items():
        if not isinstance(node, dict):
            continue

        inputs = node.get("inputs")
        values = (
            {
                name: value
                for name, value in inputs.items()
                if not (isinstance(value, list) and len(value) == _LINK_FIELDS)
            }
            if isinstance(inputs, dict)
            else {}
        )
        if not values:
            continue

        entry: dict[str, Any] = {"type": node.get("class_type")}
        meta = node.get("_meta")
        title = meta.get("title") if isinstance(meta, dict) else None
        if isinstance(title, str) and title:
            entry["title"] = title
        entry["values"] = values
        resolved[str(node_id)] = entry

    return resolved


def capture(workflow: dict | None, prompt: dict | None) -> dict:
    """Build the record for one run.

    ``workflow`` is ComfyUI's ``extra_pnginfo["workflow"]`` and ``prompt`` its
    hidden ``prompt``. Either may be missing -- a prompt submitted straight to
    the API carries no workflow -- and an absent one simply contributes nothing
    rather than failing the run.
    """
    workflow = workflow if isinstance(workflow, dict) else {}
    prompt = prompt if isinstance(prompt, dict) else {}

    return {
        "format": FORMAT,
        "format_version": FORMAT_VERSION,
        "pack_version": PACK_VERSION,
        "saved_at": _timestamp(),
        # All four scopes, so a reader can ask any of the questions they answer
        # without needing the workflow itself. `structure` gates a restore;
        # `layout` says whether two workflows are identical but for their
        # values; `inputs` fingerprints the values alone; `everything` is the
        # catch-all.
        "checksums": compute_all(workflow),
        "nodes": _node_values(workflow),
        "resolved": _resolved_inputs(prompt),
    }


def validate(payload: Any) -> str | None:
    """Return why ``payload`` is not a usable record, or ``None`` if it is.

    Called before anything is restored. A JSON file picked from a folder of
    ``output/`` is as likely to be a prompt, a workflow or something unrelated
    as one of ours, and the failure has to name what is wrong rather than let a
    restore run over half-understood data.

    Every complaint is phrased to follow "This file ...", so a caller can put
    one in a sentence without reformatting it.
    """
    if not isinstance(payload, dict):
        return "is not a JSON object"
    if payload.get("format") != FORMAT:
        return "is not a SouthernComfy run inputs file"

    version = payload.get("format_version")
    if not isinstance(version, int):
        return "is missing a format version"
    if version > FORMAT_VERSION:
        return (
            f"was written in format version {version}, which is newer than the "
            f"{FORMAT_VERSION} this version of SouthernComfy understands"
        )

    for key, kind, complaint in (
        ("nodes", list, "has no node values"),
        ("checksums", dict, "has no checksums"),
    ):
        if not isinstance(payload.get(key), kind):
            return complaint
    return None


def describe_mismatch(payload: dict, checksums: dict) -> str | None:
    """Return why a record does not fit a workflow, or ``None`` if it does.

    Compares only the ``structure`` digest. Layout and values are expected to
    differ -- restoring values into a workflow whose values differ is the whole
    point -- while a structural difference means the graph is no longer the one
    the values were taken from, and pasting them in would put them on the wrong
    controls or on nothing at all.

    Phrased to follow "This file ...", as ``validate``'s complaints are.
    """
    saved = payload.get("checksums", {}).get(COMPATIBILITY_SCOPE)
    current = checksums.get(COMPATIBILITY_SCOPE)
    if not isinstance(saved, str) or not isinstance(current, str):
        return "was saved without a structure checksum"
    if saved != current:
        return (
            "was saved from a workflow with a different structure "
            f"({saved[:_SHORT]}... rather than {current[:_SHORT]}...). Add, delete or rewire "
            "nodes to match the workflow it came from, or use a record saved from this one"
        )
    return None
