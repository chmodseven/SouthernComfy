/**
 * Drives the "SC Load Inputs" node: picking a saved run and pasting its values
 * back into the workflow.
 *
 * All of this node's behaviour is here because none of it can be done in
 * Python. ComfyUI's execution is pull-based -- a node receives its own inputs
 * and cannot reach any other node -- so the only place a value can be written
 * into somebody else's widget is the browser, against the live graph.
 *
 * The decisions are still the server's. This sends the chosen file and the
 * current graph to /southerncomfy/restore, which vets the file and compares its
 * `structure` digest with the workflow on the canvas, and returns either the
 * values to apply or a reason it will not. Nothing here re-implements the
 * format or the hashing, so the two halves cannot drift apart.
 *
 * Renderer notes:
 *  - Nodes 2.0 (Vue) honours the `read_only` widget option.
 *  - The legacy renderer ignores it and opens a value editor on click, so the
 *    widget's click handler is suppressed there instead. Marking the widget
 *    `disabled` would work too, but the legacy renderer then hides the value.
 *  - The node has no slots, so legacy needs an explicit header gap; see
 *    `headerGap` below.
 */

// Served from /extensions/SouthernComfy/, so "../../" is the ComfyUI web root.
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const NODE_TYPE = "SC_LoadInputs";
const FILE_WIDGET = "run file";
const BUTTON_WIDGET = "load inputs…";
const NONE = "(none)";
const MIN_WIDTH = 300;

/**
 * Values a `control_after_generate` widget can hold.
 *
 * Matched by value rather than by widget name on purpose: core's KSampler calls
 * the widget `control_after_generate`, but `PrimitiveInt` and `SeedNode` call
 * theirs `fixed` -- the name stays `fixed` whatever the value is, which makes
 * the name useless for recognising one.
 */
const CONTROL_VALUES = new Set(["fixed", "increment", "decrement", "randomize"]);

function toast(severity, summary, detail) {
    const store = app.extensionManager?.toast;
    if (store?.add) {
        store.add({ severity, summary, detail, life: severity === "error" ? 9000 : 5000 });
        return;
    }
    // Older frontends have no toast store. An error must not pass silently.
    const line = detail ? `${summary}: ${detail}` : summary;
    if (severity === "error") {
        console.error(`[SouthernComfy] ${line}`);
        window.alert(line);
    } else {
        console.info(`[SouthernComfy] ${line}`);
    }
}

/**
 * Gap between the node header and the first widget, for the legacy renderer.
 *
 * Legacy starts widgets 2px below the header when a node has no input or output
 * slots, which reads as cramped: core nodes get their breathing room from slot
 * rows. Half a widget row restores a deliberate gap. Nodes 2.0 lays out with
 * CSS and ignores this property.
 */
function headerGap() {
    const widgetHeight = window.LiteGraph?.NODE_WIDGET_HEIGHT ?? 20;
    return widgetHeight / 2;
}

/** Ask the user for a file and return its text, or null if they cancelled. */
function chooseFile() {
    return new Promise((resolve) => {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = ".json,application/json";
        // Firefox needs the element in the document for the change event.
        input.style.display = "none";
        document.body.appendChild(input);

        const finish = (value) => {
            input.remove();
            resolve(value);
        };
        input.addEventListener("change", async () => {
            const file = input.files?.[0];
            if (!file) {
                finish(null);
                return;
            }
            try {
                finish({ name: file.name, text: await file.text() });
            } catch (error) {
                console.error("[SouthernComfy] Could not read the file.", error);
                finish(null);
            }
        });
        // A cancelled picker fires no `change` event in most browsers, so the
        // element would leak. `cancel` is not universal either; both are
        // harmless if they never arrive, because `finish` is idempotent enough.
        input.addEventListener("cancel", () => finish(null));
        input.click();
    });
}

/**
 * The live node an entry refers to, or undefined.
 *
 * A node inside a subgraph carries an id that is unique only within that body,
 * so the entry names its container and the node is looked up there. Ids are
 * numbers in a serialised workflow and strings on a live node, hence the
 * stringify on both sides.
 */
function findNode(entry) {
    const id = String(entry.id);
    if (entry.subgraph === undefined) {
        return app.graph._nodes?.find((node) => String(node.id) === id);
    }
    const body = app.graph._subgraphs?.get?.(entry.subgraph);
    return (body?._nodes ?? []).find((node) => String(node.id) === id);
}

/** Pair each saved value with the widget it belongs to, by name or by position. */
function pairs(entry, widgets) {
    if (Array.isArray(entry.values)) {
        return entry.values.map((value, index) => [widgets[index], value]);
    }
    return Object.entries(entry.values).map(([name, value]) => [
        widgets.find((widget) => widget.name === name),
        value,
    ]);
}

function applyEntry(entry, report) {
    const node = findNode(entry);
    if (!node) {
        report.missingNodes.add(`${entry.type} #${entry.id}`);
        return;
    }
    // The structure digest already guarantees the types line up, so this only
    // fires if the graph was edited between the check and the click. Cheap
    // insurance against writing values onto the wrong kind of node.
    if (String(node.type) !== String(entry.type)) {
        report.retyped.add(`#${entry.id}`);
        return;
    }

    const widgets = node.widgets ?? [];
    for (const [widget, value] of pairs(entry, widgets)) {
        if (!widget) {
            // Normal when a node pack is missing: ComfyUI substitutes a
            // placeholder whose widgets are named UNKNOWN, so nothing matches.
            report.unmatched.add(entry.type);
            continue;
        }

        widget.value = value;
        // Dependent UI goes stale without this -- a combo's linked widgets, a
        // DOM widget's element. Not every widget has one (`customtext` does
        // not), and a third-party callback that throws must not abandon the
        // rest of the restore.
        try {
            widget.callback?.(value, app.canvas, node);
        } catch (error) {
            console.error(
                `[SouthernComfy] ${entry.type} rejected a restored value for "${widget.name}".`,
                error,
            );
        }

        if (widget.type === "combo" && CONTROL_VALUES.has(value) && value !== "fixed") {
            report.willAdvance.add(`${entry.type} #${entry.id}`);
        }
        report.applied += 1;
    }
}

/** Human-readable summary of what a restore did, and what it could not do. */
function summarise(report) {
    const notes = [];
    if (report.unmatched.size) {
        notes.push(
            `${report.unmatched.size} node type(s) had no matching widgets, ` +
                `probably because their node pack is not installed: ` +
                `${[...report.unmatched].join(", ")}.`,
        );
    }
    if (report.missingNodes.size) {
        notes.push(`Not found on the canvas: ${[...report.missingNodes].join(", ")}.`);
    }
    if (report.retyped.size) {
        notes.push(`Changed type since saving: ${[...report.retyped].join(", ")}.`);
    }
    if (report.willAdvance.size) {
        notes.push(
            `Heads up: ${[...report.willAdvance].join(", ")} ` +
                `${report.willAdvance.size === 1 ? "is" : "are"} set to advance after ` +
                `generating, so the restored seed changes again on the next run. ` +
                `Set it to "fixed" to keep it.`,
        );
    }
    return notes.join(" ");
}

async function loadInputs(fileWidget) {
    const chosen = await chooseFile();
    if (!chosen) {
        return;
    }

    let record;
    try {
        record = JSON.parse(chosen.text);
    } catch (error) {
        console.error("[SouthernComfy] The chosen file is not valid JSON.", error);
        toast("error", "Could not load inputs", `${chosen.name} is not valid JSON.`);
        return;
    }

    // The server decides: is this one of ours, and does it fit this graph?
    let plan;
    try {
        const response = await api.fetchApi("/southerncomfy/restore", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ workflow: app.graph.serialize(), record }),
        });
        const body = await response.json();
        if (!response.ok) {
            toast("error", "Could not load inputs", body?.error ?? `HTTP ${response.status}`);
            return;
        }
        plan = body;
    } catch (error) {
        console.error("[SouthernComfy] Could not reach the restore route.", error);
        toast("error", "Could not load inputs", "The SouthernComfy server route did not answer.");
        return;
    }

    const report = {
        applied: 0,
        unmatched: new Set(),
        missingNodes: new Set(),
        retyped: new Set(),
        willAdvance: new Set(),
    };
    for (const entry of plan.nodes) {
        applyEntry(entry, report);
    }

    fileWidget.value = chosen.name;
    app.graph.setDirtyCanvas(true, true);

    const saved = plan.saved_at ? ` saved ${plan.saved_at}` : "";
    const detail = summarise(report);
    if (report.applied === 0) {
        toast("warn", "Nothing restored", detail || `No values in ${chosen.name} could be applied.`);
        return;
    }
    toast(
        detail ? "warn" : "success",
        `Restored ${report.applied} value${report.applied === 1 ? "" : "s"}`,
        `From ${chosen.name}${saved}. ${detail}`.trim(),
    );
}

app.registerExtension({
    name: "SouthernComfy.LoadInputs",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData?.name !== NODE_TYPE) {
            return;
        }

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            onNodeCreated?.apply(this, arguments);

            this.widgets_start_y = headerGap();

            // Which file was last restored from. Informational: a browser hands
            // over a file's name but never its path, so this cannot be used to
            // find the file again -- it is there to say what the node last did.
            const fileWidget = this.addWidget("text", FILE_WIDGET, NONE, () => {}, {
                read_only: true,
            });
            fileWidget.onClick = () => {};

            this.addWidget("button", BUTTON_WIDGET, null, () => {
                loadInputs(fileWidget).catch((error) => {
                    console.error("[SouthernComfy] The restore failed.", error);
                    toast("error", "Could not load inputs", String(error?.message ?? error));
                });
            });

            const [width, height] = this.computeSize();
            this.setSize([Math.max(width, MIN_WIDTH), height]);
        };
    },
});
