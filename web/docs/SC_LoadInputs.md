# SC Load Inputs

Pastes the values of an earlier run back into this workflow, from a file written by
`SC Save Inputs`. Use it to return to settings you liked, to flip between test configurations, or
to undo an afternoon of fiddling in one click.

Press **load inputs…**, choose a file, and the values are restored. The `run file` row then shows
what was last loaded.

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

Every widget value the file holds, matched to the node it came from by **id and type**. That
includes nodes inside subgraphs, and it includes `control_after_generate`.

It restores *values only*. Your workflow keeps its own wiring, positions, titles and colours —
nothing about the shape of the graph is touched. That is the difference between this and dragging a
saved image onto the canvas, which replaces the whole workflow.

## When it refuses

The file is checked twice before anything is written, and a refusal changes nothing at all.

**Is it one of ours?** A `.json` in the output folder is as likely to be a prompt, a workflow, or
something unrelated. A file that is not a run-inputs record, or one written by a newer
SouthernComfy than you are running, is refused by name.

**Do its values still have somewhere to land?** Every node the file holds values for must still be
on the canvas, with the same id and the same type. That is the only requirement, because nothing
else can stop a value going back where it came from:

| Since you saved | Result |
| --- | --- |
| You edited values | **Fine.** That is the whole point |
| You moved, resized, recoloured or retitled nodes | **Fine** |
| You **added** nodes, or rewired existing ones | **Fine.** An addition cannot disturb values already there |
| You **deleted** a node that had saved values | **Refused** |
| You **changed the type** of a node that had saved values | **Refused** |

A refusal names the nodes it could not place. Either put them back, or save a fresh record from the
workflow as it now stands.

Note that adding nodes is deliberately allowed. Comparing whole-workflow checksums would be the
obvious alternative, but it asks the wrong question: it would refuse a record merely because the
graph had grown, and — since this node is itself a node — a record saved before you added
`SC Load Inputs` could never be loaded by it. Restoring into a workflow that has moved on is the
ordinary case, not the exception.

If the workflow has changed structurally, the result says so. It is a note, not a problem: it is
there to explain a restore that touched fewer nodes than you expected.

## What it tells you afterwards

A message reports how many values were restored, and anything it could not do:

- **Node types with no matching widgets.** Almost always a node pack that is not installed:
  ComfyUI substitutes a placeholder whose widgets are all named `UNKNOWN`, so nothing matches. The
  fix is to install the pack and load the file again.
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
- Works under both the legacy renderer and Nodes 2.0.
