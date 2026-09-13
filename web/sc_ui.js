/**
 * Shared frontend helpers for SouthernComfy nodes.
 *
 * Everything here was paid for once by SC Label and would otherwise be paid for
 * again by every node that needs a small control of its own. Each function
 * carries the trap it exists to avoid.
 *
 * The module lives at the web root, like every other .js in this pack, because
 * files served from /extensions/SouthernComfy/ can only resolve
 * "../../scripts/app.js" from there.
 *
 * Note for the next reader: SC Label still carries its own copies of the panel
 * and pointer code. They were written first and are identical in behaviour;
 * they should be deleted in favour of these, and were left alone only because
 * that node was mid-review when this module was written.
 */

// Served from /extensions/SouthernComfy/, so "../../" is the ComfyUI web root.
import { app } from "../../scripts/app.js";

/**
 * Whether the Nodes 2.0 renderer is the one drawing the canvas.
 *
 * Asked every time rather than cached: it is a user setting and can be flipped
 * live, and flipping it settles asynchronously -- a render in the same tick as
 * the change still reads the old value and corrects itself on the next one.
 */
export function vueNodes() {
    return !!app.ui?.settings?.getSettingValue("Comfy.VueNodes.Enabled");
}

/** Add a stylesheet once, keyed by id. Safe to call from anywhere, repeatedly. */
export function installStyles(id, css) {
    if (document.getElementById(id)) {
        return;
    }
    const sheet = document.createElement("style");
    sheet.id = id;
    sheet.textContent = css;
    document.head.append(sheet);
}

/**
 * Last known pointer position, in viewport coordinates.
 *
 * A menu callback does not reliably carry coordinates, and the browser anchors
 * a native color picker to its own input element -- so an input left at the
 * origin opens the picker in the corner of the screen, far from the menu that
 * asked for it.
 */
const lastPointer = { clientX: 0, clientY: 0 };
let tracking = false;

/** Start following the pointer. Idempotent: call it from every setup() hook. */
export function trackPointer() {
    if (tracking) {
        return;
    }
    tracking = true;
    for (const type of ["pointerdown", "pointerup", "contextmenu"]) {
        document.addEventListener(
            type,
            (event) => {
                if (typeof event.clientX === "number" && (event.clientX || event.clientY)) {
                    lastPointer.clientX = event.clientX;
                    lastPointer.clientY = event.clientY;
                }
            },
            true,
        );
    }
}

/**
 * Where to put something a menu item asked for.
 *
 * A nullish coalesce is the wrong operator here, and using it is why a picker
 * went on opening in the corner of the screen after being taught to follow the
 * pointer: Nodes 2.0 hands a menu callback an event carrying clientX 0 rather
 * than no coordinates at all, and zero is not null, so the fallback never ran.
 * A logical or is right for a coordinate -- the top-left pixel of the viewport
 * is not a position anything was ever deliberately opened at.
 */
export function pointOf(at) {
    return {
        x: Math.round(at?.clientX || lastPointer.clientX),
        y: Math.round(at?.clientY || lastPointer.clientY),
    };
}

const PANEL_STYLE_ID = "sc-ui-styles";

/**
 * Panels of this pack's own, rather than LiteGraph's.
 *
 * LGraphCanvas.prototype.prompt throws under Nodes 2.0 -- "Cannot destructure
 * property 'canvas' of 'LGraphCanvas.active_canvas' as it is undefined",
 * because 2.0 never sets the active canvas its dialog code assumes -- and
 * window.prompt is no substitute either, since ComfyUI Desktop is Electron and
 * it does nothing there.
 *
 * Fixed to the viewport, so panning the graph underneath cannot carry a panel
 * off, and styled to sit with ComfyUI's dark surfaces rather than to match them
 * exactly: a theme this does not know about should still get a readable box.
 */
const PANEL_CSS = `
.sc-panel {
    position: fixed;
    z-index: 10000;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 10px;
    border: 1px solid rgba(255, 255, 255, 0.15);
    border-radius: 6px;
    background: #353535;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.5);
    font-family: sans-serif;
}
.sc-panel input[type="range"] { width: 150px; accent-color: #7a7a7a; }
.sc-panel input[type="number"],
.sc-panel .sc-panel-hex {
    width: 56px;
    padding: 2px 4px;
    border: 1px solid rgba(255, 255, 255, 0.2);
    border-radius: 3px;
    background: #222;
    color: #ddd;
    font-size: 12px;
}
.sc-panel .sc-panel-hex { width: 88px; font-family: monospace; }
/* A real, visible control: this is the element the browser's own color dialog
   anchors to, and an invisible one it may anchor anywhere it likes. */
.sc-panel .sc-panel-swatch {
    width: 34px;
    height: 24px;
    padding: 0;
    border: 1px solid rgba(255, 255, 255, 0.25);
    border-radius: 3px;
    background: none;
    cursor: pointer;
}
.sc-panel .sc-panel-button {
    padding: 3px 8px;
    border: 1px solid rgba(255, 255, 255, 0.2);
    border-radius: 3px;
    background: #222;
    color: #ddd;
    font-size: 12px;
    cursor: pointer;
}
.sc-panel .sc-panel-button:hover { background: #2c2c2c; }
`;

/** The one panel these helpers open into, if any. */
let openedPanel = null;

/**
 * Put a panel on screen at the pointer, and keep it inside the window.
 *
 * Positioned after appending so it can be measured first, and dismissed on the
 * next pointerdown outside it.
 */
export function openPanel(panel, at) {
    installStyles(PANEL_STYLE_ID, PANEL_CSS);
    document.body.append(panel);
    const box = panel.getBoundingClientRect();
    const where = pointOf(at);
    panel.style.left = `${Math.max(4, Math.min(window.innerWidth - box.width - 4, where.x))}px`;
    panel.style.top = `${Math.max(4, Math.min(window.innerHeight - box.height - 4, where.y))}px`;

    // Anywhere else finishes, keeping whatever is showing. The color dialog a
    // swatch opens is outside the document, so a click in it is not a click
    // anywhere else.
    const dismiss = (event) => !panel.contains(event.target) && closePanel();
    openedPanel = { panel, dismiss };
    document.addEventListener("pointerdown", dismiss, true);
}

export function closePanel() {
    if (!openedPanel) {
        return;
    }
    document.removeEventListener("pointerdown", openedPanel.dismiss, true);
    openedPanel.panel.remove();
    openedPanel = null;
}

/** ComfyUI binds bare keys to commands, so typing must not reach the canvas. */
function guardKeys(element, { onEnter, onEscape }) {
    element.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
            onEnter?.();
        } else if (event.key === "Escape") {
            onEscape?.();
        }
        event.stopPropagation();
    });
}

/**
 * Ask for a color, from a panel of our own at the pointer.
 *
 * **Where a browser puts the native color dialog is not ours to decide.** It is
 * anchored to the input that opened it, and two rounds went into moving an
 * invisible, nought-by-nought, pointer-events-none input to the pointer before
 * it was clear that the coordinates had never been the problem: a browser has
 * no obligation to anchor a dialog to something that is not really there, and
 * Chrome puts it in the corner of the screen.
 *
 * So this is a control that is really there -- a visible swatch the dialog can
 * anchor to, and a hex field beside it so the dialog is never required at all.
 * The extras carry values a color picker cannot express: "no background at
 * all", "back to the theme's own color".
 *
 * @param {object} options
 * @param {string} options.current The value the panel opens on.
 * @param {*} options.at The menu event, if there was one.
 * @param {(value: string) => void} options.onApply Called with every value tried.
 * @param {{label: string, value: string, title?: string}[]} [options.extras]
 */
export function openColorPanel({ current, at, onApply, extras = [] }) {
    closePanel();
    const started = String(current ?? "");
    const isHex = (value) => /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(value);
    const hexOf = (value) => (/^#[0-9a-f]{6}$/i.test(value) ? value : "#ffffff");

    const panel = document.createElement("div");
    panel.className = "sc-panel";

    const swatch = document.createElement("input");
    swatch.type = "color";
    swatch.className = "sc-panel-swatch";
    swatch.value = hexOf(started);
    swatch.title = "Open the color picker";

    const hex = document.createElement("input");
    hex.type = "text";
    hex.className = "sc-panel-hex";
    hex.spellcheck = false;
    hex.value = started;

    const apply = (value, from) => {
        onApply(value);
        if (from !== swatch && /^#[0-9a-f]{6}$/i.test(value)) {
            swatch.value = value;
        }
        if (from !== hex) {
            hex.value = value;
        }
    };

    swatch.addEventListener("input", () => apply(swatch.value, swatch));
    hex.addEventListener("input", () => {
        // Only once it is a color. Applying every keystroke would repaint from
        // "#ff" on the way to "#ff8800".
        const typed = hex.value.trim();
        if (isHex(typed) || extras.some((extra) => extra.value === typed)) {
            apply(typed, hex);
        }
    });
    panel.append(swatch, hex);

    for (const extra of extras) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "sc-panel-button";
        button.textContent = extra.label;
        if (extra.title) {
            button.title = extra.title;
        }
        button.addEventListener("click", () => apply(extra.value, null));
        panel.append(button);
    }

    for (const element of [swatch, hex]) {
        guardKeys(element, {
            onEnter: closePanel,
            onEscape: () => {
                apply(started, null);
                closePanel();
            },
        });
    }

    openPanel(panel, at);
    hex.focus();
    hex.select();
}

/**
 * A slider and a number box for a point size, applied as it is dragged.
 *
 * A size is a value people arrive at by looking rather than by knowing, so it
 * takes effect live and Escape puts back the one they started with. onApply
 * returns the value that was actually applied, so the two controls can be held
 * in step with a value that was clamped.
 */
export function openFontSizePanel({ current, min, max, sliderMax, at, onApply }) {
    closePanel();
    const started = Number(current);

    const panel = document.createElement("div");
    panel.className = "sc-panel";
    const slider = document.createElement("input");
    slider.type = "range";
    slider.min = String(min);
    slider.max = String(sliderMax);
    slider.step = "1";
    slider.value = String(Math.min(sliderMax, started));
    const number = document.createElement("input");
    number.type = "number";
    number.min = String(min);
    number.max = String(max);
    number.step = "1";
    number.value = String(started);
    panel.append(slider, number);

    const apply = (value, from) => {
        const applied = onApply(value);
        if (from !== slider) {
            slider.value = String(Math.min(sliderMax, applied));
        }
        if (from !== number) {
            number.value = String(applied);
        }
    };
    slider.addEventListener("input", () => apply(slider.value, slider));
    number.addEventListener("input", () => apply(number.value, number));
    // Only once the typing has stopped. Correcting the box on every keystroke
    // would fight the user halfway through a two-digit number; correcting it
    // when they leave it stops a typed 1 sitting there beside a node at 4.
    number.addEventListener("change", () => {
        number.value = String(onApply(number.value));
    });
    for (const element of [slider, number]) {
        guardKeys(element, {
            onEnter: closePanel,
            onEscape: () => {
                onApply(started);
                closePanel();
            },
        });
    }

    openPanel(panel, at);
    number.focus();
    number.select();
}

/**
 * The point sizes as a submenu, with a typed one at the end.
 *
 * A menu rather than the properties panel's slider, because Nodes 2.0 has no
 * properties panel and the context menu is the one surface both renderers
 * share. Built by hand as a LiteGraph.ContextMenu rather than declared, because
 * a declared submenu object is rebuilt and ignored by 2.0.
 */
export function fontSizeSubmenu({ current, sizes, event, parent, title, onPick, onCustom }) {
    const entries = sizes.map((size) => ({
        content: size === current ? `${size}  ✓` : `${size}`,
        callback: () => onPick(size),
    }));
    entries.push({
        // Deliberately not positioned from the event: that is the click which
        // opened this submenu, a menu's width away from the "Custom" the user
        // has just pressed. The tracked pointer is where they actually are.
        content: "Custom…",
        callback: () => onCustom(),
    });
    new window.LiteGraph.ContextMenu(entries, { event, parentMenu: parent, title });
    return false;
}

/**
 * Corner radii, matching exactly what Nodes 2.0 draws for each node shape.
 *
 * Read from `LGraphNode.vue` rather than guessed, because the card shape is not
 * what it sounds like: it is **not** rounded across the top. 2.0 gives it
 * `rounded-tl-xl rounded-br-xl` -- twelve pixels on the *top-left and
 * bottom-right only*, a diagonal pair -- and its selection ring
 * `rounded-tl-[19px] rounded-br-[19px]`. `box` has no rounding anywhere, and
 * everything else is `rounded-xl` with a `rounded-[15px]` ring.
 *
 * Note the ring is not simply the body radius plus its three pixels of
 * clearance: 2.0 uses 15 against a 12px body, and 19 on a card. Its numbers are
 * used verbatim so that a node painting its own surface rings like every other.
 */
const VUE_BODY_RADIUS = 12;
const RING_RADIUS = 15;
const CARD_RING_RADIUS = 19;

/**
 * The shape a node is set to, as a lower-case name.
 *
 * The **raw string** is what is read, never `renderingShape`. An own accessor on
 * every node instance shadows LiteGraph's `shape` setter and never delegates to
 * it, so `_shape` and `renderingShape` are stuck on the default for ever and
 * only the string is true. Nodes 2.0 reads the same string for its own nodes,
 * which is exactly why shapes work there and not in the legacy renderer.
 * Numeric `RenderShape` values are still honoured, for a workflow that stored
 * one back when the setter worked.
 */
const SHAPE_NAMES = { 1: "box", 2: "round", 3: "circle", 4: "card" };

function shapeName(node) {
    const shape = node?.shape;
    if (typeof shape === "string") {
        return shape.toLowerCase();
    }
    return SHAPE_NAMES[shape] ?? "default";
}

/** The radius for a box a node paints itself, following the Shape menu. */
export function paintRadius(node, base = VUE_BODY_RADIUS) {
    switch (shapeName(node)) {
        case "box":
            return "0";
        case "card":
            return `${base}px 0 ${base}px 0`;
        default:
            return `${base}px`;
    }
}

/** The radius for the selection ring around such a box, in 2.0's own figures. */
export function ringRadius(node) {
    switch (shapeName(node)) {
        case "box":
            return "0";
        case "card":
            return `${CARD_RING_RADIUS}px 0 ${CARD_RING_RADIUS}px 0`;
        default:
            return `${RING_RADIUS}px`;
    }
}

/** The body radius Nodes 2.0 gives an ordinary node, for painting to match. */
export function bodyRadius() {
    return vueNodes() ? VUE_BODY_RADIUS : (window.LiteGraph?.ROUND_RADIUS ?? 8);
}

/**
 * The element both renderers draw inside, for a listener that must not sit on
 * the document.
 *
 * Chrome reports every non-passive `wheel` or `touchstart` listener added to
 * the window, the document, its root element or its body -- "Added non-passive
 * event listener to a scroll-blocking 'wheel' event" -- because such a listener
 * can hold up scrolling for the whole page. A listener on an ordinary element
 * is not reported and does not carry that cost. `#graph-canvas-container` is
 * the nearest ancestor of both the canvas and the DOM widget layer, so it sees
 * the same events under either renderer.
 */
export function canvasHost() {
    return (
        document.getElementById("graph-canvas-container") ??
        document.getElementById("graph-canvas")?.parentElement ??
        null
    );
}

/**
 * Stop the legacy renderer painting a node body, without lying to its color code.
 *
 * A node that paints its own background needs the one underneath to disappear,
 * and the obvious way to ask -- `node.bgcolor = "transparent"` -- works only by
 * accident. `renderingBgColor` runs the value through `adjustColor`, and
 * *anything it can parse* has its alpha replaced by the `Comfy.Node.Opacity`
 * setting: `rgba(0,0,0,0)` and `#00000000` both come back fully opaque. The
 * keyword survives only because it fails to parse, and failing to parse is
 * exactly what puts `Unsupported color format in color palette: transparent` in
 * the console -- once from the draw itself, and again from the color toolbar,
 * which reads the same property.
 *
 * So the property is left unset, which is the truth (this node has no ComfyUI
 * color), and the rendering getter is shadowed instead. Nothing in LiteGraph
 * assigns to it; a setter is provided anyway, because a third-party extension
 * that did would otherwise get a TypeError from an accessor with no setter.
 *
 * Returns false if the getter cannot be found, so a caller can fall back to the
 * keyword rather than silently showing a grey box.
 */
export function clearNodeBody(node, cleared) {
    node._scClearBody = !!cleared;
    if (node._scBodyHooked) {
        return true;
    }
    let base = null;
    for (let level = Object.getPrototypeOf(node); level && !base; level = Object.getPrototypeOf(level)) {
        base = Object.getOwnPropertyDescriptor(level, "renderingBgColor");
    }
    if (!base?.get) {
        return false;
    }
    let override;
    Object.defineProperty(node, "renderingBgColor", {
        configurable: true,
        get() {
            if (override !== undefined) {
                return override;
            }
            return this._scClearBody ? "transparent" : base.get.call(this);
        },
        set(value) {
            override = value;
        },
    });
    node._scBodyHooked = true;
    return true;
}

/**
 * Add a step to a property a node already owns an accessor for.
 *
 * Every LiteGraph node instance carries own accessors for `shape`, `color` and
 * `bgcolor` -- change-tracking wrappers that stash the value and emit an event
 * of their own. They never reach `onPropertyChanged`, so there is nothing else
 * to hook, and replacing them outright would throw away whatever that tracking
 * is for. Chaining keeps their behaviour exactly and adds one step after it.
 *
 * Returns false when the property is not an own accessor, so a caller can tell
 * a missing hook from a working one rather than assuming.
 */
export function chainAccessor(node, name, after) {
    const own = Object.getOwnPropertyDescriptor(node, name);
    if (!own?.get || !own?.set) {
        return false;
    }
    Object.defineProperty(node, name, {
        configurable: true,
        enumerable: own.enumerable,
        get: own.get,
        set(value) {
            own.set.call(this, value);
            after.call(this, value);
        },
    });
    return true;
}
