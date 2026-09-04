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
 * current graph to /southerncomfy/restore, which vets the file, works out which
 * live node each saved value belongs to, and returns that plan or a reason it
 * will not. Nothing here re-implements the format, the matching or the hashing,
 * so the two halves cannot drift apart.
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

/**
 * Line separator for a multi-line message.
 *
 * A named constant rather than a literal, because a "\n" written inline here is
 * one careless edit away from becoming a real line break -- which is a string
 * literal spanning two lines, a syntax error, and a whole extension that fails
 * to load rather than one message that looks wrong.
 */
const LINE_BREAK = String.fromCharCode(10);

/**
 * Keys never written onto a node, however a file spells them.
 *
 * Assigning `__proto__` replaces an object's prototype rather than adding a
 * key, which would strip a node of every method LiteGraph gave it and take the
 * canvas down with it; `constructor` and `prototype` are the same family of
 * mistake. The server already drops these when it plans a restore -- see
 * `UNSAFE_KEYS` in `run_inputs.py`, which is the authority -- and this is the
 * same rule at the point of assignment, where the damage would be done.
 */
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * LiteGraph's callback naming convention.
 *
 * `extra` is assigned straight onto the node, so a saved key called
 * `onDrawForeground` or `onExecute` replaces a hook the canvas calls -- with a
 * value out of a file, which LiteGraph then tries to call. No pack can be
 * keeping state under one of these names, because the name already belongs to
 * the callback it would shadow.
 */
const CALLBACK_KEY = /^on[A-Z]/;

function refuseKey(entry, kind, key) {
    console.warn(
        `[SouthernComfy] Refusing to restore the ${kind} "${key}" onto ${entry.type}: ` +
            `it would alter the node itself rather than its state.`,
    );
}

function toast(severity, summary, detail) {
    const line = detail ? `${summary} - ${detail}` : summary;
    // Always logged, whatever the toast does: a toast is gone once dismissed,
    // and this is the only way back to the detail of an earlier restore.
    const log = severity === "error" ? console.error : severity === "warn" ? console.warn : console.info;
    log(`[SouthernComfy] ${line}`);

    const store = app.extensionManager?.toast;
    if (store?.add) {
        // No `life`: the message stays until the user dismisses it with its
        // close button. These report what did and did not happen to a whole
        // workflow's values, which is more than can be read in a few seconds.
        store.add({ severity, summary, detail });
        return;
    }
    // Older frontends have no toast store. An error must not pass silently.
    if (severity === "error") {
        window.alert(line);
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

/**
 * The saved values of an entry, as [widget name or index, value] pairs.
 *
 * Deliberately *not* resolved to widget objects here. A widget's callback may
 * rebuild the node's widget list -- any node with a "number of inputs" control
 * does exactly that -- so a list captured before the first assignment can be
 * stale by the third, leaving later values written to orphaned objects that
 * nothing on screen refers to any more. Each widget is therefore looked up
 * again immediately before it is written.
 */
function savedValues(entry) {
    return Array.isArray(entry.values) ? entry.values.entries() : Object.entries(entry.values);
}

/** Find the widget a saved value belongs to, in the node as it stands *now*. */
function currentWidget(node, key) {
    const widgets = node.widgets ?? [];
    return typeof key === "number" ? widgets[key] : widgets.find((w) => w.name === key);
}

/** Join names for a message, abbreviating a long list rather than dumping it. */
function listing(names) {
    const MAX = 5;
    return names.length <= MAX
        ? names.join(", ")
        : `${names.slice(0, MAX).join(", ")} and ${names.length - MAX} more`;
}

/**
 * A saved-at stamp a person can read.
 *
 * The record holds ISO 8601 with an offset, which is right for a file and
 * unfriendly in a sentence -- and long enough that wrapping used to break it in
 * half. Rendered in the reader's own locale, falling back to the raw string if
 * it cannot be parsed.
 */
function formatSaved(iso) {
    const when = new Date(iso);
    return Number.isNaN(when.getTime()) ? iso : when.toLocaleString();
}

/** How to refer to a node in a message: the user's title if they set one. */
function label(entry) {
    return `${entry.title || entry.type} #${entry.id}`;
}

function applyEntry(entry, report) {
    const node = findNode(entry);
    if (!node) {
        report.missingNodes.add(label(entry));
        return;
    }
    // The server planned this against the same graph, so a mismatch here means
    // the canvas changed between the check and the click. Cheap insurance
    // against writing values onto the wrong kind of node.
    if (String(node.type) !== String(entry.type)) {
        report.retyped.add(`#${entry.id}`);
        return;
    }

    for (const [key, value] of savedValues(entry)) {
        const widget = currentWidget(node, key);
        if (!widget) {
            // Normal when a node pack is missing: ComfyUI substitutes a
            // placeholder whose widgets are named UNKNOWN, so nothing matches.
            report.unmatched.add(entry.type);
            continue;
        }

        widget.value = value;
        // Dependent UI goes stale without this -- a combo's linked widgets, a
        // DOM widget's element, a control that adds or removes other widgets.
        // Not every widget has one (`customtext` does not), and a third-party
        // callback that throws must not abandon the rest of the restore.
        try {
            widget.callback?.(value, app.canvas, node);
        } catch (error) {
            console.error(
                `[SouthernComfy] ${entry.type} rejected a restored value for "${widget.name}".`,
                error,
            );
        }

        if (widget.type === "combo" && CONTROL_VALUES.has(value) && value !== "fixed") {
            report.willAdvance.add(label(entry));
        }
        report.applied += 1;
    }

    applyProperties(node, entry, report);
    applyExtra(node, entry, report);
}

/**
 * Put back a node's `properties`.
 *
 * This is where most third-party state actually lives -- cg-use-everywhere,
 * rgthree's group togglers, Reroute's orientation, core's own "Node name for
 * S&R" -- so a restore that only replaced widget values would leave a good deal
 * of a workflow untouched.
 *
 * `setProperty` is used in preference to assignment where LiteGraph offers it,
 * because it also notifies the node: a pack that reacts to one of its own
 * properties changing gets that chance, exactly as if the user had edited it in
 * the properties panel.
 */
function applyProperties(node, entry, report) {
    if (!entry.properties) {
        return;
    }
    node.properties ??= {};
    for (const [key, value] of Object.entries(entry.properties)) {
        if (UNSAFE_KEYS.has(key)) {
            refuseKey(entry, "property", key);
            continue;
        }
        try {
            if (typeof node.setProperty === "function") {
                node.setProperty(key, value);
            } else {
                node.properties[key] = value;
            }
            report.properties += 1;
        } catch (error) {
            console.error(
                `[SouthernComfy] ${entry.type} rejected the property "${key}".`,
                error,
            );
        }
    }
}

/**
 * Put back whatever a node serialised outside the fields ComfyUI defines.
 *
 * Rare -- one such key across a 26-workflow corpus -- but a node that keeps its
 * state this way has no other route back. Assignment is all LiteGraph itself
 * does when loading a workflow.
 */
function applyExtra(node, entry, report) {
    if (!entry.extra) {
        return;
    }
    for (const [key, value] of Object.entries(entry.extra)) {
        // A node's own serialised state is data. Anything landing on a hook --
        // whether one the node already has, or one it has simply not needed yet
        // -- is a file describing something other than what it claims to, and
        // LiteGraph calling a restored string breaks the node on its next frame.
        if (UNSAFE_KEYS.has(key) || CALLBACK_KEY.test(key) || typeof node[key] === "function") {
            refuseKey(entry, "state", key);
            continue;
        }
        try {
            node[key] = value;
            report.extra += 1;
        } catch (error) {
            console.error(`[SouthernComfy] ${entry.type} rejected the state "${key}".`, error);
        }
    }
}

/**
 * The lines of a restore's result, most important first.
 *
 * Returned as separate lines rather than one paragraph: these reports carry
 * several unrelated facts, and running them together made a wall of prose in
 * which a timestamp could end up split across the middle of a sentence.
 */
function summarise(report, plan) {
    const notes = [];

    if (plan.rematched?.length) {
        // Deleting a node and adding it back gives it a new id, so a graph can
        // be identical in every way that matters and still not match by id.
        // Worth saying plainly: those values landed where the server inferred
        // they belonged, rather than where the file said.
        const one = plan.rematched.length === 1;
        notes.push(
            `This graph appears to have been rebuilt: ${listing(plan.rematched)} ` +
                `no longer ${one ? "has" : "have"} the id ${one ? "it was" : "they were"} ` +
                `saved under, so ${one ? "it was" : "they were"} matched by node type instead.`,
        );
    }
    if (plan.changed === "structure") {
        // Never a failure: values are matched node by node, so a graph that has
        // gained nodes since the run restores perfectly well. Said out loud
        // because it explains a result that might otherwise look partial.
        notes.push("The structure of this workflow has changed since the file was saved.");
    } else if (plan.changed === "layout") {
        notes.push(
            "This workflow has been rearranged since the file was saved, but its structure " +
                "is unchanged.",
        );
    }
    if (report.unmatched.size) {
        notes.push(
            `${report.unmatched.size} node type(s) had no matching widgets, ` +
                `probably because their node pack is not installed: ` +
                `${listing([...report.unmatched])}.`,
        );
    }
    if (plan.skipped?.length) {
        notes.push(
            `Settings not restored, because ${plan.skipped.length === 1 ? "its node is" : "their nodes are"} ` +
                `no longer here: ${listing(plan.skipped)}.`,
        );
    }
    if (report.missingNodes.size) {
        notes.push(`Not found on the canvas: ${listing([...report.missingNodes])}.`);
    }
    if (report.retyped.size) {
        notes.push(`Changed type since saving: ${listing([...report.retyped])}.`);
    }
    if (report.willAdvance.size) {
        const one = report.willAdvance.size === 1;
        notes.push(
            `Heads up: ${listing([...report.willAdvance])} ` +
                `${one ? "is" : "are"} set to advance after generating, so the restored ` +
                `seed${one ? "" : "s"} will change again on the next run. ` +
                `Set ${one ? "it" : "them"} to "fixed" to keep ${one ? "it" : "them"}.`,
        );
    }
    return notes;
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
        properties: 0,
        extra: 0,
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

    const notes = summarise(report, plan);

    // Provenance first, each fact on its own line, so nothing runs into the
    // middle of the timestamp.
    const header = [`From ${chosen.name}`];
    if (plan.saved_at) {
        header.push(`Saved ${formatSaved(plan.saved_at)}`);
    }
    if (plan.description) {
        header.push(`"${plan.description}"`);
    }
    if (report.properties || report.extra) {
        header.push(
            `Also restored ${report.properties + report.extra} node ` +
                `${report.properties + report.extra === 1 ? "setting" : "settings"}.`,
        );
    }

    if (report.applied === 0 && !report.properties && !report.extra) {
        toast(
            "warn",
            "Nothing restored",
            [...header, "", ...(notes.length ? notes : ["Nothing in this file could be applied."])].join(
                LINE_BREAK,
            ),
        );
        return;
    }
    // A "changed" note on its own is information; anything else is a caveat the
    // user needs to act on -- a value that did not land, or a seed that will
    // move again by itself.
    const caveats =
        report.unmatched.size +
        report.missingNodes.size +
        report.retyped.size +
        report.willAdvance.size +
        (plan.rematched?.length ?? 0);
    toast(
        caveats ? "warn" : "success",
        `Restored ${report.applied} value${report.applied === 1 ? "" : "s"}`,
        [...header, ...(notes.length ? ["", ...notes] : [])].join(LINE_BREAK),
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
            // `serialize: false` keeps both of these out of the API prompt.
            // Neither is an input: one is a label, the other a button, and
            // without this the frontend sends them to the backend as though a
            // run depended on them -- where they turn up in the `resolved` half
            // of anything SC Save Inputs writes. They still persist in the
            // workflow's `widgets_values`, which is what keeps the label across
            // a reload.
            const fileWidget = this.addWidget("text", FILE_WIDGET, NONE, () => {}, {
                read_only: true,
                serialize: false,
            });
            fileWidget.onClick = () => {};

            this.addWidget("button", BUTTON_WIDGET, null, () => {
                // One restore at a time. A restore waits twice -- for the file
                // dialog, then for the server's plan -- and a second click
                // during either would interleave two sets of values across the
                // same widgets, in an order neither file describes.
                if (this._scRestoring) {
                    return;
                }
                this._scRestoring = true;
                loadInputs(fileWidget)
                    .catch((error) => {
                        console.error("[SouthernComfy] The restore failed.", error);
                        toast("error", "Could not load inputs", String(error?.message ?? error));
                    })
                    .finally(() => {
                        this._scRestoring = false;
                    });
            }, { serialize: false });

            const [width, height] = this.computeSize();
            this.setSize([Math.max(width, MIN_WIDTH), height]);
        };
    },
});
