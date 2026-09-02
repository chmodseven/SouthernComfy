# SC Load Inputs

Pastes the values of an earlier run back into this workflow, from a file written by
`SC Save Inputs`. Use it to return to settings you liked, to flip between test configurations, or
to undo an afternoon of fiddling in one click.

Press **load inputs…**, choose a file — they are written to `output/runs/` by default — and the
values are restored. The `run file` row then shows what was last loaded.

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

**Does it still fit?** The file's `structure` checksum is compared against this workflow's.
`structure` covers the nodes, their types and their wiring — and nothing else — so:

| Since you saved | Result |
| --- | --- |
| You edited values | **Fits.** That is the whole point |
| You moved, resized, recoloured or retitled nodes | **Fits.** None of that is structure |
| You added, deleted, rewired or bypassed a node | **Refused.** The values no longer line up |

A refusal names both digests so you can see they differ. Either put the workflow back the way it
was, or use a record saved from the workflow as it is now.

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
- This node contributes no values of its own to the `inputs` checksum, and none to a file saved by
  `SC Save Inputs`. The file it last loaded is a note about what you did, not a setting a run uses
  — and counting it would mean a restored workflow could never match the checksum of the file it
  was restored from.
- Browsers hand over a file's name but never its path, so the `run file` row cannot be used to
  reload the same file. Press the button again and pick it.
- Works under both the legacy renderer and Nodes 2.0.
