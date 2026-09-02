"""The ``SC Save Inputs`` node: writes a run's inputs and outcome to JSON."""

from __future__ import annotations

import json
import logging
import os

import folder_paths
from comfy_api.latest import io

from ..run_inputs import capture, finish_run, start_run
from ..run_stats import current_prompt_id, memory_snapshot, when_finished

__all__ = ["SCSaveInputs"]

_LOGGER = logging.getLogger("SouthernComfy")

_EXTENSION = ".json"

#: Matches Save Image's counter width, so the two sit together tidily when a
#: prefix points both at the same folder.
_COUNTER_DIGITS = 5

_PREFIX_TOOLTIP = (
    "Where to write the file, relative to the output folder, exactly as Save "
    "Image's filename prefix works. A prefix of runs/run writes "
    "output/runs/run_00001.json, then run_00002.json, and so on.\n"
    "\n"
    "The date and time substitutions are available too: %year%, %month%, "
    "%day%, %hour%, %minute% and %second%. A prefix of runs/%year%-%month%-"
    "%day%/run therefore starts a fresh numbered set each day."
)

_DESCRIPTION_TOOLTIP = (
    "An optional one-line note about this run -- what you changed, or what you "
    "were trying. It is stored at the top of the file so it can be shown "
    "beside the run in a list, so keep it short and recognisable rather than "
    "descriptive: 'denoise down to 0.9' rather than a paragraph."
)


class SCSaveInputs(io.ComfyNode):
    """Records the values a run was invoked with, and how the run went.

    Every widget value in the workflow, plus each node's own properties, is
    written to a JSON file under the output folder together with the four
    workflow checksums and the literal inputs the backend received.
    ``SC Load Inputs`` reads the file back and pastes that state into a
    workflow.

    The node produces nothing and is wired to nothing. It declares itself an
    output node so ComfyUI schedules it on every run, which is all it needs:
    what it records arrives as hidden metadata describing the whole prompt, not
    as inputs of its own, so where it sits on the canvas makes no difference to
    what it captures.

    **The file is written twice.** ComfyUI offers no post-execution hook and no
    way for a node to arrange to run last, so the record is written as the node
    executes -- capturing the inputs, which are already final -- and then
    completed once the run ends, with its outcome, duration and memory figures.
    Writing first means a record survives ComfyUI being closed mid-run; the
    second write only ever adds to it. See ``southern_comfy.run_stats`` for what
    ComfyUI does and does not make available.
    """

    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="SC_SaveInputs",
            display_name="SC Save Inputs",
            category="SouthernComfy/utils",
            description=(
                "Saves every input value in the workflow to a JSON file in the "
                "output folder each time the workflow runs, along with the "
                "workflow checksums and how the run turned out. Load the file "
                "back with SC Load Inputs to restore those values."
            ),
            search_aliases=[
                "save inputs",
                "save parameters",
                "save settings",
                "run inputs",
                "run log",
                "snapshot",
                "parameters",
            ],
            inputs=[
                io.String.Input(
                    "filename_prefix",
                    default="runs/run",
                    tooltip=_PREFIX_TOOLTIP,
                ),
                io.String.Input(
                    "description",
                    default="",
                    # Single line on purpose: this is shown as a column beside
                    # the run in a list, where an essay would be unreadable.
                    multiline=False,
                    optional=True,
                    tooltip=_DESCRIPTION_TOOLTIP,
                ),
            ],
            outputs=[],
            hidden=[io.Hidden.prompt, io.Hidden.extra_pnginfo],
            is_output_node=True,
            # Two of these nodes in one graph are two separate files to write,
            # even when they carry the same prefix. Without this they share a
            # cache entry, since ComfyUI keys one on the inputs alone.
            not_idempotent=True,
        )

    @classmethod
    def fingerprint_inputs(cls, **_kwargs) -> float:
        """Force a re-run on every execution, so no run goes unrecorded.

        ComfyUI keys its execution cache on a node's *declared* inputs, and this
        node declares only where to write and what to call it. What it actually
        records reaches it as hidden metadata the cache knows nothing about, so
        left alone the node is judged unchanged after its first run and skipped
        as ``execution_cached`` from then on -- silently recording nothing while
        appearing to work.

        A precise key is not available here: ComfyUI calls this without
        ``dynprompt`` or ``extra_data``, so neither the prompt nor the workflow
        can be seen at this point. NaN is ComfyUI's idiom for "always changed",
        since NaN never equals the previous NaN, and it is the honest answer --
        every run is a new run to record.
        """
        return float("nan")

    @staticmethod
    def _write(path: str, record: dict) -> None:
        with open(path, "w", encoding="utf-8") as handle:
            json.dump(record, handle, indent=2, ensure_ascii=False)

    @classmethod
    def _complete(cls, path: str, record: dict, history: dict | None) -> None:
        """Fill in the outcome once the run has finished, and rewrite the file.

        Called on the waiting thread, well after this node's own execution, so
        nothing here can delay or fail a run.
        """
        record["run"] = finish_run(record["run"], history, memory_snapshot())
        cls._write(path, record)
        run = record["run"]
        _LOGGER.info(
            "SouthernComfy completed %s: %s in %ss",
            os.path.basename(path),
            run.get("status", "unknown"),
            run.get("duration_seconds", "?"),
        )

    @classmethod
    def execute(cls, filename_prefix: str, description: str = "") -> io.NodeOutput:
        # extra_pnginfo is absent when a prompt arrives without workflow
        # metadata, such as one submitted straight to the API. capture() treats
        # either as empty rather than failing the run.
        extra = cls.hidden.extra_pnginfo or {}
        workflow = extra.get("workflow") if isinstance(extra, dict) else None
        prompt_id = current_prompt_id() or ""

        record = capture(
            workflow,
            cls.hidden.prompt,
            description=description,
            run=start_run(prompt_id or None, memory_snapshot()),
        )

        # get_save_image_path performs the date substitutions, splits off the
        # subfolder, refuses a prefix that would escape the output folder, and
        # returns the next free counter. All of that is wanted here unchanged,
        # so that a prefix behaves identically on this node and on Save Image.
        full_folder, filename, counter, subfolder, _ = folder_paths.get_save_image_path(
            filename_prefix, folder_paths.get_output_directory()
        )

        name = f"{filename}_{counter:0{_COUNTER_DIGITS}}{_EXTENSION}"
        path = os.path.join(full_folder, name)
        # Written now, before the run has finished, so the counter is claimed
        # immediately -- two runs queued back to back would otherwise both see
        # the same next free number -- and so the inputs survive even if ComfyUI
        # never reaches the end of this run.
        cls._write(path, record)

        _LOGGER.info("SouthernComfy saved the inputs of %d nodes to %s", len(record["nodes"]), path)

        # Detached on purpose: the run must not wait for its own record. The
        # wait happens on a thread, because the event loop this node executes on
        # is closed as soon as the prompt ends -- before the outcome exists.
        if not when_finished(prompt_id, lambda history: cls._complete(path, record, history)):
            _LOGGER.warning(
                "SouthernComfy has no prompt id for %s, so it records the inputs "
                "but not the outcome.",
                name,
            )

        # Described the way ComfyUI describes a saved file, so the frontend can
        # fetch it back through the standard /view route.
        return io.NodeOutput(
            ui={"sc_saved": [{"filename": name, "subfolder": subfolder, "type": "output"}]}
        )
