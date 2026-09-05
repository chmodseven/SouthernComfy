"""Deterministic checksums over a ComfyUI workflow.

ComfyUI has no workflow checksum of its own -- its hashing is all over file
contents -- so this module defines one. It is deliberately free of ComfyUI
imports: it takes a plain workflow dictionary (the structure ComfyUI saves to
``.json`` and embeds in output metadata) and returns hex digests. That keeps it
reusable by any node in the pack, and by the HTTP route that feeds live values
to the frontend, without duplicating the algorithm.

Four scopes are produced, answering four different questions:

``STRUCTURE``
    Has the *meaning* of the graph changed? Nodes, their types, their execution
    mode, and how they are wired. Moving a node or editing a value does not
    change it. This is the scope to test before pasting saved input values into
    a workflow, because it is exactly the thing that would invalidate them.

``LAYOUT``
    ``STRUCTURE`` plus presentation: positions, sizes, titles, colors,
    collapsed state and groups. For asking "are these two workflows identical
    in every respect except the values typed into them?".

``INPUTS``
    The widget values alone. Independent of wiring, though adding or removing a
    node necessarily changes the set of values and so changes this digest too.

``EVERYTHING``
    All of the above: any change at all to the workflow.

Subgraphs
---------
Every scope walks subgraph bodies as well as the top level. Packing a selection
into a subgraph moves those nodes into ``definitions.subgraphs`` and leaves a
single instance node behind whose *type* is the subgraph's freshly minted UUID,
carrying promoted copies of widgets that still live on the nodes inside. Reading
only the top level would therefore lose the packed values entirely, and counting
the instance node would double them.

Deliberate exclusions
---------------------
These are excluded from every scope because they change for reasons unrelated to
the workflow's content, and including them would produce digests that differ
between two genuinely identical workflows:

* Every node ``property`` except those this pack owns -- see
  ``_OWNED_PROPERTIES`` for why the field cannot be trusted as a whole.
  That covers provenance (``ver``, ``cnr_id``, ``aux_id``), which would
  invalidate every saved checksum the moment a node pack updated, and equally
  the runtime results some nodes write there after each execution.
* Link ids -- reassigned freely by the frontend when links are rebuilt, without
  the wiring itself changing. The endpoints are hashed instead.
* ``extra.ds`` -- the canvas pan and zoom. Cosmetic in the strictest sense, but
  it changes merely from looking around a workflow, which would make
  ``LAYOUT`` useless in practice.
* ``extra.frontendVersion`` -- present only in the workflow attached to a
  prompt, so hashing it would make the frontend and backend disagree outright.
* ``floatingLinks`` -- links with a dangling end. Deliberately left out for the
  same reason: ``graph.serialize()`` emits the key and the prompt's workflow
  does not, so a graph that had one would hash differently on each side. The
  cost is only a missed change, and a floating link cannot affect execution;
  the real link's removal is caught by ``STRUCTURE`` regardless.
* Node ids, in the ``INPUTS`` scope only -- see ``_inputs_payload``.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Iterator
from typing import Any

from .constants import (
    CHECKSUM_EVERYTHING,
    CHECKSUM_INPUTS,
    CHECKSUM_LAYOUT,
    CHECKSUM_SCOPES,
    CHECKSUM_STRUCTURE,
    OBSERVER_NODE_TYPES,
    OWNED_PROPERTIES,
    PACK_NODE_TYPES,
)

__all__ = [
    "CHECKSUM_SCOPES",
    "OBSERVER_NODE_TYPES",
    "Scope",
    "compute_all",
    "compute_checksum",
    "iter_nodes",
    "subgraph_ids",
]

Scope = str

#: A saved link is ``[link_id, origin_id, origin_slot, target_id, target_slot,
#: type]``. Anything shorter is not one and is skipped.
_LINK_FIELDS = 6


def _canonical_json(payload: Any) -> str:
    """Serialise ``payload`` so that equal content always yields equal text.

    ``sort_keys`` removes dictionary ordering as a variable, the compact
    separators remove whitespace as one, and ``default=str`` keeps a stray
    non-serialisable value from raising rather than merely differing.
    """
    return json.dumps(
        payload,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        default=str,
    )


def _digest(payload: Any) -> str:
    return hashlib.sha256(_canonical_json(payload).encode("utf-8")).hexdigest()


def _nodes(container: dict) -> list[dict]:
    nodes = container.get("nodes")
    return [n for n in nodes if isinstance(n, dict)] if isinstance(nodes, list) else []


def _subgraph_definitions(workflow: dict) -> list[dict]:
    """Subgraph bodies, stored flat at ``definitions.subgraphs``.

    Nesting needs no recursion: a subgraph used inside another still has its
    body in this one list, referenced from the parent by id.
    """
    definitions = workflow.get("definitions")
    subgraphs = definitions.get("subgraphs") if isinstance(definitions, dict) else None
    return [s for s in subgraphs if isinstance(s, dict)] if isinstance(subgraphs, list) else []


def subgraph_ids(workflow: dict) -> frozenset[str]:
    """Ids of every defined subgraph, which double as the *type* of its instances."""
    return frozenset(
        str(s.get("id")) for s in _subgraph_definitions(workflow) if s.get("id") is not None
    )


def iter_nodes(workflow: dict) -> Iterator[tuple[dict, str | None]]:
    """Every node in the workflow, paired with the id of the subgraph holding it.

    The second element is ``None`` for a node at the top level. Packing a
    selection into a subgraph moves those nodes out of the top-level ``nodes``
    array and into a definition, so walking only the top level would lose them
    the moment they were packed away.

    Public because reading values out of a workflow has to walk it the same way
    hashing does -- ``southern_comfy.run_inputs`` needs the container id as well
    as the node, to say where a captured value came from.
    """
    for node in _nodes(workflow):
        yield node, None
    for subgraph in _subgraph_definitions(workflow):
        container = subgraph.get("id")
        container = str(container) if container is not None else None
        for node in _nodes(subgraph):
            yield node, container


def _all_nodes(workflow: dict) -> list[dict]:
    """Every node in the workflow, including those inside subgraph bodies."""
    return [node for node, _ in iter_nodes(workflow)]


def _all_links(workflow: dict) -> list:
    """Every link, from the top level and from inside each subgraph body."""
    links: list = []
    for container in (workflow, *_subgraph_definitions(workflow)):
        found = container.get("links")
        if isinstance(found, list):
            links.extend(found)
    return links


def _widget_values(node: dict) -> Any:
    """Return a node's widget values in whichever form the frontend saved them.

    Newer frontends may write ``widgets_values`` as a list or as a name-keyed
    mapping. A node that opts out of serialisation (``serialize_widgets =
    false``, as ``SC Version`` does) has neither, which is not an error.
    """
    for key in ("widgets_values", "widgets_values_named"):
        if key in node:
            values = node[key]
            # A node with no widgets is written as `[]` by one serialisation
            # and as `null` by the other -- ``PreviewImage`` does exactly this.
            # Both mean "no values", so both must normalise to the same thing
            # or the node contributes to the digest in one form and not the
            # other.
            return values if values not in (None, [], {}) else None
    return None


def _slot_names(workflow: dict) -> dict[str, tuple[list, list]]:
    """Map each node id to its input and output slot names.

    Used to hash link endpoints by name rather than by index. Slot *indices*
    are not stable across the two forms a workflow arrives in: the frontend's
    ``graph.serialize()`` keeps a placeholder entry in ``inputs`` for every
    widget that could be converted to an input, while the workflow attached to
    a queued prompt strips them. Removing those entries renumbers every real
    input after them, so the same wiring hashes differently depending on which
    form it came from -- the frontend would disagree with the backend on any
    graph using widget inputs, while agreeing on simpler ones. Slot names
    survive both forms unchanged.
    """
    names: dict[str, tuple[list, list]] = {}
    for node in _all_nodes(workflow):
        slots = []
        for key in ("inputs", "outputs"):
            entries = node.get(key)
            slots.append(
                [e.get("name") if isinstance(e, dict) else None for e in entries]
                if isinstance(entries, list)
                else []
            )
        names[str(node.get("id"))] = (slots[0], slots[1])
    return names


def _slot_label(slots: list, index: Any) -> Any:
    """Name of a slot, falling back to its index when there is no name."""
    if isinstance(index, int) and 0 <= index < len(slots) and slots[index] is not None:
        return slots[index]
    return index


def _structure_payload(workflow: dict) -> list:
    """Nodes and wiring only: what the graph *means* when executed.

    Node ids are kept here, unlike in the inputs scope, so that repackaging the
    same nodes -- into a subgraph, or by deleting and re-adding one -- registers
    as the structural change it is.
    """
    nodes = [
        {
            "id": str(node.get("id")),
            "type": node.get("type"),
            # Bypass and mute change what actually runs, so they are structural
            # rather than cosmetic despite being toggled from the node's menu.
            "mode": node.get("mode", 0),
        }
        for node in _all_nodes(workflow)
    ]
    nodes.sort(key=lambda n: (n["id"], str(n.get("type")), str(n.get("mode"))))

    slots = _slot_names(workflow)
    wiring = []
    for link in _all_links(workflow):
        # Saved as [link_id, origin_id, origin_slot, target_id, target_slot,
        # type]. The leading id is omitted: it is reassigned freely by the
        # frontend without the wiring having changed. Slots are recorded by
        # name rather than index -- see _slot_names for why.
        if isinstance(link, (list, tuple)) and len(link) >= _LINK_FIELDS:
            origin, target = str(link[1]), str(link[3])
            wiring.append(
                [
                    origin,
                    _slot_label(slots.get(origin, ([], []))[1], link[2]),
                    target,
                    _slot_label(slots.get(target, ([], []))[0], link[4]),
                    link[5],
                ]
            )
    wiring.sort(key=lambda w: (str(w[0]), str(w[1]), str(w[2]), str(w[3]), str(w[4])))

    return [nodes, wiring]


def _stable_properties(node: dict) -> dict:
    """Only the node properties this pack owns on its own nodes; see ``OWNED_PROPERTIES``."""
    node_type = str(node.get("type", ""))
    if node_type not in PACK_NODE_TYPES:
        return {}
    properties = node.get("properties")
    if not isinstance(properties, dict):
        return {}
    return {k: v for k, v in properties.items() if k in OWNED_PROPERTIES}


def _layout_payload(workflow: dict) -> list:
    """Presentation only: where things sit, how they look, how they are set up."""
    nodes = [
        {
            "id": str(node.get("id")),
            "pos": node.get("pos"),
            "size": node.get("size"),
            "flags": node.get("flags") or {},
            # `order` is deliberately absent. It is the computed execution
            # order, not presentation: ComfyUI recomputes it per run and breaks
            # ties differently, so it drifts between runs with nothing changed
            # -- fifty nodes were seen shifting by one in a single run. What it
            # encodes is the wiring, which `structure` already hashes.
            "title": node.get("title"),
            "color": node.get("color"),
            "bgcolor": node.get("bgcolor"),
            "properties": _stable_properties(node),
        }
        for node in _all_nodes(workflow)
    ]
    nodes.sort(key=lambda n: n["id"])

    groups = [workflow.get("groups") if isinstance(workflow.get("groups"), list) else []]
    for subgraph in _subgraph_definitions(workflow):
        found = subgraph.get("groups")
        groups.append(found if isinstance(found, list) else [])

    # Native reroute waypoints. Presentation, not wiring: they are points a link
    # is drawn through, and the link's endpoints are unchanged by them. Sorted,
    # because their order in the array carries no meaning.
    reroutes = []
    for container in (workflow, *_subgraph_definitions(workflow)):
        found = (container.get("extra") or {}).get("reroutes") or container.get("reroutes")
        if isinstance(found, list):
            reroutes.extend(found)
    reroutes.sort(key=_canonical_json)

    # Core's Parameters-sidebar favourites, stored in the workflow. Order is
    # kept: the sidebar lets the user reorder them deliberately.
    favourites = (workflow.get("extra") or {}).get("favoritedWidgets") or {}

    return [nodes, groups, reroutes, favourites]


def _inputs_payload(workflow: dict) -> list:
    """Widget values only, independent of how the graph is put together.

    Node ids are deliberately **not** included, and the result is sorted rather
    than left in graph order. The same values must digest the same however the
    nodes carrying them have been shuffled -- deleting a node and re-adding an
    identical one, or packing a selection into a subgraph and unpacking it
    again, both renumber nodes without changing a single value. Only the node
    *type* travels with each set of values, so a value moving between different
    kinds of node still registers.

    Two consequences worth knowing: two identical nodes are indistinguishable
    here (correct -- the values really are the same), and adding or deleting a
    node that carries values does change this digest, since the set of values in
    the workflow genuinely changed.
    """
    packed = subgraph_ids(workflow)

    entries = []
    for node in _all_nodes(workflow):
        node_type = node.get("type")
        # A subgraph *instance* node carries promoted copies of widgets that
        # live on the nodes inside it, and its type is a freshly minted UUID.
        # Both the duplicate values and the volatile type must stay out.
        if node_type in OBSERVER_NODE_TYPES or str(node_type) in packed:
            continue
        values = _widget_values(node)
        if values is not None:
            entries.append([node_type, values])

    entries.sort(key=lambda e: (str(e[0]), _canonical_json(e[1])))
    return entries


def compute_all(workflow: dict | None) -> dict[Scope, str]:
    """Return every scope's digest for ``workflow``.

    An absent or malformed workflow yields the digests of an empty one rather
    than raising, so a node can still report a stable value when ComfyUI did
    not supply workflow metadata (an API-submitted prompt, for instance).
    """
    if not isinstance(workflow, dict):
        workflow = {}

    structure = _structure_payload(workflow)
    layout = _layout_payload(workflow)
    inputs = _inputs_payload(workflow)

    return {
        CHECKSUM_STRUCTURE: _digest(structure),
        CHECKSUM_LAYOUT: _digest([structure, layout]),
        CHECKSUM_INPUTS: _digest(inputs),
        CHECKSUM_EVERYTHING: _digest([structure, layout, inputs]),
    }


def compute_checksum(workflow: dict | None, scope: Scope = CHECKSUM_EVERYTHING) -> str:
    """Return one scope's digest. Unknown scopes fall back to ``CHECKSUM_EVERYTHING``."""
    return compute_all(workflow).get(scope) or compute_all(workflow)[CHECKSUM_EVERYTHING]
