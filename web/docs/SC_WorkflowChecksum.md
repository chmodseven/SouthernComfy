# SC Workflow Checksum

Produces a deterministic checksum of the workflow the node is sitting in, so you can tell whether
a workflow, its values, or both have changed.

The value on the node face updates live as you edit the canvas — you do not need to run anything.
The output socket carries the full digest for downstream nodes.

## Scope

| Scope | Covers | Changes when |
| --- | --- | --- |
| `everything` | Structure, layout and values | Any change at all |
| `structure` | Nodes, wiring, bypass/mute state | You add, delete, rewire or bypass a node |
| `layout` | The above plus positions, sizes, titles, colours, collapsed state and groups | Also when you move, resize, recolour or group nodes |
| `inputs` | Widget values only | You edit any value — or add/remove a node that had values |

`structure` is the one to compare before restoring saved input values into a workflow, because it
changes precisely when those saved values would no longer line up.

Two behaviours worth knowing about the `inputs` scope:

- It **ignores node identity**. Deleting a node and re-adding an identical one, or packing a
  selection into a subgraph and unpacking it again, renumbers nodes without changing any value —
  so the digest returns to exactly what it was. `structure` and `layout` still change, because
  structurally those really are different graphs.
- It **reaches inside subgraphs**. Packing nodes away moves them into a subgraph definition; their
  values keep counting. The subgraph's own instance node is skipped, since the widgets promoted
  onto it are copies of ones still held by the nodes inside.


## Output

| Output | Type | Meaning |
| --- | --- | --- |
| `CHECKSUM` | `STRING` | Full SHA-256 hex digest for the selected scope |

The node face shows as much of the digest as fits, trailed by `...` to make clear there is more.
Widen the node to reveal more of it: at full width the whole digest is shown and the `...`
disappears; narrowing it again brings the `...` back. The socket always carries all 64 characters,
whatever size the node is.

## Randomised seeds and the run

Any widget set to **randomize** or **increment** — a KSampler seed, typically — is advanced by
ComfyUI the instant you press Run, *after* the workflow has been submitted. So on any graph with
such a widget:

- The `inputs` and `everything` scopes change with **every run**, even if you touch nothing.
- The value shown on the node face is one step **ahead** of the value its output sent downstream.
  The face describes the workflow as it is now; the output describes the workflow that actually
  ran — both are correct, they are answering different questions.

Set those widgets to `fixed` if you need the displayed and emitted values to agree. `structure` and
`layout` are unaffected either way, since a seed is neither wiring nor presentation.

## Deliberately ignored

Three things never affect any scope, because they change for reasons unrelated to the workflow's
content and would otherwise make two identical workflows appear different:

- **Node `properties`**, apart from those SouthernComfy owns. As well as provenance (`ver`,
  `cnr_id`) and genuine settings, nodes stash *runtime results* there — Save 3D Model writes the
  last saved filename and a live camera position after every execution, which would change
  `layout` on every run on its own. What a node actually presents has its own fields and is
  hashed from those.
- **The computed execution `order`** — ComfyUI recalculates it per run and breaks ties
  differently, so it drifts with nothing changed. What it encodes is the wiring, already hashed.
- **`floatingLinks`** — a link with a dangling end. The two forms a workflow arrives in do not
  always agree on this field, so hashing it would risk the displayed and executed digests
  disagreeing. It cannot affect execution, and removing the real link is caught by `structure`.

Native reroute waypoints and the Parameters-sidebar favourites **are** hashed, as `layout`.
- **Link ids** — reassigned freely by the frontend when links are rebuilt, without the wiring
  itself changing. The endpoints are hashed instead.
- **Canvas pan and zoom** — cosmetic in the strictest sense, but it changes merely from looking
  around a workflow, which would leave `layout` never settling.

An `SC Workflow Checksum` node contributes no values of its own to the `inputs` scope. It observes
the workflow rather than configuring it, and hashing the digest it displays would make the result
self-referential. Adding or removing one still counts as a structural change.

## Notes

- The checksum is computed on the server, so the node and any other SouthernComfy node that needs a
  digest always agree.
- Two workflows with the same `structure` digest are wired the same way, whatever has been typed
  into them or wherever the nodes have been dragged.
- Running the node is not required for the displayed value, but the output socket is only produced
  on a run, like any other node.
