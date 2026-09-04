/**
 * Populates the "SC Version" node with labelled, read-only version rows.
 *
 * The node takes no inputs and produces no outputs, so it never executes.
 * Values are fetched once per session from the pack's own route and shown as
 * standard widgets, which keeps the node looking and behaving like a core one.
 *
 * Renderer notes:
 *  - Nodes 2.0 (Vue) honours the `read_only` widget option.
 *  - The legacy renderer ignores it and opens a value editor on click, so the
 *    widget's click handler is suppressed there instead. Marking the widgets
 *    `disabled` would work too, but the legacy renderer then hides the value.
 *  - Legacy needs an explicit header gap; see `headerGap` below.
 */

// Served from /extensions/SouthernComfy/, so "../../" is the ComfyUI web root.
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const NODE_TYPE = "SC_Version";
const UNKNOWN = "unknown";
const MIN_WIDTH = 320;

/** Row label paired with its key in the /southerncomfy/versions payload. */
const ROWS = [
    ["ComfyUI Version", "comfyui"],
    ["SouthernComfy Version", "pack"],
];

/** Cached across every instance of the node: versions cannot change at runtime. */
let versionsRequest = null;

function fetchVersions() {
    versionsRequest ??= api
        .fetchApi("/southerncomfy/versions")
        .then((response) => {
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }
            return response.json();
        })
        .catch((error) => {
            console.error("[SouthernComfy] Could not read versions.", error);
            // Only a *successful* answer is worth keeping. Caching the failure
            // would make one unlucky moment permanent: a request that lost a
            // race with the server starting up would leave this node, and every
            // one added for the rest of the session, reading "unknown" with no
            // way back but a page reload.
            versionsRequest = null;
            return {};
        });
    return versionsRequest;
}

function addInfoWidget(node, label) {
    const widget = node.addWidget("text", label, UNKNOWN, () => {}, {
        serialize: false,
        read_only: true,
    });
    widget.onClick = () => {};
    return widget;
}

/**
 * Gap between the node header and the first widget, for the legacy renderer.
 *
 * Legacy starts widgets 2px below the header when a node has no input or output
 * slots, which reads as cramped: core nodes get their breathing room from slot
 * rows, which push their first widget down to y=26. Half a widget row restores a
 * deliberate gap without leaving an empty slot-sized band. Nodes 2.0 lays out
 * with CSS and ignores this property.
 */
function headerGap() {
    const widgetHeight = window.LiteGraph?.NODE_WIDGET_HEIGHT ?? 20;
    return widgetHeight / 2;
}

function resize(node) {
    const [width, height] = node.computeSize();
    node.setSize([Math.max(width, MIN_WIDTH), height]);
}

app.registerExtension({
    name: "SouthernComfy.Version",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData?.name !== NODE_TYPE) {
            return;
        }

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            onNodeCreated?.apply(this, arguments);

            // The rows are re-read from the server every time the node is
            // created, so persisting them would only ever save a value that is
            // about to be replaced -- and would leave a stale version on show
            // until the fetch lands. Keep them out of the workflow entirely.
            this.serialize_widgets = false;
            this.widgets_start_y = headerGap();

            const widgets = ROWS.map(([label]) => addInfoWidget(this, label));
            resize(this);

            fetchVersions().then((versions) => {
                // The node may have been deleted while the request was in
                // flight, in which case there is nothing left to fill in and
                // no reason to force a repaint on its behalf.
                if (!this.graph) {
                    return;
                }
                ROWS.forEach(([, key], index) => {
                    widgets[index].value = versions[key] ?? UNKNOWN;
                });
                resize(this);
                app.graph?.setDirtyCanvas(true, true);
            });
        };
    },
});
