# SC Save Inputs

Writes every input value in the workflow to a JSON file in the output folder, each time the
workflow runs. `SC Load Inputs` reads one of those files back and pastes the values into a
workflow, so a run you liked can be returned to later.

Drop the node anywhere on the canvas. It takes no inputs and produces no outputs, and nothing needs
to be wired to it: the values it records reach it as metadata describing the whole prompt, not as
inputs of its own. It runs once per run, wherever it sits.

## Input

| Input | Type | Meaning |
| --- | --- | --- |
| `filename_prefix` | `STRING` | Where to write the file, relative to the output folder |

The prefix works exactly as **Save Image**'s does — the same code produces it — so anything you
already know about naming saved images applies here.

- `runs/run` (the default) writes `output/runs/run_00001.json`, then `run_00002.json`, and so on.
- The number is chosen by looking at what is already in the folder, so it keeps counting up across
  restarts and never overwrites an earlier run.
- The date and time substitutions work too: `%year%`, `%month%`, `%day%`, `%hour%`, `%minute%`,
  `%second%`. A prefix of `runs/%year%-%month%-%day%/run` starts a fresh numbered set each day.
- A prefix that would write outside the output folder is refused, as it is on Save Image.

## What is in the file

| Key | Contents |
| --- | --- |
| `format`, `format_version` | Identify the file as one of ours, and which shape it is in |
| `pack_version` | The SouthernComfy version that wrote it |
| `saved_at` | Local time of the run, with its UTC offset |
| `checksums` | All four workflow checksums — `everything`, `structure`, `layout`, `inputs` |
| `nodes` | Every widget value, node by node. This is the half that gets restored |
| `resolved` | The literal values the backend actually received |

### `nodes` — the restorable half

One entry per node that holds any value, carrying the node's `id`, its `type`, its `title` if it
has been renamed, and its `values`. Values are keyed by widget name wherever the frontend recorded
them that way; older workflows may only have them in widget order, and both forms are read back
correctly.

Nodes inside a subgraph are captured too, with a `subgraph` field saying which body they came from.
The subgraph's own instance node is skipped, because the widgets promoted onto it are copies of
ones still held by the nodes inside — counting both would record every packed value twice.

An `SC Workflow Checksum` node contributes no values here. It shows a digest it worked out from the
workflow rather than anything you chose, so saving it would preserve a stale reading and restoring
it would overwrite a live one.

### `resolved` — what actually ran

The same run seen from the backend: the literal values each node was given. Inputs that arrived
over a link are left out, since those are other nodes' outputs rather than anything you set.

This half is never restored — it is the record of what happened. It is worth having because it can
legitimately differ from `nodes`: a widget converted into an input still carries its last typed
value in the workflow, while `resolved` shows the value that actually came down the wire. Purely
frontend controls such as `control_after_generate` appear only in `nodes`, because the backend
never sees them.

## Checksums, and which one matters

All four are recorded so the file can answer any of the questions they answer, without needing the
workflow itself. Their uses:

- **`structure`** decides whether the file still fits a workflow. It covers the nodes and their
  wiring and nothing else, so it changes precisely when saved values would no longer line up — and
  stays put when you have merely moved nodes about or edited values, which is the normal state of
  affairs when restoring. `SC Load Inputs` compares this one.
- **`layout`** is the strict comparison: are these two workflows identical in every respect except
  the values typed into them?
- **`inputs`** fingerprints the values alone, so two runs can be told apart at a glance.
- **`everything`** is the catch-all.

See `SC Workflow Checksum` for what each scope covers in detail.

## Notes

- The node re-runs on every execution rather than being cached. It has to: ComfyUI decides what to
  cache from a node's declared inputs, and this node's only declared input is where to write, while
  what it records is the whole workflow. Cached, it would silently record nothing after the first
  run.
- Two of these nodes in one workflow write two files, even with the same prefix.
- A run started straight from the API rather than from the browser carries no workflow metadata.
  The file is still written, with the `resolved` half filled in and `nodes` empty.
- The file is written when the node executes, and records the prompt **as submitted**. Any widget
  set to `randomize` or `increment` is advanced by ComfyUI the instant you press Run, so what is
  recorded is the value that actually ran — not the one now showing on the canvas.
