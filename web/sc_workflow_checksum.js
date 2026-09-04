/**
 * Keeps the "SC Workflow Checksum" node showing a live digest of the canvas.
 *
 * The digest is computed on the server, through the pack's checksum route,
 * rather than reimplemented here. A JavaScript copy of the algorithm would be
 * free to drift out of agreement with the Python one, and a checksum that two
 * halves of the same pack disagree about is worse than no checksum at all.
 *
 * Change detection: the graph is serialised on a timer and compared with the
 * previous serialisation. Only an actual difference costs a request, so an idle
 * canvas is free, and a burst of edits collapses into one round trip. Switching
 * `scope` costs nothing at all: every scope's digest arrives in the same
 * response and is cached.
 *
 * Renderer notes:
 *  - Nodes 2.0 (Vue) honours the `read_only` widget option.
 *  - The legacy renderer ignores it and opens a value editor on click, so the
 *    widget's click handler is suppressed there instead. Marking the widget
 *    `disabled` would work too, but the legacy renderer then hides the value.
 *  - No header gap is needed here: the node has an output slot, so the legacy
 *    renderer already spaces the first widget correctly.
 */

// Served from /extensions/SouthernComfy/, so "../../" is the ComfyUI web root.
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const NODE_TYPE = "SC_WorkflowChecksum";
const DISPLAY_WIDGET = "checksum";
const SCOPE_WIDGET = "scope";
const PENDING = "…";
const ELLIPSIS = "...";
/**
 * How often the graph is checked for a change.
 *
 * Polling, rather than reacting to events, and that is not for want of looking.
 * `graph._version` moves for a node being added or removed and for nothing else
 * -- measured: not for a widget edit, a node being dragged, a rename, or a
 * property being written, which are exactly the edits the `inputs` and `layout`
 * scopes exist to notice. Gating on it would freeze the digest during ordinary
 * work while looking like it still worked.
 *
 * ComfyUI's own undo tracker answers the same question the same way: it
 * serialises the whole graph and deep-compares it against the last one, on a
 * 50ms debounce -- eight times more often than this, and more expensive each
 * time. It gets away with knowing *when* to look only because core calls it
 * from its own mutation sites throughout the frontend, which is not a signal an
 * extension can subscribe to.
 *
 * Measured cost of one pass on the largest workflow in the corpus (137 nodes,
 * 182KB of JSON): 0.96ms, so 2.4ms of main thread per second.
 */
const POLL_MS = 400;

/** Characters of digest the node shows at its default width. */
const DEFAULT_CHARS = 12;
/** Enough width for the `scope` dropdown to stay usable when the node is small. */
const MIN_WIDTH = 240;
/** LiteGraph's own horizontal widget margin, and the label/value gap. */
const WIDGET_MARGIN = 15;
const LABEL_GAP = 10;

/** Live node instances, so one poll serves however many are on the canvas. */
const instances = new Set();

/** Serialised graph from the last poll, to detect real changes cheaply. */
let lastSerialised = null;
/** Most recent digests, keyed by scope. */
let digests = null;
/** Guards against overlapping requests when a graph is large. */
let inFlight = false;
let timer = null;

/** Offscreen context used purely to measure text; never drawn to screen. */
const ruler = document.createElement("canvas").getContext("2d");

function measure(text) {
    const lg = window.LiteGraph;
    ruler.font = `${lg?.NODE_TEXT_SIZE ?? 14}px ${lg?.NODE_FONT ?? "Arial"}`;
    return ruler.measureText(text).width;
}

/**
 * Fit a digest to the node's current width, marking any truncation.
 *
 * A 64-character digest is far too wide to show by default, but hiding the
 * truncation would misrepresent a 12-character prefix as the whole value. So
 * the visible portion grows as the node is widened, always trailed by an
 * ellipsis, and the ellipsis disappears only once the entire digest is shown.
 *
 * The measurement uses the legacy renderer's widget font. Nodes 2.0 lays out
 * with CSS and its metrics differ slightly, so the fit is approximate there --
 * the string shown is identical, it may simply break a character or two early.
 */
function fitDigest(node, digest) {
    if (typeof digest !== "string" || digest === "") {
        return PENDING;
    }

    const available =
        node.size[0] - WIDGET_MARGIN * 2 - measure(DISPLAY_WIDGET) - LABEL_GAP;

    if (measure(digest) <= available) {
        return digest;
    }

    // The most characters that still fit, found by bisection. Text gets wider
    // as it gets longer, so the fit is monotonic and a search is exact -- and
    // this runs on every step of a resize drag, where measuring a 64-character
    // digest one character at a time is sixty-odd measurements per mouse move.
    const ellipsisWidth = measure(ELLIPSIS);
    let fits = 0;
    let tooMany = digest.length;
    while (fits < tooMany) {
        const chars = Math.ceil((fits + tooMany) / 2);
        if (measure(digest.slice(0, chars)) + ellipsisWidth <= available) {
            fits = chars;
        } else {
            tooMany = chars - 1;
        }
    }
    // Always show something, however narrow the node has been dragged.
    return digest.slice(0, Math.max(fits, 1)) + ELLIPSIS;
}

/** Width at which the node shows DEFAULT_CHARS of digest plus the ellipsis. */
function defaultWidth() {
    const sample = "0".repeat(DEFAULT_CHARS) + ELLIPSIS;
    const needed =
        WIDGET_MARGIN * 2 + measure(DISPLAY_WIDGET) + LABEL_GAP + measure(sample);
    return Math.max(Math.ceil(needed), MIN_WIDTH);
}

function paintNode(node) {
    const display = node.widgets?.find((w) => w.name === DISPLAY_WIDGET);
    if (!display) {
        return;
    }
    const scope = node.widgets?.find((w) => w.name === SCOPE_WIDGET)?.value;
    display.value = digests ? fitDigest(node, digests[scope]) : PENDING;
}

function paint() {
    for (const node of instances) {
        paintNode(node);
    }
    app.graph?.setDirtyCanvas(true, false);
}

async function refresh() {
    if (inFlight || instances.size === 0 || !app.graph) {
        return;
    }

    let serialised;
    try {
        serialised = JSON.stringify(app.graph.serialize());
    } catch (error) {
        console.error("[SouthernComfy] Could not serialise the graph.", error);
        return;
    }
    if (serialised === lastSerialised) {
        return;
    }
    lastSerialised = serialised;

    inFlight = true;
    try {
        const response = await api.fetchApi("/southerncomfy/checksum", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            // The graph is already JSON text, and it is the largest thing here:
            // parsing it back into objects only to stringify those objects
            // again would walk a whole workflow twice for a result identical to
            // wrapping the text as it stands.
            body: `{"workflow":${serialised}}`,
        });
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        digests = await response.json();
        paint();
    } catch (error) {
        console.error("[SouthernComfy] Could not compute the workflow checksum.", error);
        // Force a retry on the next tick rather than sitting on a stale digest.
        lastSerialised = null;
    } finally {
        inFlight = false;
    }
}

function startPolling() {
    timer ??= setInterval(refresh, POLL_MS);
}

function stopPolling() {
    if (timer !== null && instances.size === 0) {
        clearInterval(timer);
        timer = null;
        lastSerialised = null;
    }
}

app.registerExtension({
    name: "SouthernComfy.WorkflowChecksum",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData?.name !== NODE_TYPE) {
            return;
        }

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            onNodeCreated?.apply(this, arguments);

            const display = this.addWidget("text", DISPLAY_WIDGET, PENDING, () => {}, {
                serialize: false,
                read_only: true,
            });
            display.onClick = () => {};

            // Repaint immediately on a scope change: every scope's digest is
            // already cached, so this needs no request.
            const scope = this.widgets?.find((w) => w.name === SCOPE_WIDGET);
            if (scope) {
                const previous = scope.callback;
                scope.callback = function () {
                    const result = previous?.apply(this, arguments);
                    paint();
                    return result;
                };
            }

            // Redraw the digest as the node is resized, so widening it reveals
            // more of the value and narrowing it takes some back.
            const onResize = this.onResize;
            this.onResize = function () {
                const result = onResize?.apply(this, arguments);
                paintNode(this);
                return result;
            };

            const [width, height] = this.computeSize();
            this.setSize([Math.max(width, defaultWidth()), height]);

            instances.add(this);
            startPolling();
            // A newly added node has itself changed the graph, so drop the
            // cached serialisation and let the next tick recompute.
            lastSerialised = null;
        };

        const onRemoved = nodeType.prototype.onRemoved;
        nodeType.prototype.onRemoved = function () {
            instances.delete(this);
            stopPolling();
            onRemoved?.apply(this, arguments);
        };
    },
});
