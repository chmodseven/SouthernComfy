# SC Timer

A run timer on the canvas, with no title bar and no badge — a stopwatch that starts itself when you
press Run and stops on the run's real duration.

It reads `00:00.000` until something runs, counts up in real time while it does, and settles on the
final time when the run ends. Beside the reading is a small light saying how the last run finished.

## Using it

Add it and leave it. There is nothing to wire, nothing to configure, and nothing to press: the node
declares no inputs and no outputs, so it never joins the execution graph. Drag it by anywhere on its
body — with no title bar, the whole node is the handle.

## The reading

`MI:SS.fff` — minutes, seconds and milliseconds, the milliseconds in a smaller face so the part you
are actually watching stays the part you read first.

The node grows a segment only when a run is long enough to need one, and **widens itself to fit**:
`HH:MI:SS.fff` past an hour, `DD:HH:MI:SS.fff` past a day. Measured at the default point size, the
node goes from 155px wide to 190 at an hour and 226 at a day, and back again on the next short run.
The padding either side stays the same throughout, so it never looks lopsided. Most runs never see
either segment, so the timer usually stays as narrow as it can.

The digits are drawn in the platform's monospace face, so they are all the same width and the
numbers do not shuffle about as they count.

## The state light

| Light | Means |
| --- | --- |
| **Spinner** | A run is in progress. It turns once a second. |
| **Grey bubble** | No run has happened yet with this workflow open. The timer reads `00:00.000`. |
| **Green bubble** | The last run finished successfully, in the time shown. |
| **Yellow bubble** | The last run was cancelled, at the time shown. |
| **Red bubble** | The last run failed, at the time shown. |
| **Blue bubble** | The connection to ComfyUI was lost while a run was going. The timer is paused where it got to and the run's result is unknown. |

A red light also appears in two cases where a run does not go as asked:

- **It could not be started at all.** You press Run and ComfyUI refuses the prompt — a required
  input unplugged, a chosen model missing. The reading stays at `00:00.000`, since nothing executed.
- **Only part of it ran.** ComfyUI needs just one output to be valid: if a workflow has another
  branch that still works, it drops the broken one, queues the rest, and reports success on what it
  did run. The console says `Prompt executed in 0.02 seconds` and an error toast appears at the same
  moment. The timer shows the real duration of the part that ran, in red, rather than calling that a
  success.

Both carry the same explanation ComfyUI puts in its error toast, including which node is at fault.

**Hover over the light** for a sentence saying which of those it is. On a red one that sentence also
carries the node that failed and the error ComfyUI reported, so you can see what went wrong without
going to the console.

The wording tells the three red cases apart: *"The last run failed after …"* means it started and
died part-way through; *"The last run could not be started"* means ComfyUI never accepted it; and
*"finished what it could … but ComfyUI refused part of the workflow"* means only some of it ran.

## How accurate is it?

The final time is **ComfyUI's own**, not the browser's. When a run starts and when it ends, the
server sends a message stamped with its own millisecond clock — the same pair of stamps the run
history is built from — and the number left on the node is the difference between them. It agrees
with the `Prompt executed in …` line in the console to within the moment between the queue picking
the prompt up and the executor announcing it.

Only the *live* count while a run is going is the browser's, because there is nothing else it could
be: the server says nothing between the two ends. It is measured with a monotonic clock, so changing
the system time or crossing a daylight-saving boundary mid-run cannot disturb it, and it is replaced
by the server's answer the moment the run finishes.

## Does it slow the run down?

No, and it is built so that it cannot.

- **It never executes.** With no inputs and no outputs it is never scheduled, so it takes none of
  the time the samplers are using. It is not in the run it is timing.
- **It never polls.** Nothing here runs on a timer. Until you press Run the node is genuinely idle.
- **It updates on animation frames**, which are the browser's own spare moments: a frame that cannot
  be afforded is simply not delivered, and none are delivered at all while the tab is in the
  background. A frame lost that way costs a millisecond on screen and nothing to the run.
- **It never redraws the canvas while counting.** Only the two small pieces of text change, and only
  when they have actually changed.
- **The spinner is turned from that same frame loop**, twelve steps to the revolution -- so it
  costs twelve style writes a second and stops dead the moment the run does.

If ComfyUI goes away mid-run — the server killed, or the connection dropped — the timer stops where
it was rather than counting on forever, and the light says the result is unknown. If the run survives
and reports back, the timer finishes properly with the server's own times however long that took.

## Appearance

Right-click the timer:

| Menu item | Does |
| --- | --- |
| **SC Timer Font Size** | The usual point sizes, 8 to 72, with a tick beside the current one. **Custom…** opens a slider for anything from 4 to 200, applying as you drag; `Escape` puts back the size you started at. |
| **SC Timer Text Color** | A swatch and a hex box for the digits, at the pointer, plus **Default** to go back to following your theme. |
| **SC Timer Background Color** | The same for the box behind them, plus **Default** for the ordinary ComfyUI node background and **None** for no background at all. |
| **SC Timer Reset Colors** | Back to the theme's own colors. |

The node **cannot be resized**, and has no resize handles in either renderer. Its size is worked out
from the point size and from how many segments the clock is currently showing, so there is nothing a
resize could usefully mean — change the point size instead and the node fits itself around it.

**Shapes work too.** Right-click → **Shape** → *Box*, *Round* or *Card* and the timer's box follows,
with the selection outline keeping the same shape three pixels out — including *Card*, which in
ComfyUI is rounded on the top-left and bottom-right corners only, not across the top.

(Under the **legacy** renderer ComfyUI's own Shapes menu currently has no effect on any node,
including its own. That is a bug in ComfyUI itself — confirmed against a clean portable install with
no custom nodes at all — so shapes are a Nodes 2.0 feature for the time being.)

**ComfyUI's own colour menu works as well**, and the two ways of colouring the node do not fight:
whichever you used last is the one that stands. Pick a colour from ComfyUI's palette and it becomes
the timer's background; pick one from **SC Timer Background Color** and it replaces whatever the
palette had set. *No color* puts back the ordinary node background.

| Property | Does |
| --- | --- |
| `sc_font_size` | Point size, default `20`. |
| `sc_color` | `default`, or a color, as set by the menu. |
| `sc_background` | `default`, `transparent`, or a color, as set by the menu. |

These are the same three properties `SC Label` uses, on purpose: one name per idea across the pack.
They are edited in the properties panel under the legacy renderer (right-click → **Properties
Panel**); Nodes 2.0 has no properties panel, which is why they are on the menu as well.

## Notes

- **Nothing about a run is saved with the workflow.** The elapsed time and the last run's outcome
  describe one session, not the graph, so they live only in the browser and start clean on every
  page load. Only the three appearance properties above are stored, and they are hashed as `layout`
  rather than `inputs` — restyling a timer does not report that the workflow's parameters changed.
- **`SC Load Inputs` never rewrites it.** Restoring an earlier run's values restores parameters, not
  furniture.
- **One run, every timer.** More than one timer on a canvas is fine; they all show the same run.
- **A result belongs to its workflow.** Switch to a different workflow and the timer reads
  `00:00.000` again rather than showing you a time from somewhere else.
- Works under both the legacy renderer and Nodes 2.0. Neither draws a header for it.
