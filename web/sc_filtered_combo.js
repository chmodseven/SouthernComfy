/**
 * Persistent, saved filters on any dropdown -- base or third-party.
 *
 * Long combo lists (checkpoints, LoRAs, samplers) are tedious to work in.
 * ComfyUI already offers an ad-hoc "Filter list" box while a dropdown is open,
 * but it forgets what you typed the moment you close it. This attaches a filter
 * that *stays*, narrowing the list until you clear it.
 *
 * Why this is not a node
 * ----------------------
 * A combo's options belong to the node that declares them, and ComfyUI has no
 * backend `PrimitiveCombo` -- dragging a dropdown out builds a frontend-only
 * virtual node. Enhancing the real widget in place therefore reaches every
 * node, needs no wiring, and sidesteps the `control_after_generate` widget that
 * the primitive route drags along with it.
 *
 * Storage
 * -------
 * The filter lives in `node.properties` under `sc_filter:<widget name>`, so it
 * is saved and restored with the workflow at no cost. The property is created
 * only when a filter is actually set, so untouched nodes are never polluted.
 *
 * Renderer notes: the filter is applied to `options.values` as a plain array.
 * LiteGraph also accepts a function there, but the frontend logs a deprecation
 * warning for it, so the array form is the one with a future.
 */

// Served from /extensions/SouthernComfy/, so "../../" is the ComfyUI web root.
import { app } from "../../scripts/app.js";

const PROPERTY_PREFIX = "sc_filter:";
const MENU_LABEL = "SC Combo Filter";
const REGEX_SYNTAX = /^\/(.*)\/([gimsuy]*)$/;

/** Original, unfiltered option list, cached per widget and never serialised. */
const ORIGINALS = new WeakMap();

/**
 * Last known pointer position, in viewport coordinates.
 *
 * Menus and dialogs are positioned from the event that opened them, but Nodes
 * 2.0 builds the node menu itself and hands callbacks an event with no
 * coordinates -- everything then lands in the top-left corner. Listening on the
 * capture phase records the position before any menu can stop propagation, so
 * there is always something sensible to fall back to.
 */
let lastPointer = { clientX: 0, clientY: 0 };
for (const type of ["pointerdown", "pointerup", "contextmenu"]) {
    window.addEventListener(
        type,
        (event) => {
            if (typeof event.clientX === "number" && (event.clientX || event.clientY)) {
                lastPointer = { clientX: event.clientX, clientY: event.clientY };
            }
        },
        true,
    );
}

/**
 * The event if it carries coordinates, otherwise a stand-in at the last pointer
 * position.
 *
 * The stand-in is a real `MouseEvent` rather than a bare `{clientX, clientY}`
 * object: `LiteGraph.ContextMenu` reads more off the event than those two
 * fields, and quietly falls back to the top-left corner when handed a plain
 * object.
 */
function positioned(event) {
    if (typeof event?.clientX === "number" && (event.clientX || event.clientY)) {
        return event;
    }
    return new MouseEvent("click", {
        clientX: lastPointer.clientX,
        clientY: lastPointer.clientY,
        bubbles: true,
    });
}

function propertyName(widget) {
    return `${PROPERTY_PREFIX}${widget.name}`;
}

function comboWidgets(node) {
    return (node.widgets ?? []).filter(
        (w) => w?.type === "combo" && Array.isArray(w.options?.values),
    );
}

function allValues(widget) {
    if (!ORIGINALS.has(widget)) {
        ORIGINALS.set(widget, [...widget.options.values]);
    }
    return ORIGINALS.get(widget);
}

/**
 * Build a predicate from a filter string.
 *
 * Plain text matches as a case-insensitive substring. Text wrapped in slashes
 * is a regular expression, so `/^sdxl/i` and `flux` are both valid without
 * needing a second control to say which is which.
 */
function makeMatcher(filter) {
    const text = String(filter ?? "").trim();
    if (!text) {
        return null;
    }

    const asRegex = REGEX_SYNTAX.exec(text);
    if (asRegex) {
        try {
            // "g" is stripped: a stateful regex would match every other call.
            const regex = new RegExp(asRegex[1], asRegex[2].replace(/g/g, ""));
            return (value) => regex.test(String(value));
        } catch (error) {
            console.warn(`[SouthernComfy] Ignoring invalid filter regex "${text}".`, error);
            return null;
        }
    }

    const needle = text.toLowerCase();
    return (value) => String(value).toLowerCase().includes(needle);
}

/**
 * Apply a widget's saved filter to its option list.
 *
 * A value outside the filter is cleared rather than kept. Setting a filter is
 * a statement that only matching values are wanted from now on, which makes any
 * existing value suspect; leaving a non-conforming one in place would quietly
 * defeat the filter that was just asked for. Clearing forces an explicit
 * reselection from the narrowed list. The same applies when a filter matches
 * nothing: the dropdown is left empty so the filter itself has to be fixed.
 *
 * Note this also fires when a saved workflow is opened, so a value that no
 * longer matches -- because the filter was edited elsewhere, or the underlying
 * file was removed -- is cleared on load and must be reselected before the
 * workflow will run.
 */
function applyFilter(node, widget) {
    const filter = node.properties?.[propertyName(widget)];
    const original = allValues(widget);
    const match = makeMatcher(filter);

    if (!match) {
        widget.options.values = [...original];
        widget.label = undefined;
        return;
    }

    const kept = original.filter(match);
    widget.options.values = kept;

    if (kept.length === 0) {
        console.warn(
            `[SouthernComfy] Filter "${filter}" on "${widget.name}" matched nothing; the value has been cleared.`,
        );
        widget.label = `${widget.name}  [${filter} — no match]`;
    } else {
        widget.label = `${widget.name}  [${filter}]`;
    }

    if (widget.value != null && !kept.includes(widget.value)) {
        widget.value = null;
    }
}

function applyAll(node) {
    for (const widget of comboWidgets(node)) {
        applyFilter(node, widget);
    }
}

/**
 * A one-field prompt, positioned at the pointer, identical in both renderers.
 *
 * `LGraphCanvas.prototype.prompt` is deliberately not used. It positions itself
 * relative to the graph canvas's parent, which is at the origin under the legacy
 * renderer but somewhere else entirely under Nodes 2.0 -- so the same dialog
 * lands under the cursor in one and across the screen in the other. It also
 * reads `LGraphCanvas.active_canvas`, which is unset until the canvas has been
 * interacted with, and throws outright when it is not. It does no clamping
 * either, so a prompt opened near an edge runs off screen.
 *
 * The markup and class names are LiteGraph's own, so the dialog inherits
 * ComfyUI's styling and looks native in both renderers; only the positioning
 * and lifecycle are ours.
 */
function openPrompt({ title, value, at, onCommit }) {
    document.querySelectorAll(".sc-filter-dialog").forEach((old) => old.remove());

    const dialog = document.createElement("div");
    dialog.className = "graphdialog rounded sc-filter-dialog";
    dialog.style.position = "fixed";
    dialog.style.zIndex = "10000";

    const label = document.createElement("span");
    label.className = "name";
    label.textContent = title;

    const input = document.createElement("input");
    input.className = "value";
    input.type = "text";
    input.value = value ?? "";

    const confirm = document.createElement("button");
    confirm.className = "rounded";
    confirm.textContent = "OK";

    dialog.append(label, input, confirm);
    document.body.append(dialog);

    // Measured only once it is in the document, so it can be kept on screen.
    const margin = 8;
    const { width, height } = dialog.getBoundingClientRect();
    let left = at.clientX - 20;
    let top = at.clientY - 20;
    // A hidden or not-yet-laid-out window reports a zero viewport; clamping
    // against that would pin every dialog to the corner.
    if (window.innerWidth > 0 && window.innerHeight > 0) {
        const maxLeft = Math.max(margin, window.innerWidth - width - margin);
        const maxTop = Math.max(margin, window.innerHeight - height - margin);
        left = Math.min(Math.max(margin, left), maxLeft);
        top = Math.min(Math.max(margin, top), maxTop);
    }
    dialog.style.left = `${Math.round(left)}px`;
    dialog.style.top = `${Math.round(top)}px`;

    const closeOnOutside = (event) => {
        if (!dialog.contains(event.target)) {
            close();
        }
    };
    function close() {
        document.removeEventListener("pointerdown", closeOnOutside, true);
        dialog.remove();
    }
    function commit() {
        const entered = input.value;
        close();
        onCommit(entered);
    }

    confirm.addEventListener("click", commit);
    input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
            event.preventDefault();
            commit();
        } else if (event.key === "Escape") {
            event.preventDefault();
            close();
        }
        // Otherwise let the keystroke be: ComfyUI binds single-key shortcuts
        // globally, and they must not fire while typing a filter.
        event.stopPropagation();
    });

    // Deferred by a frame so the click that opened the dialog cannot close it.
    requestAnimationFrame(() => document.addEventListener("pointerdown", closeOnOutside, true));
    input.focus();
    input.select();
}

/**
 * Ask for a filter and store the answer.
 */
function askForFilter(node, widget, event) {
    openPrompt({
        // Kept short deliberately: the dialog is one inline row of label, input
        // and OK button, so a long label wraps and squeezes the input. The regex
        // syntax is documented rather than crammed in here.
        title: `Filter: ${widget.name}`,
        value: node.properties?.[propertyName(widget)] ?? "",
        at: positioned(event),
        onCommit: (value) => {
            const text = String(value ?? "").trim();
            if (text) {
                node.properties[propertyName(widget)] = text;
            } else {
                // Clearing removes the property rather than storing "", so a
                // node with no filter carries no trace of ever having had one.
                delete node.properties[propertyName(widget)];
            }
            applyFilter(node, widget);
            app.graph?.setDirtyCanvas(true, true);
        },
    });
}

app.registerExtension({
    name: "SouthernComfy.FilteredCombo",

    nodeCreated(node) {
        const widgets = comboWidgets(node);
        if (widgets.length === 0) {
            return;
        }

        // Properties arrive with the workflow, after the node is built, so the
        // filters have to be re-applied once configuration has landed.
        const onConfigure = node.onConfigure;
        node.onConfigure = function () {
            const result = onConfigure?.apply(this, arguments);
            applyAll(this);
            return result;
        };

        const getExtraMenuOptions = node.getExtraMenuOptions;
        node.getExtraMenuOptions = function (canvas, options) {
            const result = getExtraMenuOptions?.apply(this, arguments);

            const combos = comboWidgets(this);
            if (combos.length > 0) {
                const node = this;
                options.push({
                    content: MENU_LABEL,
                    // Deliberately *not* marked `has_submenu`, and not given a
                    // declared `submenu` object either. Nodes 2.0 rebuilds the
                    // node menu itself: a declared submenu renders an arrow that
                    // does nothing, and `has_submenu` makes it swallow the click
                    // without calling the callback. A plain item whose callback
                    // opens a `LiteGraph.ContextMenu` behaves identically in
                    // both renderers, which is why it is done this way.
                    callback: (_value, _options, menuEvent, parentMenu) => {
                        const items = combos.map((widget) => {
                            const active = node.properties?.[propertyName(widget)];
                            return {
                                content: active ? `${widget.name}  [${active}]` : widget.name,
                                callback: (_v, _o, itemEvent) =>
                                    askForFilter(node, widget, positioned(itemEvent)),
                            };
                        });
                        new LiteGraph.ContextMenu(items, {
                            event: positioned(menuEvent),
                            parentMenu,
                            title: MENU_LABEL,
                        });
                    },
                });
            }

            return result;
        };

        applyAll(node);
    },
});
