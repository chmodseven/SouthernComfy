"""Post-run facts about an execution, gathered from the running ComfyUI.

Kept apart from ``southern_comfy.run_inputs``, which stays free of ComfyUI
imports so it can be used from a plain Python session. This module is the
opposite: it exists only to ask the host what happened, and every answer it
gives is optional -- a missing figure is omitted rather than guessed at, and no
failure here may disturb a run.

What ComfyUI does and does not offer
------------------------------------
Verified against ComfyUI 0.34.0.

* **There is no post-execution hook for a custom node.** ``add_on_prompt_handler``
  fires *before* a prompt is queued, and the ``on_prompt_start`` /
  ``on_prompt_end`` pair belongs to the cache-provider interface -- registering
  a fake cache provider to borrow it would be an abuse of an API meant for
  something else. A node also cannot simply arrange to run last: execution
  order follows the dependency graph, and a node with no inputs has no way to
  depend on everything.

  So completion is *waited for* rather than hooked: the record is written when
  the node executes, and ``when_finished`` watches the queue's own history for
  the run to land, then the record is rewritten with the outcome. Writing first
  and completing afterwards also means a record survives ComfyUI being closed
  mid-run.

  The wait runs on a **thread**, not an asyncio task. ComfyUI executes each
  prompt inside ``asyncio.run(...)``, so the loop a node runs on is closed as
  soon as that prompt ends -- before the history entry is written -- and a task
  waiting on it is destroyed while pending.

* **Timing is per run, not per node.** Every message ComfyUI records carries a
  millisecond timestamp, so ``execution_start`` to ``execution_success`` gives a
  true wall-clock duration -- but nothing in the backend times individual nodes.
  Finer breakdown ("how much of that was the sampler?") would have to come from
  ``comfy_execution.progress.ProgressHandler``, whose ``start_handler`` and
  ``finish_handler`` are called per node. That is a real extension point, with
  one catch: ``reset_progress_state`` builds a fresh registry for every prompt
  and discards registered handlers, so a handler must re-register per run.

* **Memory is a live reading, not a history.** ``comfy.model_management``
  reports free and total for the CPU and for each torch device at the moment it
  is asked. Sampling it at the start and at the end of a run is the honest limit
  of what can be had without instrumenting the sampler.
"""

from __future__ import annotations

import logging
import threading
import time
from typing import Any

__all__ = ["current_prompt_id", "memory_snapshot", "when_finished"]

_LOGGER = logging.getLogger("SouthernComfy")

#: How often to look for the finished run, and how long to keep looking. The
#: wait costs nothing while idle, but it must not outlive a genuinely long
#: generation -- twelve hours is far past any real one, and giving up merely
#: leaves the record saying the run was still going.
#:
#: The interval grows as the wait lengthens, which costs nothing in accuracy:
#: the duration written into a record comes from ComfyUI's own timestamps, not
#: from when the wait happened to notice, so a later poll delays only the second
#: write of the file. It matters for the run that never lands in history at all
#: -- one whose entry was cleared, say -- where a fixed half-second poll would
#: wake eighty-six thousand times before giving up. Short runs, which are the
#: common case, still see their outcome recorded within half a second.
_POLL_SECONDS = 0.5
_MAX_POLL_SECONDS = 15.0
_POLL_GROWTH = 1.5
_TIMEOUT_SECONDS = 12 * 60 * 60


def current_prompt_id() -> str | None:
    """The id of the prompt being executed right now, or ``None``.

    There is no ``Hidden.prompt_id``: the V3 hidden variables are ``unique_id``,
    ``prompt``, ``extra_pnginfo``, ``dynprompt`` and the auth pair, and asking
    for anything else yields ``None`` silently. ComfyUI's prompt worker does
    stamp the id onto the server before it starts a run
    (``server_instance.last_prompt_id = prompt_id``, immediately before
    ``execute``), so while a node is executing that attribute names the run the
    node is part of.
    """
    try:
        from server import PromptServer

        prompt_id = getattr(PromptServer.instance, "last_prompt_id", None)
    except Exception:
        return None
    return str(prompt_id) if prompt_id else None


def memory_snapshot() -> dict[str, Any]:
    """Free and total memory right now, for the CPU and each torch device.

    Returns an empty mapping if ComfyUI's memory management cannot be reached.
    Figures are bytes, as ComfyUI reports them.
    """
    try:
        import comfy.model_management as mm
    except Exception:  # pragma: no cover - only on an unexpected host layout
        return {}

    snapshot: dict[str, Any] = {}
    try:
        cpu = mm.torch.device("cpu")
        snapshot["ram_total"] = mm.get_total_memory(cpu)
        snapshot["ram_free"] = mm.get_free_memory(cpu)
    except Exception as error:
        _LOGGER.debug("SouthernComfy could not read system memory: %s", error)

    devices: list[dict[str, Any]] = []
    try:
        for device in mm.get_all_torch_devices():
            total, torch_total = mm.get_total_memory(device, torch_total_too=True)
            free, torch_free = mm.get_free_memory(device, torch_free_too=True)
            devices.append(
                {
                    "name": mm.get_torch_device_name(device),
                    "type": device.type,
                    "index": device.index,
                    "vram_total": total,
                    "vram_free": free,
                    "torch_vram_total": torch_total,
                    "torch_vram_free": torch_free,
                }
            )
    except Exception as error:
        _LOGGER.debug("SouthernComfy could not read device memory: %s", error)

    if devices:
        snapshot["devices"] = devices
    return snapshot


def _history_entry(prompt_id: str) -> dict | None:
    """The finished run's history entry, or ``None`` while it is still running."""
    try:
        from server import PromptServer

        queue = PromptServer.instance.prompt_queue
    except Exception:
        return None

    try:
        found = queue.get_history(prompt_id=prompt_id)
    except Exception as error:  # pragma: no cover - defensive
        _LOGGER.debug("SouthernComfy could not read the prompt history: %s", error)
        return None

    entry = found.get(prompt_id) if isinstance(found, dict) else None
    return entry if isinstance(entry, dict) else None


def _await_history(prompt_id: str) -> dict | None:
    """Wait for ``prompt_id`` to finish, and return its history entry.

    ComfyUI writes a run into its history only once the run is over -- success,
    error or interruption alike -- so the entry appearing *is* the completion
    signal, and its status messages carry the outcome and the timings.

    Blocking, and private for that reason: ``when_finished`` is the way in, and
    it supplies the thread.

    Returns ``None`` if the wait times out, or if the history was cleared before
    the entry could be read.
    """
    if not prompt_id:
        return None

    deadline = time.monotonic() + _TIMEOUT_SECONDS
    interval = _POLL_SECONDS
    while time.monotonic() < deadline:
        entry = _history_entry(prompt_id)
        if entry is not None:
            return entry
        time.sleep(interval)
        interval = min(interval * _POLL_GROWTH, _MAX_POLL_SECONDS)

    _LOGGER.warning(
        "SouthernComfy gave up waiting for prompt %s to finish; its record keeps "
        "the inputs but not the outcome.",
        prompt_id,
    )
    return None


def when_finished(prompt_id: str, then) -> bool:
    """Call ``then(history_entry)`` on a background thread once the run ends.

    A **thread**, not an asyncio task, and the reason is worth recording.
    ComfyUI runs each prompt with ``asyncio.run(execute_async(...))``, so the
    event loop a node executes on is created for that prompt and **closed the
    moment the prompt finishes**. The history entry is written after that, back
    in the prompt worker -- so a task waiting for it on that loop is destroyed
    while still pending and never fires. This was exactly the bug: the record's
    outcome was never filled in, silently.

    A daemon thread has no such lifetime. It costs one sleeping thread per run
    for the length of that run, and the queue executes one prompt at a time.

    Returns whether the wait was started.
    """
    if not prompt_id:
        return False

    def wait() -> None:
        try:
            then(_await_history(prompt_id))
        except Exception as error:
            _LOGGER.warning(
                "SouthernComfy could not record the outcome of prompt %s: %s", prompt_id, error
            )

    threading.Thread(target=wait, name=f"SouthernComfy-run-{prompt_id[:8]}", daemon=True).start()
    return True
