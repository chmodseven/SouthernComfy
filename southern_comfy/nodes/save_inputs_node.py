"""The ``SC Save Inputs`` node: writes a run's input values to JSON."""

from __future__ import annotations

import json
import logging
import os

import folder_paths
from comfy_api.latest import io

from ..run_inputs import capture

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


class SCSaveInputs(io.ComfyNode):
    """Records the values a run was invoked with, for posterity.

    Every widget value in the workflow is written to a JSON file under the
    output folder, together with the four workflow checksums and the literal
    inputs the backend received. ``SC Load Inputs`` reads the file back and
    pastes those values into a workflow.

    The node produces nothing and is wired to nothing. It declares itself an
    output node so ComfyUI schedules it on every run, which is all it needs:
    the values it records arrive as hidden metadata describing the whole
    prompt, not as inputs of its own, so where it sits on the canvas and when
    it runs make no difference to what it captures.
    """

    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="SC_SaveInputs",
            display_name="SC Save Inputs",
            category="SouthernComfy/utils",
            description=(
                "Saves every input value in the workflow to a JSON file in the "
                "output folder each time the workflow runs, alongside the "
                "workflow checksums. Load the file back with SC Load Inputs to "
                "restore those values."
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
        node declares only where to write. What it actually records reaches it
        as hidden metadata the cache knows nothing about, so left alone the node
        is judged unchanged after its first run and skipped as
        ``execution_cached`` from then on -- silently recording nothing while
        appearing to work.

        A precise key is not available here: ComfyUI calls this without
        ``dynprompt`` or ``extra_data``, so neither the prompt nor the workflow
        can be seen at this point. NaN is ComfyUI's idiom for "always changed",
        since NaN never equals the previous NaN, and it is the honest answer --
        every run is a new run to record.
        """
        return float("nan")

    @classmethod
    def execute(cls, filename_prefix: str) -> io.NodeOutput:
        # Absent when a prompt arrives without workflow metadata, such as one
        # submitted straight to the API. capture() treats either as empty rather
        # than failing the run.
        extra = cls.hidden.extra_pnginfo or {}
        workflow = extra.get("workflow") if isinstance(extra, dict) else None
        record = capture(workflow, cls.hidden.prompt)

        # get_save_image_path performs the date substitutions, splits off the
        # subfolder, refuses a prefix that would escape the output folder, and
        # returns the next free counter. All of that is wanted here unchanged,
        # so that a prefix behaves identically on this node and on Save Image.
        full_folder, filename, counter, subfolder, _ = folder_paths.get_save_image_path(
            filename_prefix, folder_paths.get_output_directory()
        )

        name = f"{filename}_{counter:0{_COUNTER_DIGITS}}{_EXTENSION}"
        path = os.path.join(full_folder, name)
        with open(path, "w", encoding="utf-8") as handle:
            json.dump(record, handle, indent=2, ensure_ascii=False)

        _LOGGER.info(
            "SouthernComfy saved the inputs of %d nodes to %s",
            len(record["nodes"]),
            path,
        )

        # Described the way ComfyUI describes a saved file, so the frontend can
        # fetch it back through the standard /view route.
        return io.NodeOutput(
            ui={"sc_saved": [{"filename": name, "subfolder": subfolder, "type": "output"}]}
        )
