# SC Save Inputs

Writes every input value in the workflow to a JSON file in the output folder, each time the
workflow runs. `SC Load Inputs` reads one of those files back and pastes the values into a
workflow, so a run you liked can be returned to later.

Drop the node anywhere on the canvas. It takes no inputs and produces no outputs, and nothing needs
to be wired to it: the values it records reach it as metadata describing the whole prompt, not as
inputs of its own. It runs once per run, wherever it sits.

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

## Inputs

| Input | Type | Meaning |
| --- | --- | --- |
| `filename_prefix` | `STRING` | Where to write the file, relative to the output folder |
| `description` | `STRING` | Optional one-line note about this run |

The prefix works exactly as **Save Image**'s does — the same code produces it — so anything you
already know about naming saved images applies here.

- `runs/run` (the default) writes `output/runs/run_00001.json`, then `run_00002.json`, and so on.
- The number is chosen by looking at what is already in the folder, so it keeps counting up across
  restarts and never overwrites an earlier run.
- The date and time substitutions work too: `%year%`, `%month%`, `%day%`, `%hour%`, `%minute%`,
  `%second%`. A prefix of `runs/%year%-%month%-%day%/run` starts a fresh numbered set each day.
- A prefix that would write outside the output folder is refused, as it is on Save Image.

`description` is your own note about the run — *"denoise down to 0.9"*, *"second LoRA at 0.4"*. It
is stored at the top of the file and shown when the file is loaded, and it is what a run-history
list has to put in its description column. Deliberately a single line: it needs to stay readable
at a glance in a list, so it is a label rather than a paragraph.

## When the file is written

**Twice: once as the run starts, once when it ends.**

ComfyUI offers no way for a node to run after everything else — execution order follows the
dependency graph, and a node with nothing wired to it has no way to depend on the rest — and it
offers custom nodes no post-execution hook. So this node writes the record as it executes, which is
already the right moment for the inputs (they are fixed once the run is queued), and then waits for
the run to finish and writes the file again with the outcome.

Two things follow, both deliberate:

- If ComfyUI is closed or crashes mid-run, the file still exists with everything but the outcome,
  and its `run.status` stays `running` so you can tell.
- The file's number is claimed immediately, so two runs queued back to back cannot both take the
  same one.

## What is in the file

| Key | Contents |
| --- | --- |
| `format`, `format_version` | Identify the file as one of ours, and which shape it is in. Records written in a format this version no longer reads are refused rather than half-understood |
| `pack_version` | The SouthernComfy version that wrote it |
| `description` | Your one-line note, if you set one |
| `saved_at` | Local time the run started, with its UTC offset |
| `run` | How the run went — see below |
| `checksums` | All four workflow checksums — `everything`, `structure`, `layout`, `inputs` |
| `nodes` | Every node's restorable state. This is the half that gets restored |
| `resolved` | The literal values the backend actually received |

### `run` — how it went

| Field | Meaning |
| --- | --- |
| `status` | `running`, `success`, `error` or `interrupted` |
| `started_at`, `ended_at` | Local times, with offsets |
| `duration_seconds` | Wall clock, from ComfyUI's own execution timestamps |
| `cached_nodes` | How many nodes were served from cache rather than run |
| `error` | Failing node and exception, when the run failed |
| `memory_at_start`, `memory_at_end` | System RAM and per-device VRAM, free and total, in bytes |

`cached_nodes` is worth a look when comparing runs: a run that reused most of its graph is not
comparable with one that computed all of it.

There is **no per-node timing**, because ComfyUI does not record any — it timestamps the run's
start and end and nothing between. A breakdown of where the time went would have to be measured
separately rather than read back from ComfyUI.

### `nodes` — the restorable half

One entry per node holding any state, carrying the node's `id`, its `type`, its `title` if it has
been renamed, and up to three kinds of state:

- **`values`** — the widget values, keyed by widget name wherever the frontend recorded them that
  way. Older workflows may only have them in widget order; both forms are read back correctly.
- **`properties`** — the node's own `properties`. This matters more than it sounds: most
  third-party state lives here rather than in widgets. Across a 26-workflow sample it held every
  pack-specific setting that turned up — cg-use-everywhere's `ue_properties`, rgthree's Fast Groups
  settings, Reroute's orientation, core's own `Node name for S&R` — while exactly one such setting
  appeared anywhere else. Capturing widgets alone would leave a real part of a workflow behind.
- **`extra`** — anything else a node wrote into its serialised form. Rare, but a node that keeps
  state this way has no other route back.

The `ver`, `cnr_id`, `aux_id` and `models` properties are **not** captured. They record which
release of which pack a node came from, and ComfyUI maintains them itself; writing a saved one back
would misstate a node's provenance.

Nodes inside a subgraph are captured too, with a `subgraph` field saying which body they came from.
The subgraph's own instance node is skipped, because the widgets promoted onto it are copies of
ones still held by the nodes inside — counting both would record every packed value twice.

Three node types contribute nothing here, because what they hold is this pack's own bookkeeping
rather than anything a run uses:

- **`SC Workflow Checksum`** shows a digest it worked out from the workflow rather than anything you
  chose, so saving it would preserve a stale reading and restoring it would overwrite a live one.
- **`SC Load Inputs`** notes which file it last restored from.
- **This node's own `filename_prefix`** — restoring it would silently redirect where your *future*
  runs are written, which is not what anyone means by "put my old settings back". It is still
  recorded under `resolved`, since the run genuinely used it. (`description` is recorded in full,
  since it describes this run.)

### `resolved` — what actually ran

The same run seen from the backend: the literal values each node was given. Inputs that arrived
over a link are left out, since those are other nodes' outputs rather than anything you set.

This half is never restored — it is the record of what happened. It is worth having because it can
legitimately differ from `nodes`: a widget converted into an input still carries its last typed
value in the workflow, while `resolved` shows the value that actually came down the wire. Purely
frontend controls such as `control_after_generate` appear only in `nodes`, because the backend
never sees them.

## Checksums

All four are recorded so the file can answer any of the questions they answer, without needing the
workflow itself:

- **`structure`** says whether the graph itself has changed — nodes, types and wiring. `SC Load
  Inputs` reports a difference as a note, but does not refuse over it.
- **`layout`** is the strict comparison: identical in every respect except the values?
- **`inputs`** fingerprints the widget values alone, so two runs can be told apart at a glance.
- **`everything`** is the catch-all.

Note the checksums cover **widget values, not properties**. Node properties are captured and
restored, but deliberately not hashed: they are an unpoliced grab-bag in which packs also keep
runtime results, and hashing them made the `layout` digest move on every run of any workflow
containing one. See `SC Workflow Checksum` for that story.

## Notes

- The node re-runs on every execution rather than being cached. It has to: ComfyUI decides what to
  cache from a node's declared inputs, while what this records is the whole workflow. Cached, it
  would silently record nothing after the first run.
- Two of these nodes in one workflow write two files, even with the same prefix.
- A run started straight from the API rather than from the browser carries no workflow metadata.
  The file is still written, with the `resolved` half filled in and `nodes` empty.
- The record describes the prompt **as submitted**. Any widget set to `randomize` or `increment` is
  advanced by ComfyUI the instant you press Run, so what is recorded is the value that actually ran
  — not the one now showing on the canvas.
