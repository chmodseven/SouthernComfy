# SC Load Inputs

Pastes the values of an earlier run back into this workflow, from a file written by
`SC Save Inputs`. Use it to return to settings you liked, to flip between test configurations, or
to undo an afternoon of fiddling in one click.

Press **load inputs…**, choose a file, and the values are restored. The `run file` row then shows
what was last loaded.

## What this is for

These two nodes are the manual, granular half of run recording: **SC Save Inputs** is a backup of
the values a run used, and **SC Load Inputs** puts them back on demand. They are also the shared
machinery behind **SC Run History**, which is where most of this is meant to be used day to day —
an automatic list of runs you click to restore, rather than files you name and pick yourself.

They suit a **finished workflow** best: one whose shape is settled, where you are changing prompts
and tweaking a few settings between runs. That is the case they are built around, and the case they
are reliable in.

You can use them on a workflow still under construction, with nodes being added, removed and
swapped — nothing stops you, and a restore will do as much as it honestly can — but expect
refusals and partial results there. Values belong to the nodes that held them, and a graph being
rebuilt around them is exactly the situation where "which node did this belong to?" stops having a
clean answer.

## Where the files are

`SC Save Inputs` writes them under your ComfyUI installation's **`output`** folder, in whatever
subfolder its `filename_prefix` names. With the default prefix of `runs/run` that is:

```
<your ComfyUI folder>/output/runs/run_00001.json
```

The file dialog opens wherever your browser last left it, so after the first time you point it at
`output/runs` it will keep coming back there. If you have changed the prefix on `SC Save Inputs`,
look in the subfolder it names instead — and remember it also honours the date substitutions, so a
prefix like `runs/%year%-%month%-%day%/run` puts each day in its own folder.

## What it restores

Everything the file holds for each node, matched to the node it came from by **id and type**:

- **Widget values** — including `control_after_generate`, and including nodes inside subgraphs.
- **Node properties** — where most third-party state actually lives. cg-use-everywhere's settings,
  rgthree's group-toggler options, a Reroute's orientation and core's own `Node name for S&R` are
  all properties rather than widgets, so a restore that skipped them would leave a good deal of a
  workflow untouched. Where LiteGraph offers it, each one is set through `setProperty`, so a node
  that reacts to its own settings changing gets that chance.
- **Custom node state** — anything a node serialised outside the fields ComfyUI defines. Rare, but
  a node that keeps state this way has no other route back.

Provenance properties (`ver`, `cnr_id`, `aux_id`, `models`) are never restored: they say which
release of which pack a node came from, and ComfyUI maintains them itself.

Neither is anything that would change a node rather than its settings. A run file is an ordinary
JSON file, so it can be edited, shared, or written by a hosted ComfyUI somewhere else, and it is
read on that basis: saved state named after one of LiteGraph's own hooks (`onExecute`,
`onDrawForeground`, and so on) or after JavaScript's `__proto__` is refused rather than applied,
both when a file is written and again when one is read. Nothing legitimate is lost — those names
belong to the machinery of the node, not to any setting on it.

It restores *state, not shape*. Your workflow keeps its own wiring, positions, titles and colors —
nothing about the shape of the graph is touched. That is the difference between this and dragging a
saved image onto the canvas, which replaces the whole workflow.

## When it refuses

The file is checked twice before anything is written, and a refusal changes nothing at all.

**Is it one of ours?** A `.json` in the output folder is as likely to be a prompt, a workflow, or
something unrelated. A file that is not a run-inputs record is refused by name, and so is one whose
format this SouthernComfy does not read — either newer than it understands, or older than it still
supports. In that last case the fix is simply to run the workflow again and record it afresh.

**Do its values still have somewhere to land?** Every node the file holds values for must still be
on the canvas, with the same id and the same type. That is the only requirement, because nothing
else can stop a value going back where it came from:

| Since you saved | Result |
| --- | --- |
| You edited values | **Fine.** That is the whole point |
| You moved, resized, recolored or retitled nodes | **Fine** |
| You **added** nodes, or rewired existing ones | **Fine.** An addition cannot disturb values already there |
| You **deleted** a node that had saved values | **Refused** |
| You **changed the type** of a node that had saved values | **Refused** |

A refusal names the nodes it could not place, and changes nothing.

### Deleting and re-adding a node

ComfyUI never reuses a node id, so deleting a node and adding an identical one back leaves the
graph looking and behaving exactly as it did while the record still points at an id that is gone.
Refusing there would be unhelpful, and telling you to "put the node back" would be a lie — only an
**undo** recovers the old id, not re-adding.

So a value whose id has vanished may instead claim a node of the same type, in the same subgraph,
that no other saved value has claimed — but only where the choice is forced. A node title settles
it first, and after that a pairing is accepted only when exactly one saved value and one candidate
node remain. Two indistinguishable candidates are left alone rather than guessed between: putting a
value silently on the wrong node would be worse than saying it could not be placed.

When this happens the result says so — *"This graph appears to have been rebuilt…"* — and names
what was matched by type.

### Adding nodes is deliberately allowed

Comparing whole-workflow checksums would be the obvious alternative, but it asks the wrong
question: it would refuse a record merely because the graph had grown, and — since this node is
itself a node — a record saved before you added `SC Load Inputs` could never be loaded by it.
Restoring into a workflow that has moved on is the ordinary case, not the exception.

A change is still *reported*, with the distinction the checksums make available:

| Message | Meaning |
| --- | --- |
| *The structure of this workflow has changed* | Nodes have been added, removed or rewired |
| *This workflow has been rearranged … but its structure is unchanged* | Only positions, sizes, titles or colors moved |

Neither is a problem. They are there to explain a result that might otherwise look partial.

## What it tells you afterwards

A message reports how many values were restored, and anything it could not do:

- **Node types with no matching widgets.** Almost always a node pack that is not installed:
  ComfyUI substitutes a placeholder whose widgets are all named `UNKNOWN`, so nothing matches. The
  fix is to install the pack and load the file again.
- **Settings not restored** because the node holding them is gone. A node carrying only
  properties — a Reroute, a group toggler — never blocks a restore: losing its orientation is not
  worth refusing every value in the file over. It is reported and skipped.
- **Nodes not found**, or **nodes that changed type** since saving. Both are rare, because the
  structure check would normally have caught them — they mean the graph was edited between the
  check and the click.
- **Widgets that will advance again.** See below.

## Randomised seeds

A restored seed does not necessarily stay restored. Any widget set to `randomize`, `increment` or
`decrement` is advanced by ComfyUI the instant you press Run, so the value you just put back is
replaced before the run begins — the restore looks as though it silently failed.

The node warns you when it restores one, and names it. Set the widget to `fixed` if you want the
seed you restored to be the seed that runs.

## Notes

- The file is read in your browser and never uploaded. Choosing a file changes nothing until the
  checks pass.
- Deciding is done by the server, not the browser, so the rules a record is written by and read by
  are the same rules. Applying the values has to happen in the browser: ComfyUI's execution is
  pull-based, and no node can write into another node's widgets.
- `SC Save Inputs`' own `filename_prefix` is never restored. Returning to an old set of values
  should not quietly change where your future runs get written.
- This node contributes no values of its own to the `inputs` checksum, and none to a file saved by
  `SC Save Inputs`. The file it last loaded is a note about what you did, not a setting a run uses
  — and counting it would mean a restored workflow could never match the checksum of the file it
  was restored from.
- Browsers hand over a file's name but never its path, so the `run file` row cannot be used to
  reload the same file. Press the button again and pick it.
- **Every result stays on screen until you dismiss it** with its close button, and is written to
  the browser console as well — so a message you have closed, or one from earlier in the session,
  can still be read back. Open the console with F12.
- Works under both the legacy renderer and Nodes 2.0.
