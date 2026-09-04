# SC Label

A piece of text on the canvas, with no title bar and no badge — for captioning a group, naming a
branch, or leaving a word beside a wire.

Every pack has a note node, and they all draw a titled, badged box. That is right for a note and
wrong for a caption: a heading over a section of a workflow should look like writing on the canvas,
not like another node in it.

## Using it

Add it, then **double-click the text** to edit. `Enter` or clicking away saves, `Shift+Enter`
starts a new line, and `Escape` abandons the edit.

Text wraps to the node's width, and reflows as you resize. If there is more of it than the node is
tall, a slim scrollbar appears down the right-hand side: drag the thumb, or scroll with the mouse
wheel. It takes its color from the text, dimmed, so it stays visible against whatever background
you have chosen, and it keeps clear of the bottom-right corner wherever there is room to — on a
one-line label the whole height is needed for the thumb to have anywhere to go, and the resize
corner is still reachable from just outside the node.

## Growing with the text

A new label **follows what you type**: it gets a line taller as the text wraps or you press
`Shift+Enter`, and a line shorter as you delete. Nothing is ever pushed up out of sight while you
are writing it.

That stops for good the first time you **resize the label yourself**. A size you set by hand is a
decision, so from then on the label keeps it: adding text scrolls rather than growing the box, and
deleting text simply leaves room to spare. The switch is the `sc_autosize` property, saved with
the workflow — set it back to `true` in the properties panel to have a label follow its text again.

Drag it by anywhere on its body. There is no title bar to grab, so the whole node is the handle —
which is why the text does not respond to a single click.

**Inputs and outputs** — none. The node never joins the execution graph and costs nothing to leave
in a workflow.

## Appearance

Right-click the label:

| Menu item | Does |
| --- | --- |
| **SC Label Font Size** | The usual point sizes, 8 to 72, with a tick beside the current one. **Custom…** opens a slider for anything from 4 to 200, applying as you drag it; `Escape` puts back the size you started at. |
| **SC Label Text Color** | A swatch and a hex box for the text, at the pointer. |
| **SC Label Background Color** | The same for the box behind it, plus **None** for no background at all. |
| **SC Label Reset Colors** | Back to white text on no background. |

Both color items open a small panel where you clicked, holding a swatch and a hex field. Type a hex
and the label follows it as you go; click the swatch for your browser's own color picker; `Escape`
puts back the color you started with and closes the panel, and clicking anywhere else keeps what
you have. The panel exists because **where a browser puts its color dialog is the browser's
decision**, not a setting — anchoring it to a control that is really there, under the pointer, is
the only way to be sure of where it appears.

A new label is **white text with no background at all** -- it sits directly on the canvas, with no
box, no title bar and no badge. Give it a background color and the box appears.

The remaining settings are ordinary node properties, edited in the properties panel under the
legacy renderer (right-click -> **Properties Panel**); Nodes 2.0 has no properties panel, so the
colors above are on the menu instead.

| Property | Does |
| --- | --- |
| `sc_text` | The text itself. |
| `sc_font_size` | Point size, default `16`. Large values make a section heading. |
| `sc_color` | The text color, as set by the menu. |
| `sc_align` | `left`, `center` or `right`. |
| `sc_background` | `transparent`, or a color, as set by the menu. |
| `sc_autosize` | Whether the label still grows with its text. Turns itself off the first time you resize the label by hand. |

**An empty label still shows.** With no text and no background there would be nothing on the canvas
to see or click, so an empty one draws a faint dashed outline. It disappears as soon as there is
text.

## Notes

- **It is not an input.** The text lives in node properties rather than widget values, so editing a
  caption moves the workflow's `layout` checksum and leaves `inputs` and `structure` alone —
  annotating a workflow does not count as changing its parameters.
- **`SC Load Inputs` never rewrites it.** Restoring the values of an earlier run restores
  parameters, not commentary; a note about what you were trying should survive going back to what
  you tried it on.
- Works under both the legacy renderer and Nodes 2.0. Neither draws a header for it.
- Resize it as you would any node, down to a floor of one whole line of text at the current point
  size. Below that there would be nothing to read and nothing to grab. Both renderers stop there,
  each by its own mechanism -- the floor is the label's, not a guess made afterwards.
