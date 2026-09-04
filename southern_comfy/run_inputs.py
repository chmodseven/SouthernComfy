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

import re
from collections import defaultdict
from collections.abc import Iterator
from datetime import datetime
from typing import Any

from .version import PACK_VERSION
from .workflow_hash import OBSERVER_NODE_TYPES, compute_all, iter_nodes, subgraph_ids

__all__ = [
    "FORMAT",
    "FORMAT_VERSION",
    "MINIMUM_FORMAT_VERSION",
    "UNRESTORABLE_TYPES",
    "capture",
    "describe_change",
    "finish_run",
    "plan_restore",
    "start_run",
    "validate",
]

#: Marker identifying a file as one of ours, checked before anything is restored.
FORMAT = "southerncomfy.run_inputs"

#: Incremented if the shape below changes in a way a reader must know about.
FORMAT_VERSION = 2

#: Oldest version still read. Equal to ``FORMAT_VERSION`` while the pack is
#: unreleased: nothing outside development has written a record yet, so carrying
#: code to read a shape we have already replaced would be maintaining a
#: compatibility promise made to nobody. Once the pack ships, lower this instead
#: of adding branches, and keep readers tolerant of absent keys rather than
#: versioned.
MINIMUM_FORMAT_VERSION = FORMAT_VERSION

#: ``properties`` keys recording where a node came from rather than how it is set
#: up. Captured for the record but never restored: writing a saved ``ver`` or
#: ``cnr_id`` back onto a node would misstate which release of which pack it
#: belongs to, and ComfyUI maintains them itself.
PROVENANCE_PROPERTIES = frozenset({"ver", "cnr_id", "aux_id", "models"})

#: Serialised node keys that describe the *graph* rather than a node's own
#: state. Anything else a node writes into its serialised form is state some
#: pack chose to keep outside ``properties``, and is captured as ``extra``.
_STRUCTURAL_KEYS = frozenset(
    {
        "id",
        "type",
        "pos",
        "size",
        "flags",
        "order",
        "mode",
        "inputs",
        "outputs",
        "properties",
        "widgets_values",
        "widgets_values_named",
        "title",
        "color",
        "bgcolor",
        "shape",
        "index",
        "subgraph",
    }
)

#: Keys that must never be written onto a live node or into its ``properties``,
#: whatever a file says.
#:
#: A restore assigns saved state straight onto the node the browser found, which
#: is what makes it work for packs this one has never heard of. In JavaScript,
#: three of those names are not ordinary keys: assigning ``__proto__`` replaces
#: an object's prototype outright, and ``constructor`` and ``prototype`` are
#: little better. A node whose prototype has been replaced has lost every method
#: LiteGraph gave it, which breaks the canvas rather than merely the node.
#:
#: No node serialises state under these names, so nothing legitimate is lost by
#: refusing them. They are dropped both when a record is written and when one is
#: read, because a record is a file: it can be edited, shared, or arrive from a
#: hosted ComfyUI, and the reader cannot assume this pack wrote it.
UNSAFE_KEYS = frozenset({"__proto__", "constructor", "prototype"})

#: Keys that must never be restored as ``extra``, on top of ``UNSAFE_KEYS``.
#:
#: ``extra`` is assigned directly onto the live node, so a key named like one of
#: LiteGraph's callbacks -- ``onExecute``, ``onDrawForeground``, ``onRemoved``,
#: any ``onSomething`` -- replaces a hook the canvas calls with whatever the file
#: happened to hold. LiteGraph then calls a string, and the node throws on its
#: next frame. A pack cannot legitimately keep state under one of these names for
#: the same reason: the name is already taken by the callback it would shadow.
#:
#: This does not apply to ``properties``, which is an ordinary dictionary of the
#: node's own; a key called ``onFoo`` in there shadows nothing.
_CALLBACK_KEY = re.compile(r"^on[A-Z]")


def _unsafe_extra(key: str) -> bool:
    """Whether ``key`` would change the node itself rather than its state."""
    return key in UNSAFE_KEYS or bool(_CALLBACK_KEY.match(str(key)))


#: Scopes reported as an advisory when a record is applied to an edited graph,
#: most significant first. Neither decides anything -- see ``plan_restore``
#: for why a whole-graph digest makes a poor gate -- but naming the kind of
#: change costs nothing and explains a surprising-looking result.
EDIT_SCOPES = ("structure", "layout")

#: Node types whose own values are this pack's bookkeeping, not run parameters.
#:
#: ``SC_Label`` carries annotations rather than parameters: returning to an
#: earlier run's values should never rewrite the notes made about it since.
#:
#: Beyond the observers, ``SC_SaveInputs`` is here for a reason of its own:
#: restoring its ``filename_prefix`` would silently redirect where *future* runs
#: are written. Returning to an old set of values should not quietly move the
#: output folder, so its prefix is recorded under ``resolved`` -- where the run
#: genuinely used it -- and left out of the restorable half.
UNRESTORABLE_TYPES = OBSERVER_NODE_TYPES | frozenset({"SC_SaveInputs", "SC_Label"})

#: Names listed in full before a complaint switches to "and N more".
_MAX_NAMED = 5

#: A prompt input supplied by a link is ``[origin_node_id, origin_slot]``.
_LINK_FIELDS = 2


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


def _node_properties(node: dict) -> dict:
    """A node's ``properties``, minus the ones ComfyUI maintains itself.

    Most third-party state lives here rather than in widgets -- measured across
    a 26-workflow corpus, ``properties`` held every pack-specific setting that
    turned up (cg-use-everywhere's ``ue_properties``, rgthree's Fast Groups
    settings, Reroute's ``horizontal``, core's own ``Node name for S&R``) while
    exactly one such setting appeared anywhere else. Capturing widgets alone
    therefore misses a real part of how a workflow is set up.

    Only provenance is dropped. The rest is kept even where it looks like
    runtime state rather than configuration, because the two cannot be told
    apart by inspection -- the lesson ``_OWNED_PROPERTY_PREFIX`` in
    ``workflow_hash`` records -- and because putting a node back exactly as it
    was is the point here. Restoring a stale reading is harmless; the node
    overwrites it on its next run.

    Note this is capture, not hashing. ``workflow_hash`` still digests only the
    properties this pack owns, so none of this can make a checksum drift.
    """
    properties = node.get("properties")
    if not isinstance(properties, dict):
        return {}
    return {
        k: v
        for k, v in properties.items()
        if k not in PROVENANCE_PROPERTIES and k not in UNSAFE_KEYS
    }


def _extra_state(node: dict) -> dict:
    """Whatever a node serialised outside the fields ComfyUI defines.

    LiteGraph lets a node add its own keys through ``onSerialize``, so this is
    the other place pack state can hide. It is rare -- one key across the whole
    corpus -- but it costs nothing to carry, and a node that uses it has no
    other way to be restored. Keys beginning with an underscore are skipped as
    internals.
    """
    return {
        k: v
        for k, v in node.items()
        if k not in _STRUCTURAL_KEYS and not _unsafe_extra(k) and not str(k).startswith("_")
    }


def _node_values(workflow: dict) -> list[dict]:
    """Every restorable piece of node state in the workflow, node by node."""
    packed = subgraph_ids(workflow)

    entries: list[dict] = []
    for node, subgraph in iter_nodes(workflow):
        node_type = node.get("type")
        if node_type in UNRESTORABLE_TYPES or str(node_type) in packed:
            continue

        values = _widget_values(node) or {}
        properties = _node_properties(node)
        extra = _extra_state(node)
        if not values and not properties and not extra:
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
        if properties:
            entry["properties"] = properties
        if extra:
            entry["extra"] = extra
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


STATUS_RUNNING = "running"
STATUS_SUCCESS = "success"
STATUS_ERROR = "error"
STATUS_INTERRUPTED = "interrupted"

#: Execution messages ComfyUI stamps into a history entry, and the status each
#: one implies. Every message carries a millisecond ``timestamp``.
_END_MESSAGES = {
    "execution_success": STATUS_SUCCESS,
    "execution_error": STATUS_ERROR,
    "execution_interrupted": STATUS_INTERRUPTED,
}

#: A recorded execution message is ``[name, data]``.
_MESSAGE_FIELDS = 2


def start_run(prompt_id: str | None, memory: dict | None = None) -> dict:
    """The ``run`` block as it stands while the prompt is still executing.

    Written out immediately so a record exists even if ComfyUI is closed, or
    crashes, before the run ends. ``finish_run`` replaces it once the outcome is
    known.
    """
    run: dict[str, Any] = {
        "prompt_id": prompt_id,
        "status": STATUS_RUNNING,
        "started_at": _timestamp(),
    }
    if memory:
        run["memory_at_start"] = memory
    return run


def _messages(history_entry: dict) -> Iterator[tuple[str, dict]]:
    """Each execution message in a history entry, as ``(name, data)``.

    ``status.messages`` is a list of ``[name, data]`` pairs, and ComfyUI stamps
    a millisecond ``timestamp`` onto every one of them.
    """
    status = history_entry.get("status")
    messages = status.get("messages") if isinstance(status, dict) else None
    if not isinstance(messages, list):
        return
    for message in messages:
        if isinstance(message, (list, tuple)) and len(message) >= _MESSAGE_FIELDS:
            name, data = message[0], message[1]
            if isinstance(data, dict):
                yield str(name), data


def _outcome(times: dict[str, int], history_entry: dict) -> tuple[str | None, int | None]:
    """The run's final status and the moment it reached it."""
    for message, implied in _END_MESSAGES.items():
        if message in times:
            return implied, times[message]
    status = history_entry.get("status")
    status_str = status.get("status_str") if isinstance(status, dict) else None
    if status_str in (STATUS_SUCCESS, STATUS_ERROR):
        return status_str, None
    return None, None


def _details(history_entry: dict) -> dict:
    """What else the history entry says about how the run went."""
    found: dict[str, Any] = {}
    for name, data in _messages(history_entry):
        if name == "execution_cached" and isinstance(data.get("nodes"), list):
            # Cached nodes did not run this time. Worth recording: a run that
            # reused most of its graph is not comparable with one that computed
            # all of it.
            found["cached_nodes"] = len(data["nodes"])
        elif name == "execution_error":
            found["error"] = {
                key: data.get(key)
                for key in ("node_id", "node_type", "exception_type", "exception_message")
                if data.get(key) is not None
            }
    return found


def finish_run(run: dict, history_entry: dict | None, memory: dict | None = None) -> dict:
    """Complete a ``run`` block from the history entry ComfyUI recorded.

    Derives the outcome and the wall-clock duration. ComfyUI keeps no per-node
    timing of its own, so a run total is all that can honestly be reported from
    here -- see the module notes on ``ProgressHandler`` for where finer timing
    would have to come from.

    A missing history entry means the wait gave up or the queue was cleared. The
    status is then left as it was rather than guessed at.
    """
    finished = dict(run)
    finished["ended_at"] = _timestamp()
    if memory:
        finished["memory_at_end"] = memory
    if not isinstance(history_entry, dict):
        return finished

    times = {
        name: int(data["timestamp"])
        for name, data in _messages(history_entry)
        if isinstance(data.get("timestamp"), (int, float))
    }
    outcome, ended = _outcome(times, history_entry)
    if outcome is not None:
        finished["status"] = outcome

    started = times.get("execution_start")
    if started is not None:
        finished["started_at_ms"] = started
        if ended is not None:
            finished["ended_at_ms"] = ended
            # Both stamps come from ComfyUI's own wall clock, so a clock
            # correction landing mid-run can put the end before the start. A
            # negative duration is never a fact worth recording.
            finished["duration_seconds"] = max(0.0, round((ended - started) / 1000, 3))

    finished.update(_details(history_entry))
    return finished


def capture(
    workflow: dict | None,
    prompt: dict | None,
    description: str = "",
    run: dict | None = None,
) -> dict:
    """Build the record for one run.

    ``workflow`` is ComfyUI's ``extra_pnginfo["workflow"]`` and ``prompt`` its
    hidden ``prompt``. Either may be missing -- a prompt submitted straight to
    the API carries no workflow -- and an absent one simply contributes nothing
    rather than failing the run.

    ``description`` is the user's own one-line note, kept at the top level so a
    reader (or a run-history list) can show it without walking the values.
    ``run`` is the block from ``start_run``, completed later by ``finish_run``.
    """
    workflow = workflow if isinstance(workflow, dict) else {}
    prompt = prompt if isinstance(prompt, dict) else {}

    return {
        "format": FORMAT,
        "format_version": FORMAT_VERSION,
        "pack_version": PACK_VERSION,
        "description": description.strip() if isinstance(description, str) else "",
        "saved_at": _timestamp(),
        "run": run if isinstance(run, dict) else {},
        # All four scopes, so a reader can ask any of the questions they answer
        # without needing the workflow itself. `structure` gates a restore;
        # `layout` says whether two workflows are identical but for their
        # values; `inputs` fingerprints the values alone; `everything` is the
        # catch-all.
        "checksums": compute_all(workflow),
        "nodes": _node_values(workflow),
        "resolved": _resolved_inputs(prompt),
    }


def _version_complaint(version: Any) -> str | None:
    """Why a record's format version cannot be read, or ``None`` if it can."""
    if not isinstance(version, int):
        return "is missing a format version"
    if version > FORMAT_VERSION:
        return (
            f"was written in format version {version}, which is newer than the "
            f"{FORMAT_VERSION} this version of SouthernComfy understands"
        )
    if version < MINIMUM_FORMAT_VERSION:
        return (
            f"was written in format version {version}, which this version of "
            "SouthernComfy no longer reads -- run the workflow again to record it afresh"
        )
    return None


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

    complaint = _version_complaint(payload.get("format_version"))
    if complaint is not None:
        return complaint

    for key, kind, complaint in (
        ("nodes", list, "has no node values"),
        ("checksums", dict, "has no checksums"),
    ):
        if not isinstance(payload.get(key), kind):
            return complaint
    return None


def _entry_label(entry: dict) -> str:
    """Name an entry the way the user would recognise it."""
    return f"{entry.get('title') or entry.get('type')} #{entry.get('id')}"


def _listing(names: list[str]) -> str:
    """Join names for a message, abbreviating a long list rather than dumping it."""
    if len(names) <= _MAX_NAMED:
        return ", ".join(names)
    return f"{', '.join(names[:_MAX_NAMED])} and {len(names) - _MAX_NAMED} more"


def _index(workflow: dict) -> tuple[dict, dict]:
    """Live nodes keyed by (subgraph, id), and their ids grouped by type."""
    by_key: dict[tuple, dict] = {}
    by_type: dict[tuple, list[str]] = defaultdict(list)
    for node, subgraph in iter_nodes(workflow):
        node_id = str(node.get("id"))
        by_key[(subgraph, node_id)] = node
        by_type[(subgraph, str(node.get("type")))].append(node_id)
    return by_key, by_type


def _rematch(
    group: list[dict], candidates: list[str], nodes: dict, subgraph: str | None
) -> tuple[list[tuple[dict, str]], list[dict]]:
    """Pair entries with same-type nodes that no id matched, without guessing.

    Deleting a node and adding an identical one back gives it a *new* id --
    ComfyUI never reuses one -- so a record can be left pointing at an id that
    is gone even though the graph looks and behaves exactly as it did before.
    Refusing outright would be unhelpful, and telling the user to put the node
    back would be a lie: no amount of re-adding recovers the old id. Only an
    undo does.

    So an unmatched entry may claim a node of the same type, in the same
    container, that no other entry has claimed -- but only where the choice is
    forced. A title says which node the user meant, so those pair first; after
    that a pairing is accepted only when exactly one entry and one candidate
    remain. Two indistinguishable candidates are left unpaired rather than
    guessed between, because putting a value silently on the wrong node is
    worse than reporting that it could not be placed.
    """
    paired: list[tuple[dict, str]] = []
    remaining = list(candidates)
    unpaired: list[dict] = []

    for entry in group:
        title = entry.get("title")
        match = None
        if title:
            match = next((n for n in remaining if nodes[(subgraph, n)].get("title") == title), None)
        if match is None:
            unpaired.append(entry)
            continue
        remaining.remove(match)
        paired.append((entry, match))

    if len(unpaired) == 1 and len(remaining) == 1:
        paired.append((unpaired.pop(), remaining.pop()))

    return paired, unpaired


def _vetted(entry: dict) -> dict:
    """An entry with any state that must not be assigned to a node removed.

    Capture already refuses these keys, so a record this pack wrote never
    carries one. This is the read side, and it cannot make that assumption: a
    record is a file on disk that may have been hand-edited, shared, or produced
    somewhere else entirely. Dropping the key here means the frontend is handed
    a plan it can apply without inspecting it, which is the arrangement the rest
    of the restore relies on -- the browser applies, the server decides.
    """
    vetted = entry
    for field, unsafe in (("properties", lambda k: k in UNSAFE_KEYS), ("extra", _unsafe_extra)):
        values = vetted.get(field)
        if isinstance(values, dict) and any(unsafe(k) for k in values):
            vetted = {**vetted, field: {k: v for k, v in values.items() if not unsafe(k)}}
    return vetted


def plan_restore(payload: dict, workflow: dict) -> dict:
    """Work out which live node each saved value belongs to.

    Returns ``{"nodes": [...], "rematched": [...], "error": str | None}``. Every
    planned entry carries the id of the node it is to be written to, so the
    frontend has only to look nodes up and assign; each decision is made here,
    where the record's format and the workflow are both understood.

    The test applied is the restore's real precondition: each node holding saved
    values must still be findable. Comparing the ``structure`` digest instead --
    the obvious first idea -- asks the wrong question, and wrongly enough to
    make the feature awkward to use. That digest covers the whole graph, so
    *adding* a node invalidates a record even though an addition cannot disturb
    values already in place. Adding ``SC Load Inputs`` itself is the sharpest
    case: a record saved before the node was placed could never be loaded by it,
    a catch with no way out. Restoring into a graph that has moved on is the
    ordinary case, not the exception.

    Still refused: a record whose nodes are gone, or replaced by something a
    value cannot sensibly land on. Applying the remainder silently would leave
    the workflow matching neither the record nor what it was before.

    The residual risk accepted here is that a record from an unrelated workflow
    could apply if every node it names happened to match by id and type. That
    takes a coincidence across the whole record, and ``describe_change`` still
    reports the difference, so it is visible rather than hidden.
    """
    nodes, by_type = _index(workflow)

    claimed: set[tuple] = set()
    planned: list[dict] = []
    pending: list[dict] = []

    for entry in payload.get("nodes", []):
        if not isinstance(entry, dict):
            continue
        key = (entry.get("subgraph"), str(entry.get("id")))
        found = nodes.get(key)
        if found is not None and str(found.get("type")) == str(entry.get("type")):
            claimed.add(key)
            planned.append({**_vetted(entry), "rematched": False})
        else:
            pending.append(entry)

    groups: dict[tuple, list[dict]] = defaultdict(list)
    for entry in pending:
        groups[(entry.get("subgraph"), str(entry.get("type")))].append(entry)

    rematched: list[str] = []
    unplaced: list[str] = []
    skipped: list[str] = []
    for (subgraph, node_type), group in groups.items():
        candidates = [
            n for n in by_type.get((subgraph, node_type), []) if (subgraph, n) not in claimed
        ]
        paired, leftover = _rematch(group, candidates, nodes, subgraph)
        for entry, node_id in paired:
            claimed.add((subgraph, node_id))
            planned.append({**_vetted(entry), "id": node_id, "rematched": True})
            rematched.append(_entry_label(entry))
        for entry in leftover:
            # Only a node carrying widget *values* is worth refusing over. An
            # entry holding nothing but properties -- a Reroute's orientation,
            # a group-toggler's sort order -- is presentation this workflow can
            # live without, and blocking every value in the file because one
            # such node was deleted would be a poor trade.
            (unplaced if entry.get("values") else skipped).append(_entry_label(entry))

    error = None
    if unplaced:
        error = (
            f"holds values for nodes this workflow no longer has ({_listing(unplaced)}). "
            "Undo your changes to bring them back, or save a fresh record from this "
            "workflow as it now stands"
        )

    return {"nodes": planned, "rematched": rematched, "skipped": skipped, "error": error}


def describe_change(payload: dict, checksums: dict) -> str | None:
    """Which kind of edit, if any, the workflow has had since the record was saved.

    Returns ``"structure"`` when nodes have been added, removed or rewired,
    ``"layout"`` when only presentation has moved, and ``None`` when neither
    has. Purely advisory: all three are compatible with a clean restore, and
    naming the one that happened explains a result that might otherwise look
    partial. ``inputs`` is deliberately not reported -- the values differing is
    the entire reason for restoring.
    """
    saved = payload.get("checksums", {})
    for scope in EDIT_SCOPES:
        here, there = saved.get(scope), checksums.get(scope)
        if isinstance(here, str) and isinstance(there, str) and here != there:
            return scope
    return None
