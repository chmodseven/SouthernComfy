"""The ``SC Timer`` node: a stopwatch on the canvas, driven by the run itself."""

from __future__ import annotations

from comfy_api.latest import io

from ..constants import NODE_TYPE_TIMER

__all__ = ["SCTimer"]


class SCTimer(io.ComfyNode):
    """Shows how long the current run has been going, and how long the last one took.

    The node has no title bar and no source badge, so what the user sees is the
    readout: ``MI:SS.fff``, growing an ``HH:`` and then a ``DD:`` prefix only if
    a run is long enough to need one. Beside it sits a small state light -- a
    spinner while a run is in flight, then a coloured bubble saying how the run
    finished.

    Why there is no Python here
    ---------------------------
    All of the behaviour is in ``web/sc_timer.js``, and that is not an
    implementation convenience -- it is the only correct place for it.

    * **A node cannot time the run it is part of.** Execution follows the
      dependency graph, so a node has no way to arrange to run first or last,
      and there is no post-execution hook a custom node may register (the
      ``on_prompt_start`` / ``on_prompt_end`` pair in ``execution.py`` belongs
      to the cache-provider interface and borrowing it would be an abuse of an
      API meant for something else).
    * **The frontend is already told.** ComfyUI pushes ``execution_start`` and
      then one of ``execution_success`` / ``execution_error`` /
      ``execution_interrupted`` over the websocket, each stamped with the
      server's own millisecond clock -- the same stamps the history entry and
      the console line are derived from. Subscribing to messages the browser
      receives anyway costs the run nothing at all, which a node that executed
      could not promise.

    So the node declares no inputs and no outputs, never joins the execution
    graph, and cannot slow a run down: it is not in it.

    What is saved with the workflow
    -------------------------------
    Only the appearance -- ``sc_font_size``, ``sc_color`` and ``sc_background``,
    the same ``sc_``-prefixed properties ``SC Label`` uses, hashed as ``layout``
    rather than ``inputs`` because a readout's styling is presentation. The
    elapsed time and the run's outcome are deliberately **not** saved: they
    describe one session's run, not the workflow, so they live in the frontend
    module and start clean every time the page loads. The node also sets
    ``serialize_widgets = false``, so nothing reaches ``widgets_values``.

    ``SC_Timer`` is listed in ``constants.UNRESTORABLE_TYPES`` for the same
    reason ``SC_Label`` is: restoring an earlier run's *input values* should not
    reach in and restyle the furniture.
    """

    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id=NODE_TYPE_TIMER,
            display_name="SC Timer",
            category="SouthernComfy/utils",
            description=(
                "A run timer with no title bar and no badge. Reads 00:00.000 "
                "until a run starts, counts up in real time while it runs, and "
                "stops on the final duration -- taken from ComfyUI's own "
                "timestamps, so it matches the console. The light beside it "
                "shows how the last run ended. Right-click for SC Timer Font "
                "Size, SC Timer Text Color and SC Timer Background Color."
            ),
            search_aliases=[
                "timer",
                "stopwatch",
                "clock",
                "duration",
                "elapsed",
                "run time",
                "execution time",
                "benchmark",
            ],
            inputs=[],
            outputs=[],
        )

    @classmethod
    def execute(cls) -> io.NodeOutput:
        # Unreachable in practice: with no outputs the node is never scheduled.
        return io.NodeOutput()
