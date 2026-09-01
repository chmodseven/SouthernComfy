# SC Version

Reports the version of the running ComfyUI installation and the version of the
Southern Comfy node pack.

The versions are read from the live ComfyUI process at execution time, so the
node always reflects the installation it is actually running in. The result is
also drawn on the node body, so no downstream connection is required.

## Inputs

This node has no inputs.

## Outputs

| Name | Type | Description |
| --- | --- | --- |
| `comfyui_version` | `STRING` | Version of the running ComfyUI installation, e.g. `0.33.4`. Falls back to `unknown` if it cannot be determined. |
| `pack_version` | `STRING` | Version of the Southern Comfy node pack, e.g. `0.0.1`. |

## Notes

- The node is an output node, so it executes even when nothing is connected to it.
- Results are cached for the lifetime of the ComfyUI process, since a running
  installation cannot change its own version.
