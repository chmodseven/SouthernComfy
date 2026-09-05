"""Shared constants and node identifiers for the SouthernComfy pack.

Kept in one place so that definitions (node type strings, owned properties,
execution statuses, and route paths) are maintained centrally and can be safely
imported across nodes, hashing algorithms, route handlers, and run-input managers
without circular dependencies or host-API requirements.
"""

from __future__ import annotations

__all__ = [
    "CHECKSUM_EDIT_SCOPES",
    "CHECKSUM_EVERYTHING",
    "CHECKSUM_INPUTS",
    "CHECKSUM_LAYOUT",
    "CHECKSUM_ROUTE",
    "CHECKSUM_SCOPES",
    "CHECKSUM_STRUCTURE",
    "NODE_TYPE_LABEL",
    "NODE_TYPE_LOAD_INPUTS",
    "NODE_TYPE_SAVE_INPUTS",
    "NODE_TYPE_VERSION",
    "NODE_TYPE_WORKFLOW_CHECKSUM",
    "OBSERVER_NODE_TYPES",
    "OWNED_PROPERTIES",
    "PACK_NODE_TYPES",
    "RESTORE_ROUTE",
    "STATUS_ERROR",
    "STATUS_INTERRUPTED",
    "STATUS_RUNNING",
    "STATUS_SUCCESS",
    "UNRESTORABLE_TYPES",
    "VERSIONS_ROUTE",
]

# --- Node Type Identifiers ---
NODE_TYPE_LABEL = "SC_Label"
NODE_TYPE_LOAD_INPUTS = "SC_LoadInputs"
NODE_TYPE_SAVE_INPUTS = "SC_SaveInputs"
NODE_TYPE_VERSION = "SC_Version"
NODE_TYPE_WORKFLOW_CHECKSUM = "SC_WorkflowChecksum"

#: All node types declared by this pack.
PACK_NODE_TYPES: frozenset[str] = frozenset(
    {
        NODE_TYPE_LABEL,
        NODE_TYPE_LOAD_INPUTS,
        NODE_TYPE_SAVE_INPUTS,
        NODE_TYPE_VERSION,
        NODE_TYPE_WORKFLOW_CHECKSUM,
    }
)

#: Nodes that observe the workflow live (excluded from INPUTS scope hashing to avoid loops).
OBSERVER_NODE_TYPES: frozenset[str] = frozenset(
    {
        NODE_TYPE_WORKFLOW_CHECKSUM,
        NODE_TYPE_LOAD_INPUTS,
    }
)

#: Nodes whose state represents UI notes or output routing rather than restorable parameters.
UNRESTORABLE_TYPES: frozenset[str] = OBSERVER_NODE_TYPES | frozenset(
    {
        NODE_TYPE_SAVE_INPUTS,
        NODE_TYPE_LABEL,
    }
)

#: Node properties this pack owns and includes in layout checksums.
OWNED_PROPERTIES: frozenset[str] = frozenset(
    {
        "sc_text",
        "sc_font_size",
        "sc_color",
        "sc_align",
        "sc_background",
        "sc_autosize",
    }
)

# --- Checksum Scopes ---
CHECKSUM_EVERYTHING = "everything"
CHECKSUM_STRUCTURE = "structure"
CHECKSUM_LAYOUT = "layout"
CHECKSUM_INPUTS = "inputs"
CHECKSUM_SCOPES: tuple[str, ...] = (
    CHECKSUM_EVERYTHING,
    CHECKSUM_STRUCTURE,
    CHECKSUM_LAYOUT,
    CHECKSUM_INPUTS,
)
CHECKSUM_EDIT_SCOPES: tuple[str, ...] = (CHECKSUM_STRUCTURE, CHECKSUM_LAYOUT)

# --- Execution & Run Statuses ---
STATUS_RUNNING = "running"
STATUS_SUCCESS = "success"
STATUS_ERROR = "error"
STATUS_INTERRUPTED = "interrupted"

# --- HTTP Routes ---
VERSIONS_ROUTE = "/southerncomfy/versions"
CHECKSUM_ROUTE = "/southerncomfy/checksum"
RESTORE_ROUTE = "/southerncomfy/restore"
