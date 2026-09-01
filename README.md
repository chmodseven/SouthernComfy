# Southern Comfy

A supplemental pack of quality-of-life custom nodes for [ComfyUI](https://github.com/comfyanonymous/ComfyUI).

Southern Comfy is built to sit alongside a stock ComfyUI installation rather than replace parts of it. Every node follows core ComfyUI conventions for appearance, widgets, sockets, bypass and colour handling, and works under both the legacy LiteGraph renderer and the new **Nodes 2.0** (Vue) renderer.

All nodes are prefixed **`SC`** in the node search and **Add Node** menu, and live under the **SouthernComfy** category.

---

## Table of contents

- [Highlights](#highlights)
- [Installation](#installation)
- [Requirements](#requirements)
- [Node reference](#node-reference)
  - [SC Version](#sc-version)
- [Conventions](#conventions)
- [Versioning](#versioning)
- [Licence](#licence)

---

## Highlights

- **No third-party dependencies.** The pack targets a stock ComfyUI portable install and the Python standard library. Nodes that wrap another pack detect it at runtime and degrade gracefully if it is absent.
- **Renderer agnostic.** Nodes render correctly under both the legacy node renderer and Nodes 2.0.
- **Core look and feel.** Standard widgets, sockets, tooltips, per-node help pages, and the usual bypass/mute/colour behaviour.
- **Self-contained.** Nothing in this pack patches or monkey-patches ComfyUI internals, so it will not interfere with other custom node packs.

---

## Installation

### Option 1 — ComfyUI Manager

Search for **Southern Comfy** in ComfyUI Manager and install it, then restart ComfyUI.

### Option 2 — Git clone

From your ComfyUI installation's `custom_nodes` directory:

```bash
git clone https://github.com/chmodseven/SouthernComfy.git
```

Then restart ComfyUI. The folder must be named `SouthernComfy`.

### Updating

From the `custom_nodes/SouthernComfy` directory:

```bash
git pull
```

Then restart ComfyUI.

---

## Requirements

| | |
| --- | --- |
| **ComfyUI** | A recent release providing the V3 node schema API (`comfy_api.latest`). |
| **Python** | 3.10 or newer (matching ComfyUI's own requirement). |
| **Dependencies** | None. |

If the host ComfyUI is too old to provide the V3 node API, the pack loads inertly and logs an actionable message to the ComfyUI console instead of failing the start-up.

---

## Node reference

| Node | Category | Summary |
| --- | --- | --- |
| [**SC Version**](#sc-version) | `SouthernComfy/utils` | Reports the running ComfyUI version and the Southern Comfy pack version. |

---

### SC Version

Reports the version of the running ComfyUI installation and the version of this node pack. Handy when filing an issue, or when a workflow needs to record the exact environment it was authored against.

The versions are read from the live ComfyUI process at execution time, so the node always reflects the installation it is actually running in. The summary is drawn on the node body, so no downstream connection is required — but both values are also available as `STRING` outputs for use elsewhere in a workflow.

<!-- Screenshot pending: save as assets/images/sc-version.png and restore the image line below. -->
> **Screenshot pending** — an example workflow image for this node will be added at
> `assets/images/sc-version.png`.

**Inputs** — none.

**Outputs**

| Name | Type | Description |
| --- | --- | --- |
| `comfyui_version` | `STRING` | Version of the running ComfyUI installation, e.g. `0.33.4`. Falls back to `unknown` if it cannot be determined. |
| `pack_version` | `STRING` | Version of the Southern Comfy node pack, e.g. `0.0.1`. |

**Notes**

- The node is an output node, so it executes even when nothing is connected to it.
- Results are cached for the lifetime of the ComfyUI process, since a running installation cannot change its own version.

---

## Conventions

These conventions apply to every node in the pack.

| Aspect | Convention |
| --- | --- |
| **Display name** | Prefixed `SC`, e.g. `SC Version`. |
| **Node ID** | Prefixed `SC_`, e.g. `SC_Version`. Never changed after release, so saved workflows keep working. |
| **Category** | Rooted at `SouthernComfy`, with a sub-category by purpose, e.g. `SouthernComfy/utils`. |
| **Help pages** | Each node ships a markdown help page, reachable from the node's help button in ComfyUI. |
| **Third-party wrappers** | Nodes that wrap another pack check for it at import time and are only registered when it is present. |

---

## Versioning

Southern Comfy uses a `MAJOR.MINOR.ITERATION` scheme. The current version is reported by the [SC Version](#sc-version) node.

**Current version: `0.0.1`**

---

## Licence

[MIT](LICENSE) © Shannon Rowe
