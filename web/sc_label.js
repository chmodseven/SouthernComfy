/**
 * SC Label -- text on the canvas with no title bar and no badge.
 *
 * Making a node headerless needs no custom canvas drawing, which is the usual
 * assumption and the usual source of trouble. `title_mode` is a first-class
 * LiteGraph feature and core itself relies on it: `Reroute` is registered as
 * `{ title_mode: NO_TITLE, collapsable: false }`. Both renderers honour it, so
 * nothing here branches on the renderer for the header.
 *
 * The one trap: `title_mode` is a **getter with no setter** on
 * `LGraphNode.prototype`, reading from the constructor. Assigning it to an
 * instance is silently ignored and reads straight back as `NORMAL_TITLE`, which
 * is very likely why this stopped working for the packs that once did it. It
 * has to be set on the registered class, which is what `beforeRegisterNodeDef`
 * is for.
 *
 * Text and styling live in `sc_`-prefixed node properties rather than in widget
 * values: a caption is presentation, so it belongs in the `layout` digest
 * beside position and color, not in `inputs` where editing it would report
 * that the workflow's parameters had changed.
 *
 * Why the element is built out of pieces
 * --------------------------------------
 * A headerless node has no title to grab, so its **body is the drag handle**,
 * which means the text must not take pointer events. A scrollbar, though, is a
 * control and is useless without them. The two requirements cannot both hold
 * over the same pixels, so the scrollbar is drawn here rather than by the
 * browser: an outer box, a click-through text layer inside it, a click-through
 * track, and the thumb -- the only part of the whole label that accepts a
 * pointer, and no larger than the thing being dragged.
 */

// Served from /extensions/SouthernComfy/, so "../../" is the ComfyUI web root.
import { app } from "../../scripts/app.js";

const NODE_TYPE = "SC_Label";

const TEXT = "sc_text";
const FONT_SIZE = "sc_font_size";
const COLOR = "sc_color";
const ALIGN = "sc_align";
const BACKGROUND = "sc_background";
const AUTOSIZE = "sc_autosize";

const TRANSPARENT = "transparent";

const DEFAULTS = {
    [TEXT]: "Label",
    [FONT_SIZE]: 16,
    [COLOR]: "#ffffff",
    [ALIGN]: "left",
    // Transparent by default: the point of the node is text that sits on the
    // canvas rather than another box on it. Any CSS color puts a panel back.
    [BACKGROUND]: TRANSPARENT,
    // Grow and shrink with the text until the user resizes it by hand; from
    // then on the size they chose is the size it keeps. See `autoSize`.
    [AUTOSIZE]: true,
};

/**
 * Point sizes offered on the menu, and the range a typed one is held to.
 *
 * The list is the one word processors have used since the eighties -- Word,
 * Pages and Google Docs all offer the same sizes -- so it is what a user
 * expects to be picking from. It runs further up than a document's does because
 * a label is not body text: a caption over a whole section of a workflow is
 * read at half zoom, and 72pt there is a heading rather than a shout.
 */
const FONT_SIZES = [8, 10, 12, 14, 16, 18, 20, 24, 28, 36, 48, 72];
const FONT_MIN = 4;
const FONT_MAX = 200;
/** Where the "Custom" slider stops; larger sizes are still typed in beside it. */
const FONT_SLIDER_MAX = 96;

/** A label starts one line high; only its width is a matter of taste. */
const DEFAULT_WIDTH = 260;

/**
 * Padding inside the label.
 *
 * There is deliberately **no bottom padding**, and that is not a style choice.
 * Overflow is clipped at the *padding* box, not the content box, so a bottom
 * padding is visible area that the next line renders into -- which is exactly
 * the hairline of stray text, and of stray selection highlight, that survived
 * two earlier attempts at getting the minimum height right. With no bottom
 * padding, line two begins precisely at the clip edge and is not drawn at all.
 */
const PADDING_TOP = 2;
const PADDING_X = 5;
/** Multiplier turning a font size into a line box, matching the CSS below. */
const LINE_HEIGHT = 1.3;
/** Effectively unbounded: the label takes whatever height the node has spare. */
const UNBOUNDED = 1e6;

/**
 * The gap between the height asked for and the height the element ends up.
 *
 * Measured, deterministically, once the canvas has drawn at least one frame:
 * ask for `h` and the element's `clientHeight` comes out at `h - 2`.
 */
const CONTAINER_INSET = 2;

/**
 * What a node spends on itself before any widget gets a pixel.
 *
 * Measured in the legacy renderer, where the widget's height is authoritative:
 * a node's own minimum comes out at the widget minimum plus this. It is used to
 * work back the other way -- from the height the node has been given, to the
 * height the text should occupy -- so that both renderers show the same number
 * of lines for the same node size.
 */
const NODE_CHROME = 18;

/** Width of the label's own scrollbar, and of the thumb inside it. */
const BAR_WIDTH = 10;

/**
 * How much of the bottom-right corner the scrollbar leaves alone -- when it can.
 *
 * The resize handle lives there, and the thumb is the one part of the label that
 * accepts a pointer, so a bar running the full height sits on top of it and
 * swallows the events that would have shown the resize cursor.
 *
 * "When it can" is the whole point, and getting that wrong is what left a
 * one-line label with a scrollbar that could not be dragged: the reserve was
 * unconditional, so a 21-pixel track gave up 14 of them and the 12-pixel
 * minimum thumb had 7 pixels of grabbable bar and nowhere to travel. Below
 * `MIN_TRACK` the corner is not reserved at all. Nothing is lost by that: the
 * legacy resize zone is a ten-pixel square *centred* on the node's corner, so
 * half of it lies outside the node and outside this element, and Nodes 2.0 has
 * edge handles along the whole bottom.
 */
const RESIZE_CORNER = 14;
/** Below this, a track is too short to give any of itself away. */
const MIN_TRACK = 28;

/** How far the scrollbar is dimmed from the text color it follows. */
const THUMB_DIM = 0.65;
const TRACK_DIM = 0.25;

/**
 * Dim a color towards black, so the scrollbar follows the text.
 *
 * Multiplying each channel keeps the hue: white text gives a grey bar, red text
 * a darker red one. It also caps naturally at black -- there is no way for a
 * channel to go below zero -- so black text gives a black bar rather than
 * wrapping round to something bright.
 *
 * Anything that is not a plain hex color is left to the caller's fallback: a
 * named color or a gradient cannot be dimmed arithmetically, and guessing is
 * worse than not trying.
 */
function dim(color, factor) {
    const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(color).trim());
    if (!hex) {
        return null;
    }
    let body = hex[1];
    if (body.length === 3) {
        body = [...body].map((c) => c + c).join("");
    }
    const channels = [0, 2, 4].map((i) =>
        Math.max(0, Math.min(255, Math.round(parseInt(body.slice(i, i + 2), 16) * factor))),
    );
    return `rgb(${channels.join(",")})`;
}

const EDITING_CLASS = "sc-label-editing";

/** Per-node parts, so a render can reach the pieces it has to update. */
const PARTS = new WeakMap();
/** Every label on the canvas, for hit-testing pointer events by geometry. */
const LABELS = new Set();
/** The node currently being edited, if any. */
let editing = null;

/**
 * Styling that has to win against ComfyUI, applied as a rule rather than inline.
 *
 * The widget's container is repositioned on **every frame**, and the code that
 * does it rewrites the whole `style` attribute -- including
 * `pointer-events: auto`. Anything set inline by this module is therefore gone
 * a frame later. A stylesheet rule marked `!important` beats an inline
 * declaration that is not, and `class` is left alone by that code, so a class
 * plus an important rule survives where an inline style cannot.
 */
const STYLE_RULES = `
/* The widget's wrapper is selected by what it contains, never by a class of
   ours. Nodes 2.0 re-creates that wrapper when it re-renders a node -- which
   takes any class we put on it with it, leaving the wrapper permanently
   accepting the pointer. That is the "sometimes it will not drag" state: the
   node was fine, its wrapper had simply stopped being marked. Selecting it
   structurally cannot go stale, because the only class involved is on the
   element this module creates and owns. */
*:has(> .sc-label) { pointer-events: none !important; }
*:has(> .sc-label.${EDITING_CLASS}) { pointer-events: auto !important; }

/* The scrollbar thumb is the one part that takes the pointer, in either mode --
   the thumb itself, not the bar around it. A hit area larger than the thing
   being dragged buys nothing on a control this size and costs the pixels
   underneath it, which on a short label are the resize corner. */
.sc-label-thumb { pointer-events: auto !important; }
/* The text takes it only while being edited, so the body stays a drag handle. */
.sc-label.${EDITING_CLASS} .sc-label-text { pointer-events: auto !important; }

/* Nodes 2.0 lays widgets out in a flex column, and a flex item will not shrink
   below its content while min-height is auto -- which is why a label there
   could not be made shorter than its text. Scoped with :has() so that no other
   node, from this pack or any other, is touched.

   Everything **except the label itself**, and that exception is the whole
   floor. Nodes 2.0 works out how short a node may be dragged by measuring it:
   it sets the node-height custom property to zero and reads the element's own
   height back, so a node stops where its content stops. Zeroing the label's minimum along with
   its wrappers is what left this node measuring as nothing and shrinking
   through its own text -- the renderer was asking the right question and being
   told the label needed no room at all. The label carries a real minimum of one
   line instead (set per node, since it depends on the point size), which is
   both what the user should be stopped at and what 2.0 then reads. */
.lg-node-widgets:has(.sc-label),
.lg-node-widget:has(.sc-label),
.lg-node-widget:has(.sc-label) > *:not(.sc-label) { min-height: 0 !important; }
.sc-label { flex: 1 1 0 !important; }

/* Trim the padding 2.0 puts around a node body, so a one-line label is one
   line high there too rather than three. */
*:has(> .lg-node-widgets .sc-label) {
    padding-top: 0 !important;
    padding-bottom: 0 !important;
    row-gap: 0 !important;
}

/* Let the label's own background be the only one that shows.
   The legacy renderer paints a node body from its bgcolor, which this module
   sets; Nodes 2.0 paints it in CSS instead, so a transparent label still sat in
   a grey box there. Clearing both layers means the box a user sees is the one
   the label draws -- transparent by default, or whatever background color they
   choose. Scoped to nodes containing this pack's label. */
[data-node-id]:has(.sc-label) > *,
[data-node-id]:has(.sc-label) > * > * { background: transparent !important; }

/* The panels these menu items open into -- the point size, and the two colors.
   Fixed to the viewport, so the canvas transform does not carry one off when
   the graph is panned underneath it, and styled to sit with ComfyUI's own dark
   surfaces rather than to match them exactly: a theme this does not know about
   should still get a readable box. */
.sc-label-panel {
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
.sc-label-panel input[type="range"] { width: 150px; accent-color: #7a7a7a; }
.sc-label-panel input[type="number"],
.sc-label-panel .sc-label-hex {
    width: 56px;
    padding: 2px 4px;
    border: 1px solid rgba(255, 255, 255, 0.2);
    border-radius: 3px;
    background: #222;
    color: #ddd;
    font-size: 12px;
}
.sc-label-panel .sc-label-hex { width: 88px; font-family: monospace; }
/* A real, visible control: this is the element the browser's own color dialog
   is anchored to, and an invisible one it may anchor anywhere it likes. */
.sc-label-panel .sc-label-swatch {
    width: 34px;
    height: 24px;
    padding: 0;
    border: 1px solid rgba(255, 255, 255, 0.25);
    border-radius: 3px;
    background: none;
    cursor: pointer;
}
.sc-label-panel .sc-label-none {
    padding: 3px 8px;
    border: 1px solid rgba(255, 255, 255, 0.2);
    border-radius: 3px;
    background: #222;
    color: #ddd;
    font-size: 12px;
    cursor: pointer;
}
.sc-label-panel .sc-label-none:hover { background: #2c2c2c; }

/* Hide the source badge under Nodes 2.0. Emptying the node's badges array is
   enough for the legacy renderer, which draws from it; 2.0 does not use that
   array at all and renders the badge as a footer row, the last child of the
   node body. Scoped to this pack's own labels, so every other node keeps
   whatever the user's badge setting says. */
.lg-node-widgets:has(.sc-label) ~ .mt-auto { display: none !important; }
`;

function installStyles() {
    const id = "sc-label-styles";
    if (document.getElementById(id)) {
        return;
    }
    const sheet = document.createElement("style");
    sheet.id = id;
    sheet.textContent = STYLE_RULES;
    document.head.append(sheet);
}

/** Whether the Nodes 2.0 renderer is the one drawing the canvas. */
function vueNodes() {
    return !!app.ui?.settings?.getSettingValue("Comfy.VueNodes.Enabled");
}

function styleOf(node) {
    const read = (key) => node.properties?.[key] ?? DEFAULTS[key];
    return {
        text: String(read(TEXT) ?? ""),
        size: Number(read(FONT_SIZE)) || DEFAULTS[FONT_SIZE],
        color: String(read(COLOR) ?? DEFAULTS[COLOR]),
        align: String(read(ALIGN) ?? DEFAULTS[ALIGN]),
        background: String(read(BACKGROUND) ?? DEFAULTS[BACKGROUND]),
    };
}

/**
 * The height of one line box, in whole pixels.
 *
 * Rounded, and then imposed on the element as an explicit pixel `line-height`,
 * because a fractional line box is what put a hairline of the next line back on
 * screen. At 16px the multiplier gives 20.8: the arithmetic here rounded to 21
 * and clipped at 23, but the browser started line two at 22.8, leaving two
 * tenths of a pixel showing -- which renders as a one-pixel rule the width of
 * the label, and as a one-pixel band of selection highlight when the text is
 * selected. With an integer line height the two agree exactly and line two
 * begins precisely at the clip edge.
 */
function lineBox(node) {
    return Math.round(styleOf(node).size * LINE_HEIGHT);
}

/**
 * The smallest height at which a label shows exactly one whole line.
 *
 * The element's client height must come out at the top padding plus one line
 * box, so that line two starts exactly at the clip edge. Being a pixel out in
 * either direction is visible: too tall shows the top of line two, too short
 * makes a single line overflow its own box.
 */
function oneLine(node) {
    return lineBox(node) + PADDING_TOP + CONTAINER_INSET;
}

/**
 * The smallest **node** height that still shows one whole line, and the reason
 * the minimum has been wrong all along.
 *
 * `oneLine` is a *widget* height: what the text needs. A node is taller than its
 * widget by `NODE_CHROME`, which is exactly the term `render` subtracts again to
 * work out how much text fits. Every clamp compared a node height against the
 * widget minimum, so a label could be dragged `NODE_CHROME` pixels shorter than
 * one line -- eighteen of the twenty-three it needs -- and looked, correctly, as
 * though it were not being capped at all.
 */
function minNodeHeight(node) {
    return oneLine(node) + NODE_CHROME;
}

/**
 * The node height that shows all of the text, with nothing scrolled away.
 *
 * `scrollHeight` cannot answer this on its own: it never reports less than the
 * element's own client height, so a label that has just lost a line reads back
 * as still needing the height it already has and would never shrink. The
 * element is briefly released from its cap to be measured, which is also the
 * only way to see what the text will do once the scrollbar it no longer needs
 * has gone -- so the padding that bar reserves comes off for the measurement
 * too.
 */
function contentHeight(node) {
    const parts = PARTS.get(node);
    if (!parts) {
        return minNodeHeight(node);
    }
    const { text } = parts;
    const saved = [text.style.maxHeight, text.style.height, text.style.paddingRight];
    text.style.maxHeight = "none";
    text.style.height = "auto";
    text.style.paddingRight = `${PADDING_X}px`;
    const measured = text.scrollHeight;
    const width = text.clientWidth;
    [text.style.maxHeight, text.style.height, text.style.paddingRight] = saved;
    // An element ComfyUI has not laid out yet has no width and no scroll
    // height, and measures as though it held nothing at all. Answering "the
    // size it already is" makes the caller a no-op, which is the only honest
    // answer: a label must never be resized on the strength of a measurement
    // taken before it was on screen.
    if (measured <= 0 || width <= 0) {
        return node.size[1];
    }
    return Math.max(minNodeHeight(node), measured + CONTAINER_INSET + NODE_CHROME);
}

/** Whether this label still grows and shrinks with its text. */
function autoSizes(node) {
    return node.properties?.[AUTOSIZE] !== false;
}

/**
 * Follow the text with the node's height, while the label is still allowed to.
 *
 * Typing into a fixed box pushes what you are writing up out of sight, which is
 * a poor way to enter a caption; growing a line at a time as the text wraps
 * keeps all of it on screen. It stops for good the moment the user resizes the
 * label by hand -- that is them saying how big it should be, and text added
 * afterwards scrolls rather than moving their furniture.
 */
function autoSize(node) {
    if (!autoSizes(node) || node._scAutoSizing) {
        return;
    }
    const wanted = contentHeight(node);
    if (wanted !== node.size[1]) {
        node._scAutoSizing = true;
        try {
            node.setSize([node.size[0], wanted]);
        } finally {
            node._scAutoSizing = false;
        }
        // A height this module chose is not the user setting one, even when it
        // happens during a pointer gesture -- dragging the font-size slider is
        // exactly that, and without moving the mark it would leave the label
        // believing it had been resized by hand.
        if (node._scSizeBefore) {
            node._scSizeBefore = [node.size[0], node.size[1]];
        }
        app.graph?.setDirtyCanvas(true, true);
    }
}

/** The label under a point, or null. Geometry, so it works however events route. */
function labelAt(clientX, clientY) {
    let found = null;
    for (const node of LABELS) {
        const parts = PARTS.get(node);
        if (!parts) {
            continue;
        }
        const r = parts.paint.getBoundingClientRect();
        if (clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom) {
            // Later wins: a node added later sits on top of an earlier one.
            found = node;
        }
    }
    return found;
}

/**
 * Show, hide and size the label's own scrollbar.
 *
 * Drawn here rather than by the browser because a native scrollbar cannot be
 * clicked on an element that refuses pointer events -- and the element must
 * refuse them, or the node cannot be dragged by its middle. A native bar also
 * brought its own trouble: its arrows sat under the double-click that opens the
 * label for editing.
 */
function updateScrollbar(node) {
    const parts = PARTS.get(node);
    if (!parts) {
        return;
    }
    const { paint, text, bar, thumb } = parts;
    const overflow = text.scrollHeight - text.clientHeight;
    if (overflow <= 0) {
        bar.style.display = "none";
        text.style.paddingRight = `${PADDING_X}px`;
        return;
    }
    bar.style.display = "block";
    // Give the resize corner back only where there is enough bar to spare it.
    const full = paint.clientHeight - 2;
    bar.style.bottom = `${(full - RESIZE_CORNER >= MIN_TRACK ? RESIZE_CORNER : 0) + 1}px`;
    // The bar follows the text color, dimmed. Picked so that whatever contrast
    // the user has arranged between their text and their background carries over
    // to the scrollbar, instead of a fixed grey that could vanish against either.
    const textColor = styleOf(node).color;
    thumb.style.background = dim(textColor, THUMB_DIM) ?? "rgba(255,255,255,0.35)";
    bar.style.background = dim(textColor, TRACK_DIM) ?? "rgba(255,255,255,0.08)";
    // Keep the text clear of the bar it now shares the box with.
    text.style.paddingRight = `${BAR_WIDTH + PADDING_X}px`;
    const ratio = text.clientHeight / text.scrollHeight;
    const trackHeight = bar.clientHeight;
    // Never taller than the track it runs in. On a one-line label the track is
    // only a few pixels high, so an unclamped minimum thumb was *taller* than
    // its track: the travel came out negative and the thumb slid upwards out of
    // the bar as the text scrolled down.
    const thumbHeight = Math.min(trackHeight, Math.max(12, Math.round(trackHeight * ratio)));
    const travel = Math.max(0, trackHeight - thumbHeight);
    const progress = overflow > 0 ? Math.min(1, Math.max(0, text.scrollTop / overflow)) : 0;
    thumb.style.height = `${thumbHeight}px`;
    thumb.style.transform = `translateY(${Math.round(progress * travel)}px)`;
}

function render(node) {
    const parts = PARTS.get(node);
    if (!parts) {
        return;
    }
    const { root, paint, text } = parts;
    const style = styleOf(node);
    const empty = style.text.trim() === "";

    // Not while the user is typing: writing innerText under an active caret
    // moves it to the start of the line on every keystroke.
    if (editing !== node) {
        text.innerText = style.text;
    }
    text.style.fontSize = `${style.size}px`;
    text.style.lineHeight = `${lineBox(node)}px`;
    text.style.color = style.color;
    text.style.textAlign = style.align;
    paint.style.background = style.background === TRANSPARENT ? "transparent" : style.background;

    // Show the label's shape only where there would otherwise be nothing at
    // all to see. Two cases, and no others -- an outline that lingers while a
    // label simply sits on the canvas is clutter, and it competes with the
    // selection ring rather than standing in for it.
    //
    //  1. The label has no text. With no text and no background there is
    //     nothing on the canvas to see or to click, in either renderer.
    //  2. A new label is being placed, under Nodes 2.0 only. That renderer
    //     draws no selection ring on a node still following the cursor, so a
    //     transparent label is invisible while being positioned and the cursor
    //     appears to float in empty space. The legacy renderer does draw one,
    //     and does not need this.
    const wantsOutline = editing !== node && (empty || (node._scPlacing && vueNodes()));
    paint.style.outline = wantsOutline ? "1px dashed rgba(255,255,255,0.25)" : "none";
    paint.style.outlineOffset = "-1px";

    // The node's own background belongs to the legacy renderer only.
    //
    // Nodes 2.0 decides whether to draw its selection ring with
    // `!!nodeData.bgcolor && ...` -- a node carrying *any* bgcolor gets
    // `border-0` and no ring at all. That is why this label alone never showed
    // a selection outline while core's Reroute, equally headerless, did: the
    // difference was not the missing title, it was that this node sets a
    // bgcolor. 2.0 does not need one, because the label paints its own
    // background and the stylesheet clears the node's surfaces, so the property
    // is simply left off there.
    // The keyword, not "rgba(0,0,0,0)": measured, the legacy renderer paints a
    // solid box for the zero-alpha form and honours the keyword. The two look
    // identical in any color picker and are not interchangeable here.
    if (vueNodes()) {
        delete node.bgcolor;
    } else {
        node.bgcolor = style.background;
    }

    setPointerThrough(node, editing !== node);

    // Cap the text to the height the node was actually given.
    //
    // Nodes 2.0 lays a node out at `size[1] + NODE_TITLE_HEIGHT` even when
    // `title_mode` is `NO_TITLE` and it draws no header -- measured: a node of
    // 43 becomes 73. The reserved strip is never filled, but a stretching flex
    // item will happily grow into it, which made a one-line label read as three.
    // Capping keeps the text the size the node says it is; the reserved strip
    // stays empty, and with the default transparent background it is invisible.
    // In the legacy renderer the wrapper is already this height, so the cap
    // changes nothing there.
    const visible = Math.max(lineBox(node), node.size[1] - NODE_CHROME - CONTAINER_INSET);
    text.style.maxHeight = `${visible}px`;
    // The painted box follows the text, not the node's own bounds.
    //
    // Nodes 2.0 lays a node out taller than its size -- it reserves a title
    // strip that a headerless node never fills -- and switching renderers grows
    // every node on the canvas, ComfyUI's own included. Nothing here can stop
    // that. What it can do is stop the *visible* label inheriting it: with the
    // background and outline on this element, capping it to the same height as
    // the text means the box a user sees is exactly the text's box in both
    // renderers. The node's clickable bounds stay larger under 2.0, which is
    // 2.0's business, but the label no longer looks like it has a slab of dead
    // space stapled to the bottom.
    paint.style.height = `${visible}px`;

    // The floor, stated where the renderer will look for it.
    //
    // Nodes 2.0 does not ask a node how small it may be; it **measures**. On
    // every frame of a resize it sets the node element's height variable to
    // zero and reads the element's own height back, and that is the floor --
    // which is why every other node stops at its content and this one did not.
    // Its widgets have intrinsic height; a label whose minimum had been zeroed
    // along with its wrappers answered "no room at all", and the renderer
    // believed it.
    //
    // The number is in that renderer's terms: the element is laid out at the
    // node's height plus a title strip this node never draws, so a node floor
    // of `minNodeHeight` is an element floor of that plus `NODE_TITLE_HEIGHT`.
    // Under the legacy renderer the floor comes from `getMinHeight` and this
    // element must not impose one of its own, so it states none.
    const titleStrip = window.LiteGraph?.NODE_TITLE_HEIGHT ?? 30;
    root.style.minHeight = vueNodes() ? `${minNodeHeight(node) + titleStrip}px` : "0";

    const minimum = minNodeHeight(node);
    if (node.size[1] < minimum) {
        node.setSize([node.size[0], minimum]);
    }
    // What this render was drawn for, so a size written behind our back can be
    // told apart from one we have already answered.
    node._scRenderedSize = [node.size[0], node.size[1]];
    updateScrollbar(node);
}

/**
 * Mark the widget's wrapper so the stylesheet can keep the pointer off it.
 *
 * The wrapper is found as the element's parent because the two renderers do not
 * agree on what it is -- legacy uses a `dom-widget` container, Nodes 2.0 a flex
 * cell inside `lg-node-widget` -- and it does not exist until the widget has
 * mounted, so this runs on every render rather than once.
 */
function setPointerThrough(node, through) {
    const parts = PARTS.get(node);
    if (!parts) {
        return;
    }
    parts.root.classList.toggle(EDITING_CLASS, !through);
}

function beginEdit(node) {
    const parts = PARTS.get(node);
    if (!parts || editing === node) {
        return;
    }
    editing = node;
    const { text } = parts;
    text.contentEditable = "true";
    text.style.userSelect = "text";
    setPointerThrough(node, false);
    text.focus();

    const range = document.createRange();
    range.selectNodeContents(text);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
}

function endEdit(node, { keep }) {
    const parts = PARTS.get(node);
    if (!parts || editing !== node) {
        return;
    }
    editing = null;
    const { text } = parts;
    if (keep) {
        node.properties[TEXT] = text.innerText;
    }
    text.contentEditable = "false";
    text.style.userSelect = "none";
    window.getSelection()?.removeAllRanges();
    render(node);
    // After the render, so the final text is the text being measured.
    autoSize(node);
    app.graph?.setDirtyCanvas(true, true);
}

function buildElement(node) {
    // Two boxes, because two different questions are being asked of them.
    //
    // `root` is the box Nodes 2.0 **measures**: its minimum height is what that
    // renderer reads back to decide how far a node may be dragged smaller, and
    // it is stated in the renderer's own terms (see `render`).
    //
    // `paint` is the box the user **sees**: the background, the outline and the
    // clipping. It has to be a separate element because `min-height` beats
    // `max-height` in CSS -- a single box tall enough to state the floor would
    // be painted that tall as well, putting back the slab of dead space under
    // the text that this node exists to avoid.
    const root = document.createElement("div");
    root.className = "sc-label";
    Object.assign(root.style, {
        position: "relative",
        width: "100%",
        height: "100%",
        minHeight: "0",
    });

    const paint = document.createElement("div");
    paint.className = "sc-label-paint";
    Object.assign(paint.style, {
        position: "absolute",
        top: "0",
        left: "0",
        right: "0",
        overflow: "hidden",
        borderRadius: "6px",
    });

    const text = document.createElement("div");
    text.className = "sc-label-text";
    Object.assign(text.style, {
        width: "100%",
        height: "100%",
        boxSizing: "border-box",
        padding: `${PADDING_TOP}px ${PADDING_X}px 0 ${PADDING_X}px`,
        overflowY: "auto",
        overflowX: "hidden",
        whiteSpace: "pre-wrap",
        overflowWrap: "anywhere",
        wordBreak: "break-word",
        outline: "none",
        userSelect: "none",
        // The browser's own scrollbar is never shown; the one below replaces it.
        scrollbarWidth: "none",
    });

    // The bar is the track and the thumb is the control: only the thumb takes
    // the pointer, and the track is left click-through so that whatever is
    // under it -- the node body, or the resize corner -- still gets its events.
    const bar = document.createElement("div");
    bar.className = "sc-label-bar";
    Object.assign(bar.style, {
        position: "absolute",
        top: "1px",
        right: "1px",
        bottom: "1px",
        width: `${BAR_WIDTH}px`,
        display: "none",
        borderRadius: `${BAR_WIDTH / 2}px`,
        background: "rgba(255,255,255,0.08)",
        pointerEvents: "none",
    });

    const thumb = document.createElement("div");
    thumb.className = "sc-label-thumb";
    Object.assign(thumb.style, {
        width: "100%",
        borderRadius: `${BAR_WIDTH / 2}px`,
        background: "rgba(255,255,255,0.35)",
        // Not the grab hand the node body shows: this is a control, and it is
        // the only part of the label that is.
        cursor: "default",
    });
    bar.append(thumb);
    paint.append(text, bar);
    root.append(paint);

    // The widget has no size until ComfyUI has positioned it, so the scrollbar
    // cannot be sized from `render` alone -- the first call sees a zero-height
    // box with nothing to scroll. A ResizeObserver catches the size whenever it
    // arrives, and every later change with it.
    if (typeof ResizeObserver === "function") {
        new ResizeObserver(() => {
            // Nodes 2.0 neither clamps a resize to the node's own minimum nor
            // reliably reports one through `onResize`, so a label there could be
            // dragged shorter than the single line it exists to show -- and the
            // damage travelled back to the legacy renderer with the workflow.
            const minimum = minNodeHeight(node);
            if (node.size[1] < minimum) {
                node.setSize([node.size[0], minimum]);
            }
            updateScrollbar(node);
        }).observe(text);
    }

    text.addEventListener("blur", () => endEdit(node, { keep: true }));
    // Grow or shrink with what is being typed, a line at a time, so the text
    // stays on screen instead of scrolling away above the caret.
    text.addEventListener("input", () => {
        autoSize(node);
        updateScrollbar(node);
    });
    text.addEventListener("scroll", () => updateScrollbar(node));
    text.addEventListener("keydown", (event) => {
        if (event.key === "Escape") {
            event.preventDefault();
            endEdit(node, { keep: false });
        } else if (event.key === "Enter" && !event.shiftKey) {
            // Enter finishes, Shift+Enter breaks the line: the convention for a
            // small box holding a short piece of text, rather than an editor.
            event.preventDefault();
            endEdit(node, { keep: true });
        }
        // Everything else is typing, and must not reach the canvas: ComfyUI
        // binds single keys to commands, so an unguarded "b" would bypass a
        // node in the middle of a word.
        event.stopPropagation();
    });

    // Dragging the thumb scrolls the text. The bar is the only part of the
    // label that accepts a pointer, so this cannot be confused with a node drag.
    let dragging = null;
    thumb.addEventListener("pointerdown", (event) => {
        event.preventDefault();
        event.stopPropagation();
        dragging = { y: event.clientY, top: text.scrollTop };
        thumb.setPointerCapture(event.pointerId);
    });
    thumb.addEventListener("pointermove", (event) => {
        if (!dragging) {
            return;
        }
        // Measured on screen, not in the element's own pixels. The canvas is
        // scaled, so a pointer that moved 30 screen pixels has moved 30/scale
        // within the node -- comparing a screen delta against an unscaled track
        // made the thumb run away from the cursor at any zoom but 100%.
        const track = bar.getBoundingClientRect().height - thumb.getBoundingClientRect().height;
        const overflow = text.scrollHeight - text.clientHeight;
        if (track > 0) {
            text.scrollTop = dragging.top + ((event.clientY - dragging.y) / track) * overflow;
            // Move the thumb from here rather than waiting for the element's
            // own `scroll` event: that fires at the next rendering opportunity,
            // so the thumb lagged the text it was supposedly dragging.
            updateScrollbar(node);
        }
    });
    const stop = (event) => {
        dragging = null;
        if (thumb.hasPointerCapture?.(event.pointerId)) {
            thumb.releasePointerCapture(event.pointerId);
        }
    };
    thumb.addEventListener("pointerup", stop);
    thumb.addEventListener("pointercancel", stop);
    // The thumb must not be read as a double-click on the label.
    thumb.addEventListener("dblclick", (event) => event.stopPropagation());

    return { root, paint, text, bar, thumb };
}

/**
 * Last known pointer position, in viewport coordinates.
 *
 * A menu callback does not reliably carry coordinates -- Nodes 2.0 hands one an
 * event with none at all -- and the browser anchors a color picker to its
 * input element, so an input left at the origin opens the picker in the corner
 * of the screen, far from the menu that asked for it. The same trap, and the
 * same answer, as the filter dialog in `sc_combo_filter.js`.
 */
const lastPointer = { clientX: 0, clientY: 0 };

/**
 * Where to put something a menu item asked for.
 *
 * `??` is the wrong operator here and was the reason a picker still opened in
 * the corner of the screen after being taught to follow the pointer: Nodes 2.0
 * hands the callback an event carrying `clientX: 0` rather than no coordinates
 * at all, and zero is not null, so the fallback never ran. `||` is right for a
 * coordinate -- the top-left pixel of the viewport is not a position anything
 * was ever deliberately opened at.
 */
function pointOf(at) {
    return {
        x: Math.round(at?.clientX || lastPointer.clientX),
        y: Math.round(at?.clientY || lastPointer.clientY),
    };
}

/**
 * Ask for a color, from a panel of our own at the pointer.
 *
 * The first two attempts at this both opened in the corner of the screen, and
 * the reason is worth stating plainly: **where a browser puts the native color
 * dialog is not ours to decide.** It is anchored to the `input` that opened it,
 * and the input here was a nought-by-nought, fully transparent,
 * `pointer-events: none` element opened by a script -- which is to say, nothing
 * a browser has any obligation to anchor to. Moving that invisible input to the
 * pointer, which is what the last fix did, cannot help: the coordinates were
 * already right, and the same coordinates put the font panel exactly where it
 * belongs, because that panel is an element of ours that is really there.
 *
 * So this is an element that is really there. The swatch is a visible control
 * at the pointer, and if the browser's own dialog opens from it, it opens from
 * something with a position. The hex field beside it means the dialog is never
 * required at all -- and, for a background, `None` is how transparency gets
 * back, which the color dialog has no way to express.
 */
function openColorPanel(node, property, at) {
    closePanel();
    const started =
        property === BACKGROUND ? styleOf(node).background : styleOf(node).color;
    const hexOf = (value) => (/^#[0-9a-f]{6}$/i.test(value) ? value : "#ffffff");

    const panel = document.createElement("div");
    panel.className = "sc-label-panel";

    const swatch = document.createElement("input");
    swatch.type = "color";
    swatch.className = "sc-label-swatch";
    swatch.value = hexOf(started);
    swatch.title = "Open the color picker";

    const hex = document.createElement("input");
    hex.type = "text";
    hex.className = "sc-label-hex";
    hex.spellcheck = false;
    hex.value = started === TRANSPARENT ? TRANSPARENT : hexOf(started);

    const apply = (value, from) => {
        node.properties[property] = value;
        render(node);
        app.graph?.setDirtyCanvas(true, true);
        if (from !== swatch && /^#[0-9a-f]{6}$/i.test(value)) {
            swatch.value = value;
        }
        if (from !== hex) {
            hex.value = value;
        }
    };

    swatch.addEventListener("input", () => apply(swatch.value, swatch));
    hex.addEventListener("input", () => {
        const typed = hex.value.trim();
        // Only once it is a color. Applying every keystroke would repaint the
        // label from "#ff" on the way to "#ff8800".
        if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(typed) || typed === TRANSPARENT) {
            apply(typed, hex);
        }
    });
    panel.append(swatch, hex);

    if (property === BACKGROUND) {
        const none = document.createElement("button");
        none.type = "button";
        none.className = "sc-label-none";
        none.textContent = "None";
        none.title = "No background at all";
        none.addEventListener("click", () => apply(TRANSPARENT, null));
        panel.append(none);
    }

    for (const element of [swatch, hex]) {
        element.addEventListener("keydown", (event) => {
            if (event.key === "Enter") {
                closePanel();
            } else if (event.key === "Escape") {
                apply(started, null);
                closePanel();
            }
            event.stopPropagation();
        });
    }

    openPanel(panel, at);
    hex.focus();
    hex.select();
}

/**
 * Re-flow every label as it is resized, and notice when the user sets a size.
 *
 * Nodes 2.0 resizes by writing `node.size[1]` **directly** -- measured: it never
 * reaches `setSize` or `onResize`. So nothing here can be driven by a hook, and
 * two things still have to happen during a drag in that renderer: the text has
 * to be re-flowed to the height the node now has, and a size the user chose has
 * to be recognised as theirs. A frame is the one place where everything else
 * has already run; this watches for the length of a drag only, and costs
 * nothing the rest of the time.
 *
 * **The minimum height is not enforced here.** It is stated as the label's own
 * `min-height`, in `render`, which is where 2.0 goes looking for it -- that
 * renderer measures the node rather than asking it. Three earlier attempts
 * fought that from the outside and all of them lost, which is worth keeping:
 *
 *  * A clamping `Proxy` around `size` is not safe. It fails `structuredClone`,
 *    reports `false` from `Array.isArray`, and serialises as an object -- it
 *    would have corrupted every workflow saved through it.
 *  * Clamping on `pointerup` is too early. A capture-phase listener on the
 *    document runs *before* the handler on the element being dragged, so 2.0
 *    finished its own resize immediately afterwards and wrote the height back.
 *  * Clamping on a frame did hold the number, but only after the renderer had
 *    already drawn the node smaller than it should ever have been -- a
 *    correction, visible as one, rather than a floor.
 *
 * The clamp below stays as a backstop for a size arriving from somewhere else
 * entirely -- a workflow written by hand, or another extension.
 */
function watchDragging() {
    let down = false;
    let settle = 0;
    // Each gesture takes a number, and a frame belonging to an older one stops
    // where it is. Nothing then has to stay true for a loop to be startable
    // again -- a flag saying "already running" is a lie the moment a frame fails
    // to arrive, and a loop that cannot be restarted is a cap that has silently
    // stopped capping.
    let generation = 0;

    const frame = (mine) => {
        if (mine !== generation) {
            return;
        }
        for (const node of LABELS) {
            const minimum = minNodeHeight(node);
            if (node.size[1] < minimum) {
                node.setSize([node.size[0], minimum]);
            }
            // Re-flow whatever changed size, not only whatever was clamped.
            // The legacy renderer reaches `onResize` and re-renders itself, but
            // 2.0 writes `size` and calls nothing -- so a label made shorter
            // there kept the text height it had been given before, and went on
            // showing four lines inside a node with room for one.
            const drawn = node._scRenderedSize;
            if (!drawn || drawn[0] !== node.size[0] || drawn[1] !== node.size[1]) {
                render(node);
            }
        }
        if (down || settle-- > 0) {
            requestAnimationFrame(() => frame(mine));
        } else {
            finish();
        }
    };

    // A size that changed across a pointer gesture was changed by the user, and
    // that is the whole definition of "manually resized": it needs no hook, and
    // so it works identically in a renderer that offers none.
    const finish = () => {
        for (const node of LABELS) {
            const before = node._scSizeBefore;
            delete node._scSizeBefore;
            // Not while a label is still finding its feet. A newly added one is
            // measured and re-sized by the catch-up timers below, for up to
            // half a second after it is dropped -- and a drop is a pointer
            // gesture, so without this a label clicked into place would call
            // its own settling a manual resize and never grow with its text.
            if (!before || !autoSizes(node) || !node._scSettled) {
                continue;
            }
            // Except where the only change is this guard putting back a height
            // that was already too short before the gesture began.
            const clamped = before[1] < minNodeHeight(node) && node.size[1] === minNodeHeight(node);
            if (!clamped && (node.size[0] !== before[0] || node.size[1] !== before[1])) {
                node.properties[AUTOSIZE] = false;
            }
        }
    };

    document.addEventListener(
        "pointerdown",
        () => {
            down = true;
            settle = 2;
            for (const node of LABELS) {
                node._scSizeBefore = [node.size[0], node.size[1]];
            }
            const mine = ++generation;
            requestAnimationFrame(() => frame(mine));
        },
        true,
    );
    for (const type of ["pointerup", "pointercancel"]) {
        document.addEventListener(type, () => (down = false), true);
    }
}

/** Apply a point size, held to a range, and re-fit the label around it. */
function setFontSize(node, size) {
    const rounded = Math.round(Number(size));
    if (!Number.isFinite(rounded)) {
        return;
    }
    node.properties[FONT_SIZE] = Math.max(FONT_MIN, Math.min(FONT_MAX, rounded));
    render(node);
    // A bigger font needs a taller line, so a label still following its text
    // grows here; one the user has sized keeps that size and scrolls instead.
    autoSize(node);
    app.graph?.setDirtyCanvas(true, true);
}

/**
 * The point sizes, as a submenu, with a typed one at the end.
 *
 * A menu rather than the slider the properties panel would give, because Nodes
 * 2.0 has no properties panel and the context menu is the one surface both
 * renderers share. Presets carry the common cases in one click; the range is
 * only wide enough to matter for the label being used as a section heading, so
 * "Custom" is where the rest of it lives rather than a scale to drag along.
 */
/**
 * The slider behind "Custom", built here rather than asked of LiteGraph.
 *
 * `LGraphCanvas.prototype.prompt` is the obvious way to ask for a number and it
 * **throws under Nodes 2.0** -- measured: "Cannot destructure property 'canvas'
 * of 'LGraphCanvas.active_canvas' as it is undefined", because 2.0 never sets
 * the active canvas that its dialog code assumes. `window.prompt` is no
 * substitute either: ComfyUI Desktop is Electron, where it does nothing at all.
 *
 * A slider is also simply the better control for this. Point size is a value
 * people arrive at by looking, not by knowing, so it applies as it is dragged
 * and the label resizes underneath -- and `Escape` puts back the size it
 * started at.
 */
function openFontPanel(node, at) {
    closePanel();
    const started = styleOf(node).size;

    const panel = document.createElement("div");
    panel.className = "sc-label-panel";
    const slider = document.createElement("input");
    slider.type = "range";
    slider.min = String(FONT_MIN);
    slider.max = String(FONT_SLIDER_MAX);
    slider.step = "1";
    slider.value = String(started);
    const number = document.createElement("input");
    number.type = "number";
    number.min = String(FONT_MIN);
    number.max = String(FONT_MAX);
    number.step = "1";
    number.value = String(started);
    panel.append(slider, number);

    const apply = (value, from) => {
        setFontSize(node, value);
        const applied = styleOf(node).size;
        if (from !== slider) {
            slider.value = String(Math.min(FONT_SLIDER_MAX, applied));
        }
        if (from !== number) {
            number.value = String(applied);
        }
    };
    slider.addEventListener("input", () => apply(slider.value, slider));
    number.addEventListener("input", () => apply(number.value, number));
    // Only once the typing has stopped. Correcting the box on every keystroke
    // would fight the user halfway through a two-digit number; correcting it
    // when they leave it stops a typed 1 sitting there beside a label at 4.
    number.addEventListener("change", () => {
        number.value = String(styleOf(node).size);
    });
    for (const element of [slider, number]) {
        element.addEventListener("keydown", (event) => {
            if (event.key === "Enter") {
                closePanel();
            } else if (event.key === "Escape") {
                setFontSize(node, started);
                closePanel();
            }
            // ComfyUI binds bare keys to commands; typing a number must not
            // reach the canvas as a shortcut.
            event.stopPropagation();
        });
    }

    openPanel(panel, at);
    number.focus();
    number.select();
}

/** The one panel these menu items open into, if any. */
let openedPanel = null;

/**
 * Put a panel on screen at the pointer, and keep it there.
 *
 * Positioned after appending so it can be measured and held inside the window,
 * and `fixed` so the canvas transform does not carry it off when the graph is
 * panned underneath it.
 */
function openPanel(panel, at) {
    document.body.append(panel);
    const box = panel.getBoundingClientRect();
    const where = pointOf(at);
    panel.style.left = `${Math.max(4, Math.min(window.innerWidth - box.width - 4, where.x))}px`;
    panel.style.top = `${Math.max(4, Math.min(window.innerHeight - box.height - 4, where.y))}px`;

    // Anywhere else finishes, keeping whatever is showing -- the same bargain
    // as editing the text itself. The color dialog a swatch opens is outside
    // the document, so a click in it is not a click anywhere else.
    const dismiss = (event) => !panel.contains(event.target) && closePanel();
    openedPanel = { panel, dismiss };
    document.addEventListener("pointerdown", dismiss, true);
}

function closePanel() {
    if (!openedPanel) {
        return;
    }
    document.removeEventListener("pointerdown", openedPanel.dismiss, true);
    openedPanel.panel.remove();
    openedPanel = null;
}

function chooseFontSize(node, event, parent) {
    const current = styleOf(node).size;
    const entries = FONT_SIZES.map((size) => ({
        content: size === current ? `${size}  ✓` : `${size}`,
        callback: () => setFontSize(node, size),
    }));
    entries.push({
        // Deliberately not `event`: that is the click that opened this submenu,
        // a menu's width away from the "Custom" the user has just pressed.
        // `lastPointer` is where they actually are.
        content: "Custom…",
        callback: () => openFontPanel(node, null),
    });
    new window.LiteGraph.ContextMenu(entries, {
        event,
        parentMenu: parent,
        title: "Font size",
    });
    return false;
}

app.registerExtension({
    name: "SouthernComfy.Label",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData?.name !== NODE_TYPE) {
            return;
        }

        const LG = window.LiteGraph;
        // On the class, never the instance -- see the note at the top of the
        // file. Collapsing is meaningless without a header to click.
        nodeType.title_mode = LG.NO_TITLE;
        nodeType.collapsable = false;

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            onNodeCreated?.apply(this, arguments);
            installStyles();

            for (const [key, value] of Object.entries(DEFAULTS)) {
                this.properties[key] ??= value;
            }

            // A source badge on a caption defeats the whole node. `badges` is an
            // ordinary array on the instance that core pushes getters onto;
            // replacing it with an empty view means a later push -- core rebuilds
            // badges on a canvas event -- lands on a throwaway array. Nothing
            // outside this node is touched. (Nodes 2.0 ignores this array
            // entirely and needs the stylesheet rule instead.)
            Object.defineProperty(this, "badges", {
                configurable: true,
                get: () => [],
                set: () => {},
            });

            const parts = buildElement(this);
            PARTS.set(this, parts);
            LABELS.add(this);
            const node = this;
            this.addDOMWidget("sc_label", "custom", parts.root, {
                serialize: false,
                // Both matter. The node hands its spare height to widgets via
                // `distributeSpace`, which reads a min and a max from each; a
                // custom DOM widget supplying neither is pinned at a built-in
                // 50px floor and never grows with the node.
                getMinHeight: () => oneLine(node),
                getMaxHeight: () => UNBOUNDED,
            });

            this.serialize_widgets = false;
            // No title bar means no reason to reserve the gap that clears one.
            this.widgets_start_y = 0;

            // A node added by hand follows the cursor until it is clicked down.
            // There is no flag for that state, so it is inferred: newly created
            // and not yet clicked. A label loaded from a workflow is configured
            // rather than placed, and `onConfigure` clears this before any of
            // it can matter.
            this._scPlacing = true;
            const dropped = () => {
                if (node._scPlacing) {
                    node._scPlacing = false;
                    render(node);
                }
                document.removeEventListener("pointerdown", dropped, true);
            };
            document.addEventListener("pointerdown", dropped, true);
            this.setSize([DEFAULT_WIDTH, this.computeSize()[1]]);
            render(this);
            // The wrapper does not exist until the widget has mounted, and the
            // element has no height until the canvas has laid it out. Neither
            // moment is announced, and a ResizeObserver reports through the
            // rendering pipeline, so it cannot be the only trigger -- it never
            // fires where frames do not run. A short catch-up settles both.
            for (const delay of [0, 50, 200, 600]) {
                setTimeout(() => {
                    render(node);
                    updateScrollbar(node);
                    // Only ever for a *new* label. Nodes 2.0 writes its own
                    // node height from a first measurement taken before this
                    // widget has any size, so a fresh label needs asking again
                    // once laid out -- but a label being loaded from a workflow
                    // has already had its saved size applied by `onConfigure`,
                    // which runs before these timers. Without this guard every
                    // label was snapped back to one line a fraction of a second
                    // after the workflow opened, which is exactly how a resize
                    // "did not survive a reload" or a trip through a subgraph.
                    if (!node._scConfigured) {
                        const wanted = node.computeSize()[1];
                        if (node.size[1] !== wanted) {
                            node.setSize([node.size[0], wanted]);
                        }
                    }
                    if (delay === 600) {
                        node._scSettled = true;
                    }
                }, delay);
            }
        };

        /**
         * Hide the widget from LiteGraph's own hit testing.
         *
         * This is what makes the label draggable by its middle. LiteGraph asks
         * the node which widget is under the pointer *before* it considers
         * dragging; a hit means "the user is interacting with a widget", so the
         * drag never starts. That test is arithmetic on the widget's rectangle
         * and never touches the DOM, so no amount of `pointer-events` affects
         * it. Nothing is lost by answering "none": LiteGraph neither draws nor
         * operates this widget.
         */
        nodeType.prototype.getWidgetOnPos = function () {
            return null;
        };

        nodeType.prototype.onDblClick = function () {
            beginEdit(this);
            return true;
        };

        for (const hook of ["onSelected", "onDeselected"]) {
            const previous = nodeType.prototype[hook];
            nodeType.prototype[hook] = function () {
                const result = previous?.apply(this, arguments);
                render(this);
                return result;
            };
        }

        const onResize = nodeType.prototype.onResize;
        nodeType.prototype.onResize = function (size) {
            const result = onResize?.apply(this, arguments);
            // Nodes 2.0 does not clamp a resize to the node's computed minimum,
            // so without this a label there can be dragged shorter than the one
            // line it exists to show.
            const minimum = minNodeHeight(this);
            if (size && size[1] < minimum) {
                size[1] = minimum;
            }
            // A full render, not just the scrollbar. The text's height is capped
            // from the node's size, so resizing without re-rendering left the
            // text boxed at its old height inside a taller node -- one line and
            // a scrollbar in a node with room for six, until the text happened
            // to be re-entered.
            render(this);
            return result;
        };

        const onPropertyChanged = nodeType.prototype.onPropertyChanged;
        nodeType.prototype.onPropertyChanged = function (name) {
            const result = onPropertyChanged?.apply(this, arguments);
            render(this);
            // Editing the text or the point size in the properties panel is an
            // edit like any other, and should settle the height the same way.
            //
            // But only once the label is settled, and that guard is load-
            // bearing. Loading a workflow replays every saved property through
            // this hook, from inside `configure` and *before* `onConfigure`
            // runs -- so without it a restored label re-fitted itself around a
            // widget the renderer had not laid out yet and threw away the size
            // the user had saved. Measured: 340x120 in the file, 340x43 on the
            // canvas. A property arriving during a load is not an edit.
            if (this._scSettled && (name === TEXT || name === FONT_SIZE)) {
                autoSize(this);
            }
            return result;
        };

        const onConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function (info) {
            const result = onConfigure?.apply(this, arguments);
            // The size in the file is the size the user chose, and this is the
            // last word on it: `configure` has already replayed the properties
            // by now, so anything they set is put back here rather than left
            // standing. Cheap, and it makes the guarantee unconditional.
            // Read by index rather than as an array: LiteGraph's own size is
            // not always a plain one, and a workflow written by a build that
            // serialised it as `{"0": w, "1": h}` still has to load.
            const width = Number(info?.size?.[0]);
            const height = Number(info?.size?.[1]);
            if (Number.isFinite(width) && Number.isFinite(height)) {
                this.setSize([width, Math.max(minNodeHeight(this), height)]);
            }
            // This label came from a workflow and carries a size the user chose.
            // Nothing after this may reset it to the default, and it is not
            // being placed by hand either.
            this._scConfigured = true;
            this._scPlacing = false;
            this._scSettled = true;
            render(this);
            return result;
        };

        const getExtraMenuOptions = nodeType.prototype.getExtraMenuOptions;
        nodeType.prototype.getExtraMenuOptions = function (canvas, options) {
            const result = getExtraMenuOptions?.apply(this, arguments);
            const node = this;
            options.push(
                {
                    content: "SC Label Font Size",
                    has_submenu: true,
                    callback: (_v, _o, event, parent) => chooseFontSize(node, event, parent),
                },
                {
                    content: "SC Label Text Color",
                    callback: () => openColorPanel(node, COLOR, null),
                },
                {
                    content: "SC Label Background Color",
                    callback: () => openColorPanel(node, BACKGROUND, null),
                },
                {
                    content: "SC Label Reset Colors",
                    callback: () => {
                        node.properties[COLOR] = DEFAULTS[COLOR];
                        node.properties[BACKGROUND] = DEFAULTS[BACKGROUND];
                        render(node);
                        app.graph?.setDirtyCanvas(true, true);
                    },
                },
            );
            return result;
        };

        const onRemoved = nodeType.prototype.onRemoved;
        nodeType.prototype.onRemoved = function () {
            if (editing === this) {
                editing = null;
            }
            LABELS.delete(this);
            PARTS.delete(this);
            return onRemoved?.apply(this, arguments);
        };
    },

    setup() {
        installStyles();

        watchDragging();

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

        // Finish editing when the next click lands anywhere else. `blur` alone
        // is not enough: under Nodes 2.0 a click within the node can leave the
        // element focused, which left the label stuck in edit mode.
        document.addEventListener(
            "pointerdown",
            (event) => {
                const parts = editing && PARTS.get(editing);
                if (parts && !parts.root.contains(event.target)) {
                    endEdit(editing, { keep: true });
                }
            },
            true,
        );

        // The next two hit-test by geometry rather than by event target,
        // because the label deliberately does not receive pointer events, and
        // because the renderers deliver these events by different routes.

        // Nodes 2.0 draws nodes as DOM and never calls the canvas's onDblClick.
        document.addEventListener(
            "dblclick",
            (event) => {
                const node = labelAt(event.clientX, event.clientY);
                if (node) {
                    event.preventDefault();
                    event.stopPropagation();
                    beginEdit(node);
                }
            },
            true,
        );

        // Scrolling a label that is showing less than it holds. Without this the
        // wheel reaches the canvas and zooms instead.
        document.addEventListener(
            "wheel",
            (event) => {
                const node = labelAt(event.clientX, event.clientY);
                const parts = node && PARTS.get(node);
                if (!parts || parts.text.scrollHeight <= parts.text.clientHeight) {
                    return;
                }
                event.preventDefault();
                event.stopPropagation();
                parts.text.scrollTop += event.deltaY;
                updateScrollbar(node);
            },
            { capture: true, passive: false },
        );
    },
});
