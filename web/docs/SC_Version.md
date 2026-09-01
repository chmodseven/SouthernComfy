# SC Version

Displays the version of the running ComfyUI installation and the version of the
Southern Comfy node pack, on two labelled rows:

| Row | Meaning |
| --- | --- |
| **ComfyUI Version** | Version of the running ComfyUI installation, e.g. `0.34.0`. |
| **SouthernComfy Version** | Version of the installed Southern Comfy node pack, e.g. `0.0.1`. |

Useful when filing an issue, or for confirming which versions a workflow was
authored against.

## Inputs and outputs

This node has none. It is purely informational, so it never joins the execution
graph and costs nothing to leave in a workflow.

## Notes

- The values appear as soon as the node is added; no need to run the workflow.
- Both rows are read only, and are re-read from the running installation every
  time the node is created, so a workflow saved on an older version still
  reports the version you are actually running.
- A workflow containing only this node has nothing to execute, so ComfyUI will
  report "Prompt has no outputs". Add it alongside the rest of your graph.
