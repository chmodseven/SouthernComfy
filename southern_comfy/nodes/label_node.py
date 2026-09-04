"""The ``SC Label`` node: a plain piece of text on the canvas, with no chrome."""

from __future__ import annotations

from comfy_api.latest import io

__all__ = ["SCLabel"]


class SCLabel(io.ComfyNode):
    """Annotates a workflow with text and nothing else -- no header, no badge.

    Every pack's note node draws a titled, badged box, which is fine for a note
    and wrong for a caption: a heading over a group, or a word beside a wire,
    should look like writing on the canvas rather than like another node. This
    one has no title bar and no source badge, so what the user sees is the text.

    The node declares no inputs and no outputs, so it never joins the execution
    graph and costs nothing to leave in a workflow. All of its behaviour is in
    ``web/sc_label.js``, because all of it is presentation.

    Where the text lives, and why not in a widget
    ---------------------------------------------
    The text and its styling are kept in ``sc_``-prefixed node **properties**,
    not in widget values. Two reasons, and both matter:

    * A widget value lands in the ``inputs`` digest, so editing a caption would
      report that the workflow's *inputs* had changed. They had not. As
      properties this pack owns, these are hashed as ``layout`` instead --
      alongside position, size, title and color, which is what a caption is.
    * They are then editable in ComfyUI's own properties panel for free, with no
      bespoke settings dialog to maintain.

    The ones a user reaches for -- color, background and point size -- are also
    on the node's right-click menu, prefixed ``SC Label``, because Nodes 2.0 has
    no properties panel at all. ``sc_autosize`` records whether the label still
    grows with its text; resizing it by hand turns that off.

    ``SC_Label`` is listed in ``run_inputs.UNRESTORABLE_TYPES``: restoring an
    earlier run's *input values* should never rewrite the notes the user has
    since made about it.
    """

    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="SC_Label",
            display_name="SC Label",
            category="SouthernComfy/utils",
            description=(
                "A plain text label for annotating a workflow, with no title "
                "bar and no badge. Double-click it to edit the text, which the "
                "label grows to fit until you resize it by hand. Right-click "
                "for SC Label Text Color, SC Label Background Color and SC "
                "Label Font Size; alignment lives in the properties panel."
            ),
            search_aliases=[
                "label",
                "text",
                "caption",
                "annotation",
                "note",
                "comment",
                "title",
                "heading",
            ],
            inputs=[],
            outputs=[],
        )

    @classmethod
    def execute(cls) -> io.NodeOutput:
        # Unreachable in practice: with no outputs the node is never scheduled.
        return io.NodeOutput()
