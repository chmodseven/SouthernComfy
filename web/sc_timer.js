/**
 * SC Timer -- a stopwatch on the canvas, driven by the run itself.
 *
 * No title bar and no badge, for the same reason SC Label has neither: a
 * readout should look like an instrument sitting on the workflow rather than
 * like another node in it. The mechanism is the same one core uses for its own
 * Reroute -- title_mode NO_TITLE on the registered class -- and both renderers
 * honour it, so nothing here draws on the canvas by hand.
 *
 * Where the time comes from
 * -------------------------
 * ComfyUI already pushes exactly what this node needs over the websocket, and
 * every message is stamped with the server's own clock:
 *
 *   execution_start        { prompt_id, timestamp }
 *   execution_success      { prompt_id, timestamp }
 *   execution_error        { prompt_id, timestamp, node_id, node_type,
 *                            exception_type, exception_message, ... }
 *   execution_interrupted  { prompt_id, timestamp, node_id, node_type, ... }
 *
 * The stamps are int(time.time() * 1000), taken by PromptExecutor.add_message
 * -- the same ones the history entry is built from, and the same span the
 * console reports. So the **final** duration is the difference between two
 * server stamps and needs no clock of ours; the **live** count is
 * performance.now() since the start message arrived, which is monotonic, immune
 * to the system clock being changed, and never needs to be right to more than a
 * frame because the server's own answer replaces it the moment the run ends.
 *
 * Why this cannot slow a run down
 * -------------------------------
 * The rules were: the run always wins, nothing may touch the GPU, and a badly
 * behaved third-party node must be neither harmed nor able to harm this. So:
 *
 *  - **Nothing executes.** The node declares no inputs and no outputs, so it is
 *    never scheduled and never occupies the sampler's time. It is not in the
 *    run it is timing; it only listens to a browser in a different process.
 *  - **Nothing polls.** There is no interval anywhere. Four event listeners sit
 *    idle until a run starts and cost nothing while nothing is happening.
 *  - **The frame loop runs only during a run**, and requestAnimationFrame is
 *    the one scheduler that already yields to everything else: it is coalesced
 *    with the compositor, it is skipped entirely when the tab is hidden, and a
 *    frame that cannot be afforded is simply not delivered. A dropped frame
 *    costs a dropped millisecond on screen and nothing at all to the run, which
 *    is the trade asked for.
 *  - **The canvas is never dirtied while ticking.** setDirtyCanvas would make
 *    LiteGraph redraw every node in the workflow sixty times a second, which is
 *    the one way an extension really could interfere. A DOM widget does not
 *    need it: writing textContent repaints that element and nothing else.
 *  - **Per frame the work is two string writes**, and only when the string has
 *    actually changed. The minutes-and-seconds half changes once a second.
 *  - **The spinner is a CSS animation**, so it costs no JavaScript at all.
 *  - Every listener and the loop body are wrapped, so an exception here can
 *    never escape into ComfyUI's dispatch, and a loop that somehow started
 *    failing stops itself rather than logging sixty times a second.
 *
 * Cleanup is the other half of that promise: the loop stops on every path out
 * of a run -- success, error, cancellation, and a websocket that has gone away
 * -- and a node removed from the graph drops out of the set it is ticked from.
 */

// Served from /extensions/SouthernComfy/, so "../../" is the ComfyUI web root.
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import {
    bodyRadius,
    chainAccessor,
    closePanel,
    fontSizeSubmenu,
    installStyles,
    openColorPanel,
    openFontSizePanel,
    paintRadius,
    ringRadius,
    trackPointer,
    vueNodes,
} from "./sc_ui.js";

const NODE_TYPE = "SC_Timer";

/**
 * The styling properties, shared with SC Label on purpose.
 *
 * One name per concept: a font size is a font size whichever node is wearing
 * it, they are per-node so nothing collides, and the pack's hashing already
 * knows them -- see OWNED_PROPERTIES in southern_comfy/constants.py, which is
 * what decides that editing one moves the workflow's layout digest and not its
 * inputs. Adding a new one means adding it there too.
 */
const FONT_SIZE = "sc_font_size";
const COLOR = "sc_color";
const BACKGROUND = "sc_background";

/** "Whatever ComfyUI would have used", so the node follows the user's theme. */
const DEFAULT = "default";
/** The keyword, never "rgba(0,0,0,0)" -- the legacy renderer honours only this
 *  one and paints a solid box for the zero-alpha form. */
const TRANSPARENT = "transparent";

const DEFAULTS = {
    // Larger than SC Label's 16: a timer is read at a glance, often while the
    // canvas is zoomed out to watch a whole workflow run.
    [FONT_SIZE]: 20,
    [COLOR]: DEFAULT,
    [BACKGROUND]: DEFAULT,
};

/**
 * The run states, spelled exactly as southern_comfy/constants.py spells them.
 *
 * One vocabulary across both halves of the pack: these are the same words
 * STATUS_RUNNING and friends carry into a saved run record, so a status never
 * has to be translated between the browser and the record it ends up in.
 */
const IDLE = "idle";
const RUNNING = "running";
const SUCCESS = "success";
const ERROR = "error";
const INTERRUPTED = "interrupted";
/** Not a ComfyUI status: the websocket went away with a run still in flight. */
const STALLED = "stalled";
/** Not a ComfyUI status either: the prompt was refused and never ran at all. */
const REFUSED = "refused";
/** Nor this: the prompt ran, but ComfyUI dropped some of its outputs first. */
const PARTIAL = "partial";

const FONT_SIZES = [8, 10, 12, 14, 16, 18, 20, 24, 28, 36, 48, 72];
const FONT_MIN = 4;
const FONT_MAX = 200;
/** Where the Custom slider stops; larger sizes are still typed in beside it. */
const FONT_SLIDER_MAX = 96;

/**
 * The readout's font.
 *
 * ComfyUI ships no monospace and no seven-segment face -- the frontend package
 * carries Inter, PrimeIcons and Material Design Icons and nothing else -- so a
 * clock face would have to be sourced and bundled, which is more hassle than it
 * is worth for this. The platform's own monospace is free, present everywhere,
 * and does the one thing that actually matters: every digit is the same width,
 * so the numbers do not shuffle sideways sixty times a second and the text can
 * honestly be centred rather than pinned to the left. Tabular figures are asked
 * for as well, so that a stack falling through to a proportional face still
 * gets fixed-width digits.
 */
const CLOCK_FONT =
    'ui-monospace, "Cascadia Mono", "Segoe UI Mono", "SF Mono", Menlo, Consolas, "DejaVu Sans Mono", monospace';

/** How much smaller the milliseconds are than the seconds they trail. */
const MS_SCALE = 0.6;
/** The state light, as a fraction of the point size. */
const ICON_SCALE = 0.55;
const ICON_MIN = 8;
/**
 * The space between the readout and the state light.
 *
 * A flat six was too tight against the milliseconds (Shannon, 2026-09-05), so it
 * is now six plus the width of one more digit at the milliseconds' own size --
 * which keeps the proportion when the point size changes instead of leaving a
 * 36pt readout with the same gap as an 8pt one.
 */
const GAP_BASE = 6;
/** Narrow enough that a tiny point size still gives a node worth clicking. */
const MIN_WIDTH = 110;
/**
 * What is kept between the node's edge and its widget's, per side.
 *
 * Ten is the legacy renderer's own inset for a DOM widget, measured. Nodes 2.0
 * has a different one -- twelve, from the widget row's own padding -- and the
 * stylesheet below makes it ten there too rather than carrying two numbers.
 * That is not tidiness: the node's width is stored in the workflow, so a figure
 * that differed by renderer would rewrite every timer's size, and move the
 * workflow's layout digest, every time the user flipped the setting.
 */
const WIDGET_INSET = 10;

/**
 * Geometry, all of it measured -- see SouthernComfy-UI-Guide.md sections 3 and
 * 13. Ask a DOM widget for a height of h and its clientHeight comes back h - 2;
 * a node is taller than its widget by NODE_CHROME; and Nodes 2.0 lays every
 * node out at its height plus NODE_TITLE_HEIGHT whether or not it draws a
 * header, which is where the dead space under a headerless node comes from.
 */
const CONTAINER_INSET = 2;
const NODE_CHROME = 18;
const PADDING_TOP = 2;
// Doubled from six on Shannon's eye, 2026-09-05.
const PADDING_X = 12;
/** Multiplier turning a point size into a line box, matching the CSS below. */
const LINE_HEIGHT = 1.3;
/** Effectively unbounded: the readout takes whatever height the node has. */
const UNBOUNDED = 1e6;

const BUBBLE_COLORS = {
    [IDLE]: "#6f6f6f",
    [SUCCESS]: "#3fa45b",
    [INTERRUPTED]: "#d4a017",
    [ERROR]: "#d24b4b",
    // Its own color rather than the idle grey (Shannon, 2026-09-05): grey means
    // "nothing has run", and a run whose outcome was lost is a different thing
    // to say. Blue also matches the spinner it interrupts.
    [STALLED]: "#5b9bd5",
    // Red, like any other failure. From where the user is standing, pressing Run
    // and getting nothing is a failed run whether or not the queue ever saw it.
    [REFUSED]: "#d24b4b",
    // And a run that only half happened is not a success, whatever the part
    // that did happen reported.
    [PARTIAL]: "#d24b4b",
};

/** Node errors named in full in a refusal tooltip before it says "and N more". */
const MAX_NAMED_ERRORS = 3;

/**
 * The spinner, turned from the frame loop rather than by a CSS animation.
 *
 * A CSS animation was the first version and it is the right instinct -- it costs
 * no JavaScript at all -- but it did not turn. It cannot be relied on here: the
 * declared duration came back as 1e-06s, and a plain probe animation added to a
 * bare element was flattened the same way, so something in the environment is
 * collapsing animations wholesale rather than anything about this rule. Driving
 * it from the loop that is already running costs one style write per step and
 * cannot be switched off by a stylesheet, a browser setting or an automation
 * harness.
 *
 * Twelve steps to the revolution, one revolution a second. Quantised rather than
 * smooth for two reasons: it reads as a proper ticking spinner rather than a
 * blur, and it is a fifth of the writes -- twelve a second instead of sixty.
 */
const SPIN_MS = 1000;
const SPIN_STEPS = 12;

/** Per-node parts, so a render can reach the pieces it has to update. */
const PARTS = new WeakMap();
/** Every timer on the canvas. One run drives all of them. */
const TIMERS = new Set();

/** Which step of the spinner is currently drawn, so a repeat writes nothing. */
let shownSpin = -1;

/**
 * The run this pack is currently showing, or the last one it saw.
 *
 * Module state on purpose, and never a node property: an elapsed time describes
 * one session's run rather than the workflow, so it must not be written into a
 * saved file, and every timer on the canvas is showing the same run anyway.
 * The graph id is kept alongside so that a result cannot be shown against a
 * workflow it did not happen in.
 */
const run = {
    status: IDLE,
    promptId: null,
    graphId: null,
    /** performance.now() when the start message arrived. */
    startedAt: 0,
    /** The server's own millisecond stamp on the start message. */
    serverStart: 0,
    /** The finished duration, in milliseconds. */
    elapsedMs: 0,
    /** A short description of a failure, for the state light's tooltip. */
    detail: "",
};

const STYLE_RULES = `
/* The wrapper is selected by what it contains, never by a class of ours: Nodes
   2.0 re-creates a widget's wrapper when it re-renders a node and takes any
   class we added with it, so a rule keyed on that class silently stops
   matching. With no title bar the node's body is its only drag handle, so the
   readout must not take the pointer. */
*:has(> .sc-timer) { pointer-events: none !important; }

/* The state light is the one part that does, because a tooltip needs a hover
   and a hover needs a pointer. It is a hit area no larger than the thing
   itself, which is the rule a scrollbar on SC Label had to learn: the few
   pixels it takes from the drag handle are the few pixels it occupies. */
.sc-timer-icon { pointer-events: auto !important; }

/* Nodes 2.0 lays widgets out in a flex column and a flex item will not shrink
   below its content while min-height is auto. Zero the wrappers -- and only the
   wrappers. The element itself owns the node's minimum height, because 2.0
   works out how short a node may be by setting its height variable to zero and
   measuring what is left; zeroing that too would have the node answer that it
   needs no room at all. */
.lg-node-widgets:has(.sc-timer),
.lg-node-widget:has(.sc-timer),
.lg-node-widget:has(.sc-timer) > *:not(.sc-timer) { min-height: 0 !important; }
.sc-timer { flex: 1 1 0 !important; }

/* Release the node from the floor Nodes 2.0 puts under a node's width.
   There are two of them and both had to be found, because the first alone
   changed nothing:

     1. min-w-(--min-node-width) on the node element and on its body, the
        variable written inline as 225px.
     2. The widget grid's own column template,
        grid-cols-[min-content_minmax(80px,min-content)_minmax(125px,1fr)],
        which cannot be narrower than 12 + 80 + 125 = 217 whatever it holds.
        This is where the 225 comes from in the first place, and why removing
        only the variable left a 133px node still rendering a 193px widget that
        hung out over its own right-hand edge.

   Both are the renderer's own mechanisms for the number rather than accidents
   of its markup, so overriding them for one node is the right shape of fix --
   and this node cannot be resized, so the resize arithmetic that reads the same
   constant never runs for it. The three columns become one that may be as
   narrow as it likes; the row's own pr-3 becomes ten pixels each side, so that
   the space between the node's edge and its widget's is the ten the legacy
   renderer uses and the node's stored width does not depend on which renderer
   drew it. Scoped with :has() to this pack's own timers, and important because
   2.0 writes the variable as an inline style. */
[data-node-id]:has(.sc-timer) { --min-node-width: 0px !important; }
.lg-node-widgets:has(.sc-timer) { grid-template-columns: minmax(0, 1fr) !important; }
.lg-node-widget:has(.sc-timer) {
    padding-left: 10px !important;
    padding-right: 10px !important;
}
.lg-node-widget:has(.sc-timer) > * { grid-column: 1 / -1 !important; }

/* Trim the padding 2.0 puts around a node body, so a one-line readout is one
   line high there too rather than three. */
*:has(> .lg-node-widgets .sc-timer) {
    padding-top: 0 !important;
    padding-bottom: 0 !important;
    row-gap: 0 !important;
}

/* Let the timer's own box be the only one that shows. The legacy renderer
   paints a node body from bgcolor, which this module sets there; Nodes 2.0
   paints it in CSS instead and would paint the whole element -- including the
   fifty pixels of title strip a headerless node never fills -- so the node's
   surfaces are cleared and the element paints the box itself, capped to the
   height the node actually has. Scoped to this pack's own timers. */
[data-node-id]:has(.sc-timer) > *,
[data-node-id]:has(.sc-timer) > * > * { background: transparent !important; }

/* Hide the source badge under Nodes 2.0. Emptying the instance's badges array
   is enough for the legacy renderer, which draws from it; 2.0 ignores that
   array entirely and renders the badge as a footer row, the last child of the
   node body. */
.lg-node-widgets:has(.sc-timer) ~ .mt-auto { display: none !important; }

.sc-timer-row {
    display: flex;
    align-items: center;
    box-sizing: border-box;
    width: 100%;
    height: 100%;
}
.sc-timer-time {
    flex: 1 1 auto;
    /* A flex item will not shrink below its content while min-width is auto,
       so without this a readout too wide for its node pushes the state light
       out past the edge instead of being clipped in the middle where the node
       is about to be widened anyway. The horizontal twin of the min-height
       trap, and the same answer. */
    min-width: 0;
    text-align: center;
    white-space: pre;
    user-select: none;
    font-variant-numeric: tabular-nums;
    font-feature-settings: "tnum" 1;
}
.sc-timer-icon {
    flex: 0 0 auto;
    box-sizing: border-box;
    border-radius: 50%;
}
/* A ring with one lit quadrant. It is turned from the frame loop rather than
   by a CSS animation here -- see SPIN_MS for why the animation could not be
   relied on to run at all. */
.sc-timer-icon.sc-timer-spin {
    border-style: solid;
    border-color: rgba(150, 150, 150, 0.3);
    border-top-color: #5b9bd5;
    background: none !important;
}
`;

/**
 * Bring the selection ring up to where the readout ends.
 *
 * Under Nodes 2.0 a node's element is always its logical height plus
 * NODE_TITLE_HEIGHT, positioned that far above the node's own y, so the strip a
 * header would occupy is real layout whether or not a header is drawn. Nothing
 * can shorten it -- the floor is the renderer's own arithmetic, read back to
 * work out the node's new size -- but the ring can be pulled up by the space
 * below the painted box, which is a constant:
 *
 *     NODE_TITLE_HEIGHT + NODE_CHROME + CONTAINER_INSET = 50
 *
 * There are no resize handles to move as well, this node having none. If a
 * future frontend renames the overlay the rule stops matching and the ring goes
 * back to the element's corner: cosmetic, not broken.
 */
function deadSpaceRules() {
    const titleStrip = window.LiteGraph?.NODE_TITLE_HEIGHT ?? 30;
    const dead = titleStrip + NODE_CHROME + CONTAINER_INSET;
    // 2.0's own offsets are `inset: -3px` on all four sides of the *node*
    // element and a 15px radius, which is right for a node whose body fills
    // that element and wrong for this one twice over: the painted box is inset
    // by the widget inset on each side, so the ring stood 13px proud of it left
    // and right, and its corners were rounded to a different curve. Both are
    // put back on the painted box, keeping 2.0's own 3px of clearance. */
    return `
[data-node-id]:has(.sc-timer) [data-testid="node-state-outline-overlay"] {
    bottom: ${dead - 3}px !important;
    left: ${WIDGET_INSET - 3}px !important;
    right: ${WIDGET_INSET - 3}px !important;
    border-radius: var(--sc-timer-ring-radius, 15px) !important;
}
`;
}

function styles() {
    installStyles("sc-timer-styles", STYLE_RULES + deadSpaceRules());
}

// --- Geometry -------------------------------------------------------------

function fontSizeOf(node) {
    return Number(node.properties?.[FONT_SIZE]) || DEFAULTS[FONT_SIZE];
}

/**
 * The height of one line box, in whole pixels.
 *
 * Rounded here and then imposed as an explicit pixel line-height, because a
 * fractional line box is what leaves a hairline of the next line on screen: at
 * 16px the multiplier gives 20.8, and arithmetic that rounds to 21 while the
 * browser starts line two at 22.8 shows two tenths of a pixel as a one-pixel
 * rule the width of the node.
 */
function lineBox(size) {
    return Math.round(size * LINE_HEIGHT);
}

/** The widget height that shows exactly one whole line. */
function widgetHeight(size) {
    return lineBox(size) + PADDING_TOP + CONTAINER_INSET;
}

/** The node height that shows exactly one whole line. */
function nodeHeight(size) {
    return widgetHeight(size) + NODE_CHROME;
}

/** The height of the box the user sees, which is the widget's content box. */
function paintHeight(size) {
    return lineBox(size) + PADDING_TOP;
}

function iconSize(size) {
    return Math.max(ICON_MIN, Math.round(size * ICON_SCALE));
}

/** Offscreen context used purely to measure text; never drawn to screen. */
const ruler = document.createElement("canvas").getContext("2d");
let lastFont = null;

function measure(text, size) {
    const font = `${size}px ${CLOCK_FONT}`;
    if (font !== lastFont) {
        ruler.font = font;
        lastFont = font;
    }
    return ruler.measureText(text).width;
}

/**
 * How wide the readout is, in the node's own pixels.
 *
 * The offscreen ruler rather than the elements themselves, deliberately. A DOM
 * measurement comes back in screen pixels and has to be divided by a canvas
 * scale -- and the two renderers do not keep that scale in the same place,
 * since Nodes 2.0 transforms a container while the legacy one scales the canvas
 * context. The ruler answers in node pixels with nothing to convert. Checked
 * against the laid-out DOM before trusting it: 58.59px and 28.13px for the two
 * halves of 00:00.000 at 20pt, from both, to the hundredth of a pixel.
 */
function textWidth(node) {
    const size = fontSizeOf(node);
    const big = PARTS.get(node)?.big.textContent || "00:00";
    return measure(big, size) + measure(".000", Math.round(size * MS_SCALE));
}

/** The gap between the readout and the state light, at this point size. */
function gapFor(size) {
    return GAP_BASE + Math.round(measure("0", Math.round(size * MS_SCALE)));
}

/**
 * How wide the widget's element has to be to hold this reading.
 *
 * Padding, readout, gap, light, padding -- so the space from the left edge to
 * the first digit is the same as the space from the light to the right edge,
 * and stays the same when the clock grows an HH: or a DD: segment and the node
 * grows with it (Shannon, 2026-09-05).
 *
 * An earlier version balanced the light with an empty spacer on the left so the
 * readout sat in the middle of the node. That was pointless and it was the
 * cause of the lopsided look: the node is sized to exactly fit its content, so
 * there is never any slack for centring to distribute -- all the spacer did was
 * push the digits an icon's width further from the left edge than the light was
 * from the right.
 *
 * The width follows the clock's current shape rather than reserving room for
 * every shape it could take: a timer sitting permanently wide enough for days
 * it will almost never reach is a worse default than one that grows when it
 * needs to.
 */
function contentWidth(node) {
    const size = fontSizeOf(node);
    return PADDING_X * 2 + textWidth(node) + gapFor(size) + iconSize(size);
}

// --- The reading ----------------------------------------------------------

function pad(value, digits) {
    return String(Math.floor(value)).padStart(digits, "0");
}

/**
 * Split a duration into the part shown large and the part shown small.
 *
 * MI:SS.fff is the whole of it until a run is long enough to need more, and
 * then HH: and DD: appear on the front in turn. Hours stay on once days are
 * showing, because DD:MI:SS would be read as HH:MI:SS by anyone glancing at it.
 */
function split(ms) {
    const total = Math.max(0, Math.floor(ms));
    let big = `${pad((total / 60000) % 60, 2)}:${pad((total / 1000) % 60, 2)}`;
    const hours = Math.floor(total / 3600000) % 24;
    const days = Math.floor(total / 86400000);
    if (days > 0) {
        big = `${pad(days, 2)}:${pad(hours, 2)}:${big}`;
    } else if (hours > 0) {
        big = `${pad(hours, 2)}:${big}`;
    }
    return { big, small: `.${pad(total % 1000, 3)}` };
}

/** Whether what the run holds belongs to the workflow currently on screen. */
function showsRun() {
    if (run.status === IDLE) {
        return false;
    }
    const here = app.graph?.id ?? null;
    return !run.graphId || !here || run.graphId === here;
}

function visibleStatus() {
    return showsRun() ? run.status : IDLE;
}

/** The reading right now: live while running, the settled value otherwise. */
function visibleElapsed() {
    if (!showsRun()) {
        return 0;
    }
    return run.status === RUNNING ? performance.now() - run.startedAt : run.elapsedMs;
}

// --- Painting -------------------------------------------------------------

function tooltipFor(status, elapsed) {
    const reading = split(elapsed);
    const clock = reading.big + reading.small;
    switch (status) {
        case RUNNING:
            return "A run is in progress.";
        case SUCCESS:
            return `The last run finished successfully in ${clock}.`;
        case INTERRUPTED:
            return `The last run was cancelled after ${clock}.`;
        case ERROR:
            return `The last run failed after ${clock}.${run.detail ? `\n\n${run.detail}` : ""}`;
        case STALLED:
            return (
                "The connection to ComfyUI was lost while a run was in progress, " +
                `so the timer is paused at ${clock} and its result is unknown.`
            );
        case PARTIAL:
            return (
                `The last run finished what it could in ${clock}, but ComfyUI refused part ` +
                `of the workflow before it started and never ran it.${run.detail ? `\n\n${run.detail}` : ""}`
            );
        case REFUSED:
            return (
                "The last run could not be started -- ComfyUI refused the prompt, so " +
                `nothing executed and there is no time to show.${run.detail ? `\n\n${run.detail}` : ""}`
            );
        default:
            return "No run has happened yet with this workflow open.";
    }
}

function paintIcon(node) {
    const parts = PARTS.get(node);
    if (!parts) {
        return;
    }
    const size = iconSize(fontSizeOf(node));
    const status = visibleStatus();
    const { icon } = parts;
    icon.style.width = `${size}px`;
    icon.style.height = `${size}px`;
    icon.classList.toggle("sc-timer-spin", status === RUNNING);
    if (status === RUNNING) {
        // Thick enough to read at a small size, never more than a third of the
        // ring or the hole in the middle closes and it stops looking like one.
        icon.style.borderWidth = `${Math.max(2, Math.round(size / 5))}px`;
        icon.style.background = "";
    } else {
        icon.style.borderWidth = "0";
        icon.style.background = BUBBLE_COLORS[status] ?? BUBBLE_COLORS[IDLE];
        icon.style.transform = "";
        shownSpin = -1;
    }
    icon.title = tooltipFor(status, visibleElapsed());
}

/**
 * Write a reading onto one timer, and only where it has actually changed.
 *
 * The element's own text is the record of what it is showing, which is both the
 * cheapest comparison available and the only one that stays right when a node
 * is added or restyled halfway through a run -- a module-level "last written"
 * cache was the first attempt and it left every newly added timer blank,
 * because the value it wanted to write was the value the cache already held.
 *
 * The node is re-measured only when the clock changes *shape*: at an hour, at a
 * day, and when the reading first arrives. Digits are all the same width, so
 * nothing else can alter how much room the readout needs.
 */
function writeInto(node, big, small) {
    const parts = PARTS.get(node);
    if (!parts) {
        return;
    }
    const previous = parts.big.textContent;
    if (previous !== big) {
        parts.big.textContent = big;
        if (previous.length !== big.length) {
            fitNode(node);
        }
    }
    if (parts.small.textContent !== small) {
        parts.small.textContent = small;
    }
}

/**
 * The whole of the per-frame cost: one split, then two string compares and at
 * most two text writes per timer. No allocation beyond the reading itself, and
 * deliberately no pruning -- that belongs on the paths that run a handful of
 * times per run, not sixty times a second.
 */
function writeTime(ms) {
    const { big, small } = split(ms);
    for (const node of TIMERS) {
        writeInto(node, big, small);
    }
}

/** Turn the spinner. Twelve writes a second, and none at all between them. */
function writeSpin(ms) {
    const step = Math.floor(((ms % SPIN_MS) / SPIN_MS) * SPIN_STEPS) % SPIN_STEPS;
    if (step === shownSpin) {
        return;
    }
    shownSpin = step;
    const turn = `rotate(${Math.round((step * 360) / SPIN_STEPS)}deg)`;
    for (const node of TIMERS) {
        const parts = PARTS.get(node);
        if (parts) {
            parts.icon.style.transform = turn;
        }
    }
}

/**
 * The timers still on a graph, dropping any that are not.
 *
 * onRemoved covers the ordinary case, including a workflow being cleared, but a
 * set of live nodes that is only ever added to is one bad third-party
 * interaction away from holding a node forever. This is the same guard the
 * checksum node grew for the same reason.
 */
function liveTimers() {
    const alive = [];
    for (const node of TIMERS) {
        if (node.graph && PARTS.has(node)) {
            alive.push(node);
        } else {
            TIMERS.delete(node);
        }
    }
    return alive;
}

/**
 * Give the node the size its current reading needs, if it does not have it.
 *
 * A node is wider than the widget it holds, and the two renderers do not agree
 * by how much. The difference is a **measured constant** rather than something
 * read back off the page, and reading it back off the page is worth recording
 * as a mistake: the element's width is derived from the node's, so deriving the
 * node's from the element's closes a loop -- and because the DOM lags a setSize
 * by a frame, the loop is fed a stale number and walks. Measured, it took the
 * inset off the node on every pass: 163, then 153, then 143, and onwards.
 */
function fitNode(node) {
    const size = fontSizeOf(node);
    const width = Math.max(MIN_WIDTH, Math.ceil(contentWidth(node) + WIDGET_INSET * 2));
    const height = nodeHeight(size);
    if (node.size[0] !== width || node.size[1] !== height) {
        node.setSize([width, height]);
    }
    // **`setSize` does not lay the widgets out again, and this is load-bearing.**
    // A DOM widget is positioned from `widget.computedHeight`, which only
    // `arrange` sets -- so a node whose size was set without it has a widget
    // with no computed height at all, and the container is left unpositioned in
    // normal page flow at the full width of the viewport. That is the "it looks
    // fine while you drag it and goes to pieces when you drop it" bug: the node
    // was drawn correctly the whole time and its widget was never placed over
    // it. Measured: the element's rect was [0, 0, 1400, 0] before this call and
    // [210, 160, 133, 28] after. `arrange` is the renderer's own mechanism for
    // the job; it throws without a graph, so it waits until the node has one.
    if (node.graph) {
        node.arrange?.();
        // **And the arrangement only reaches the DOM through a draw.** What
        // positions a legacy DOM widget is `updateWidgets` in ComfyUI's
        // `DomWidgets.vue`, which is chained onto the canvas's
        // `onDrawForeground` and writes the container's position and size from
        // `node.pos`, `widget.y` and `widget.computedHeight`. LiteGraph only
        // draws when something marks the canvas dirty -- so an arrange with no
        // draw after it sets the right numbers and shows nobody, and the
        // container keeps the nothing it was registered with: no inline style
        // at all, sitting in normal page flow at the full width of the page.
        //
        // That is the whole of the "it looks fine while you drag it and goes to
        // pieces when you drop it" bug: dragging redraws constantly, so the
        // state was always fresh; let go, the canvas goes idle, and the last
        // arrange never lands. It reproduces exactly with the draw loop stopped
        // and not at all with a draw loop running, which is why it survived a
        // first round of testing.
        //
        // So: dirty on every arrange, not only when the size changed.
        app.graph?.setDirtyCanvas(true, true);
    }
}

/**
 * Set the node's own background without the change being read as the user's.
 *
 * This module writes `node.bgcolor` on every render in the legacy renderer, and
 * clears it under Nodes 2.0. The chained accessor below cannot tell those writes
 * apart from ComfyUI's color menu by their value alone, so they are marked.
 */
function writeNodeColor(node, value) {
    node._scWritingColor = true;
    try {
        node.bgcolor = value;
    } finally {
        node._scWritingColor = false;
    }
}

/**
 * Adopt a color set from ComfyUI's own menu, rather than fighting it.
 *
 * The two ways of coloring this node cannot both win, and a node that quietly
 * put its own color back the next time it rendered was the worst of both --
 * ComfyUI's palette appeared to work until you deselected the node. So the last
 * one asked for is the one that stands (Shannon, 2026-09-05): pick a color from
 * ComfyUI's menu and it becomes this node's background, and pick one from the
 * node's own menu and it replaces whatever ComfyUI's palette had set.
 *
 * "No color" arrives as `undefined`, which maps to this node's own default
 * rather than to nothing -- the timer's ordinary look is the theme's node
 * background, not transparency.
 */
function watchComfyColor(node) {
    chainAccessor(node, "bgcolor", function (value) {
        if (this._scWritingColor) {
            return;
        }
        const chosen = value === undefined || value === null ? DEFAULT : String(value);
        if (this.properties?.[BACKGROUND] === chosen) {
            return;
        }
        this.properties[BACKGROUND] = chosen;
        render(this);
        app.graph?.setDirtyCanvas(true, true);
    });
}

function render(node) {
    const parts = PARTS.get(node);
    if (!parts) {
        return;
    }
    const { root, paint, row, time, big, small } = parts;
    const size = fontSizeOf(node);
    const color = String(node.properties?.[COLOR] ?? DEFAULTS[COLOR]);
    const background = String(node.properties?.[BACKGROUND] ?? DEFAULTS[BACKGROUND]);
    const vue = vueNodes();

    time.style.fontSize = `${size}px`;
    time.style.lineHeight = `${lineBox(size)}px`;
    small.style.fontSize = `${Math.round(size * MS_SCALE)}px`;
    big.style.fontSize = "inherit";
    // The theme's own node text color when the user has not chosen one, so the
    // readout stays legible if they switch to a light theme.
    time.style.color = color === DEFAULT ? "var(--component-node-foreground, #dddddd)" : color;
    row.style.padding = `${PADDING_TOP}px ${PADDING_X}px 0 ${PADDING_X}px`;
    row.style.gap = `${gapFor(size)}px`;

    // The node's own background belongs to the legacy renderer only. Nodes 2.0
    // decides whether to draw its selection ring with `!!nodeData.bgcolor &&
    // isTransparent(...)`, so a headerless node carrying any transparent
    // bgcolor gets border-0 and no ring at all -- which is why SC Label alone
    // never showed one while core's equally headerless Reroute did. There the
    // property is simply left off and this element paints instead.
    paint.style.borderRadius = paintRadius(node, bodyRadius());
    paint.style.height = `${paintHeight(size)}px`;
    // The selection ring follows the same shape. It lives on an element Nodes
    // 2.0 owns, so the value is handed over as a custom property the stylesheet
    // reads rather than written onto that element directly.
    parts.root.closest("[data-node-id]")?.style.setProperty("--sc-timer-ring-radius", ringRadius(node));
    if (vue) {
        // `undefined`, never `delete`. The property is an own **accessor** --
        // deleting it would take this module's own chained setter with it, and
        // with it every chance of noticing ComfyUI's color menu. Assigning
        // undefined is how the renderer itself unsets one: the accessor toggles
        // the property's enumerability to match, so it drops out of the saved
        // workflow exactly as a deleted one would.
        writeNodeColor(node, undefined);
        if (background === DEFAULT) {
            paint.style.background = "var(--component-node-background, #353535)";
            paint.style.outline = "1px solid var(--component-node-border, rgba(255,255,255,0.08))";
        } else {
            paint.style.background = background;
            paint.style.outline = "none";
        }
        paint.style.outlineOffset = "-1px";
    } else {
        paint.style.background = "transparent";
        paint.style.outline = "none";
        writeNodeColor(node, background === DEFAULT ? undefined : background);
    }

    // The floor, stated where Nodes 2.0 will look for it: that renderer does
    // not ask a node how small it may be, it sets the element's height variable
    // to zero and measures what is left. The number is in the element's terms,
    // so a node floor is that plus the title strip it never draws. The legacy
    // renderer takes its floor from getMinHeight instead and this element must
    // impose none of its own.
    const titleStrip = window.LiteGraph?.NODE_TITLE_HEIGHT ?? 30;
    root.style.minHeight = vue ? `${nodeHeight(size) + titleStrip}px` : "0";

    paintIcon(node);
    const reading = split(visibleElapsed());
    writeInto(node, reading.big, reading.small);
}

function renderAll() {
    for (const node of liveTimers()) {
        render(node);
        // `fitNode` rather than `render` alone, because it is the one that runs
        // `arrange` -- and a full re-render is exactly when the widgets need
        // laying out again. Without it, flipping the renderer restyled the
        // element correctly and left its container sitting unpositioned in
        // normal page flow, which looks like the styling failed and is nothing
        // of the kind. Idempotent, and it runs a handful of times per run.
        fitNode(node);
    }
    app.graph?.setDirtyCanvas(true, true);
}

// --- The frame loop -------------------------------------------------------

let frame = null;
/**
 * Each start of the loop takes a number, and a frame belonging to an older one
 * stops where it is. Nothing then has to stay true for the loop to be startable
 * again: an "already running" flag becomes a lie the moment a frame fails to
 * arrive, and a loop that cannot restart is a timer that has silently stopped.
 */
let generation = 0;

function startTicking() {
    if (frame !== null || run.status !== RUNNING || TIMERS.size === 0) {
        return;
    }
    const mine = ++generation;
    const step = () => {
        frame = null;
        if (mine !== generation) {
            return;
        }
        try {
            if (run.status !== RUNNING) {
                return;
            }
            const elapsed = visibleElapsed();
            writeTime(elapsed);
            writeSpin(elapsed);
        } catch (error) {
            // Once, and then never again: a loop that logs every frame is worse
            // than a timer that has stopped.
            console.error("[SouthernComfy] SC Timer stopped updating.", error);
            generation += 1;
            return;
        }
        frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
}

function stopTicking() {
    generation += 1;
    if (frame !== null) {
        cancelAnimationFrame(frame);
        frame = null;
    }
}

// --- The run --------------------------------------------------------------

function describeError(data) {
    const where = data?.node_type ? `${data.node_type} (#${data.node_id})` : `#${data.node_id}`;
    const what = [data?.exception_type, data?.exception_message].filter(Boolean).join(": ");
    return what ? `${where}\n${what}` : String(where);
}

function onExecutionStart(event) {
    try {
        const data = event?.detail ?? {};
        run.status = RUNNING;
        run.promptId = data.prompt_id ?? null;
        run.serverStart = Number(data.timestamp) || 0;
        run.startedAt = performance.now();
        run.elapsedMs = 0;
        run.detail = "";
        run.graphId = app.graph?.id ?? null;
        renderAll();
        startTicking();
    } catch (error) {
        console.error("[SouthernComfy] SC Timer could not start.", error);
    }
}

/**
 * Finish the run, preferring ComfyUI's own two timestamps over our clock.
 *
 * They are the same stamps the history entry is built from, so the number left
 * on the node is the run's real duration rather than a browser's opinion of it
 * -- and it agrees with the console line to within the moment between the
 * prompt worker starting its stopwatch and the executor sending its first
 * message.
 */
function finish(status) {
    return (event) => {
        try {
            const data = event?.detail ?? {};
            if (run.status !== RUNNING && run.status !== STALLED) {
                return;
            }
            // execution_interrupted is broadcast to every connected client,
            // unlike the others, so a cancellation in another tab can arrive
            // here for a run this one never saw begin.
            if (run.promptId && data.prompt_id && data.prompt_id !== run.promptId) {
                return;
            }
            const ended = Number(data.timestamp) || 0;
            run.elapsedMs =
                run.serverStart && ended
                    ? Math.max(0, ended - run.serverStart)
                    : Math.max(0, performance.now() - run.startedAt);
            // A run ComfyUI only partly accepted is not a success, however
            // well the part it did accept went.
            const partial = data.prompt_id ? partialFailures.get(data.prompt_id) : null;
            if (partial) {
                partialFailures.delete(data.prompt_id);
            }
            run.status = partial && status === SUCCESS ? PARTIAL : status;
            run.detail = status === ERROR ? describeError(data) : (partial ?? "");
            stopTicking();
            renderAll();
        } catch (error) {
            console.error("[SouthernComfy] SC Timer could not finish the run.", error);
            stopTicking();
        }
    };
}

/**
 * The websocket has gone away with a run still in flight.
 *
 * This is the timeout guard, and it is an exact one rather than a made-up
 * deadline: a run can legitimately take days, so a clock that gave up after
 * some arbitrary interval would be wrong about real work. What is never
 * legitimate is ticking on with nothing left to tell us the answer, which is
 * precisely the state a killed or crashed ComfyUI leaves behind.
 *
 * The loop stops here and does **not** restart on reconnection. If the run
 * survived the outage its own end message finishes it properly, with the
 * server's timestamps, however long that takes; if it did not, the reading
 * stays frozen where the connection was lost and says so. Either way there is
 * no path on which this keeps running forever.
 */
function onDisconnected() {
    try {
        if (run.status !== RUNNING) {
            return;
        }
        run.elapsedMs = Math.max(0, performance.now() - run.startedAt);
        run.status = STALLED;
        stopTicking();
        renderAll();
    } catch (error) {
        console.error("[SouthernComfy] SC Timer could not pause.", error);
        stopTicking();
    }
}

/**
 * Describe a prompt ComfyUI would not accept, the way its own toast does.
 *
 * The response carries a summary and a per-node breakdown; both are worth
 * having, since the summary says what kind of refusal it was and the breakdown
 * says which node to go and look at.
 */
/** The per-node half of a validation complaint, as ComfyUI's own toast lists it. */
function describeNodeErrors(perNode) {
    const lines = [];
    if (perNode && typeof perNode === "object") {
        const entries = Object.entries(perNode);
        for (const [id, entry] of entries.slice(0, MAX_NAMED_ERRORS)) {
            const where = entry?.class_type ? `${entry.class_type} (#${id})` : `#${id}`;
            const first = entry?.errors?.[0];
            const what = [first?.message, first?.details].filter(Boolean).join(": ");
            lines.push(what ? `${where} -- ${what}` : where);
        }
        if (entries.length > MAX_NAMED_ERRORS) {
            lines.push(`and ${entries.length - MAX_NAMED_ERRORS} more.`);
        }
    }
    return lines;
}

function describeRefusal(error) {
    const response = error?.response;
    const lines = [];
    const summary = response?.error;
    if (summary?.message) {
        lines.push(summary.details ? `${summary.message}: ${summary.details}` : summary.message);
    }
    lines.push(...describeNodeErrors(response?.node_errors));
    if (lines.length === 0) {
        lines.push(String(error?.message ?? "ComfyUI would not accept the prompt."));
    }
    return lines.join("\n");
}

/**
 * Outputs ComfyUI threw away while queueing a prompt it accepted anyway.
 *
 * **This is the case that looks most like the timer being wrong, and is not.**
 * `validate_prompt` needs only *one* output to survive: unplug a required input
 * from one branch of a workflow that has another, and ComfyUI drops that branch,
 * queues the rest, returns **200** with a `node_errors` block, runs what is left
 * in a few milliseconds and reports `execution_success`. The console says
 * "Prompt executed in 0.02 seconds" and a red toast appears at the same moment.
 * A timer keying off the execution messages alone sees a short, successful run,
 * says so in green, and is telling the truth about the wrong question.
 *
 * The refusal only reaches the browser as the queue call's own return value, so
 * it is kept here against the prompt id and claimed when that run finishes.
 */
const partialFailures = new Map();
/** Enough for a queue of ordinary depth; the oldest is dropped beyond it. */
const MAX_REMEMBERED_PARTIALS = 8;

function notePartialFailure(result) {
    const promptId = result?.prompt_id;
    const errors = result?.node_errors;
    if (!promptId || !errors || Object.keys(errors).length === 0) {
        return;
    }
    partialFailures.set(promptId, describeNodeErrors(errors).join("\n"));
    while (partialFailures.size > MAX_REMEMBERED_PARTIALS) {
        partialFailures.delete(partialFailures.keys().next().value);
    }
}

/**
 * A prompt that was refused before it could run.
 *
 * Pressing Run and getting nothing back is a failed run from where the user is
 * standing, so the light goes red and says why -- rather than leaving the
 * previous run's green sitting there as though it still described anything
 * (Shannon, 2026-09-05). The reading stays at zero, which is the honest number:
 * nothing executed, so there is no duration to report.
 */
function onRefused(error) {
    try {
        // Never over-write a run that is genuinely in flight. A refusal can only
        // be for a *different*, later prompt, and the one on screen matters more.
        if (run.status === RUNNING) {
            return;
        }
        run.status = REFUSED;
        run.promptId = null;
        run.graphId = app.graph?.id ?? null;
        run.serverStart = 0;
        run.startedAt = performance.now();
        run.elapsedMs = 0;
        run.detail = describeRefusal(error);
        stopTicking();
        renderAll();
    } catch (failure) {
        console.error("[SouthernComfy] SC Timer could not report a refused prompt.", failure);
    }
}

/**
 * Watch for a prompt ComfyUI refuses, which it otherwise only says in a toast.
 *
 * There is no event for this. A refusal produces `promptQueueing` and then
 * nothing at all -- no `promptQueued`, no `execution_start`, no
 * `execution_error` -- because `app.queuePrompt` catches the rejection from
 * `api.queuePrompt` and turns it into a toast. Measured: unplugging a required
 * input yields a 400 whose body carries both a summary and a per-node
 * breakdown, and the only place to see it is the rejection itself.
 *
 * So the call is wrapped rather than an event subscribed to. The wrapper passes
 * every argument through, returns what it returns, and re-throws exactly what
 * it threw -- it observes and changes nothing -- and it chains, so an extension
 * that has already wrapped the same method still runs.
 */
function watchRefusedPrompts() {
    const original = api?.queuePrompt;
    if (typeof original !== "function" || api.__scTimerWatching) {
        return;
    }
    api.__scTimerWatching = true;
    api.queuePrompt = async function (...args) {
        try {
            const result = await original.apply(this, args);
            notePartialFailure(result);
            return result;
        } catch (error) {
            onRefused(error);
            throw error;
        }
    };
}

function onGraphCleared() {
    stopTicking();
    partialFailures.clear();
    run.status = IDLE;
    run.promptId = null;
    run.graphId = null;
    run.elapsedMs = 0;
    run.detail = "";
    renderAll();
}

// --- The element ----------------------------------------------------------

function buildElement() {
    // Two boxes, because two different questions are being asked of them. The
    // root is the box Nodes 2.0 measures to decide how tall the node must be;
    // the paint box is the one the user sees. They have to be separate elements
    // because min-height beats max-height in CSS, so a single box tall enough
    // to state the floor would be painted that tall as well -- putting back the
    // fifty pixels of dead space under the readout that this avoids.
    const root = document.createElement("div");
    root.className = "sc-timer";
    Object.assign(root.style, {
        position: "relative",
        width: "100%",
        height: "100%",
        minHeight: "0",
    });

    const paint = document.createElement("div");
    paint.className = "sc-timer-paint";
    Object.assign(paint.style, {
        position: "absolute",
        top: "0",
        left: "0",
        right: "0",
        overflow: "hidden",
    });

    const row = document.createElement("div");
    row.className = "sc-timer-row";

    const time = document.createElement("div");
    time.className = "sc-timer-time";
    time.style.fontFamily = CLOCK_FONT;

    const big = document.createElement("span");
    big.className = "sc-timer-big";
    const small = document.createElement("span");
    small.className = "sc-timer-small";
    time.append(big, small);

    const icon = document.createElement("div");
    icon.className = "sc-timer-icon";

    row.append(time, icon);
    paint.append(row);
    root.append(paint);

    return { root, paint, row, time, big, small, icon };
}

// --- Menu -----------------------------------------------------------------

function setFontSize(node, size) {
    const rounded = Math.round(Number(size));
    if (Number.isFinite(rounded)) {
        node.properties[FONT_SIZE] = Math.max(FONT_MIN, Math.min(FONT_MAX, rounded));
        render(node);
        fitNode(node);
        app.graph?.setDirtyCanvas(true, true);
    }
    return fontSizeOf(node);
}

function setColor(node, property, value) {
    node.properties[property] = value;
    render(node);
    app.graph?.setDirtyCanvas(true, true);
}

// --- Registration ---------------------------------------------------------

app.registerExtension({
    name: "SouthernComfy.Timer",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData?.name !== NODE_TYPE) {
            return;
        }

        const LG = window.LiteGraph;
        // On the class, never the instance: title_mode is a getter with no
        // setter on LGraphNode.prototype and reads from the constructor, so an
        // assignment to an instance is silently ignored and reads straight back
        // as NORMAL_TITLE. Core registers its own Reroute the same way.
        nodeType.title_mode = LG.NO_TITLE;
        nodeType.collapsable = false;

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            onNodeCreated?.apply(this, arguments);
            styles();

            for (const [key, value] of Object.entries(DEFAULTS)) {
                this.properties[key] ??= value;
            }

            // A source badge on an instrument defeats the point of it. badges
            // is an ordinary array on the instance that core pushes getters
            // onto; replacing it with an empty view means a later push -- core
            // rebuilds badges on a canvas event -- lands on a throwaway array.
            // Nothing outside this node is touched, and Nodes 2.0 ignores the
            // array entirely and needs the stylesheet rule instead.
            Object.defineProperty(this, "badges", {
                configurable: true,
                get: () => [],
                set: () => {},
            });

            // The node's size is entirely derived -- from the point size and
            // from how many segments the clock is currently showing -- so there
            // is nothing for a resize to mean. Both renderers check
            // `resizable !== false` before drawing a handle or starting a drag.
            // An accessor rather than a plain value because LiteGraph writes
            // `this.resizable = !this.pinned` when a node is unpinned, which
            // would quietly hand the handles back.
            Object.defineProperty(this, "resizable", {
                configurable: true,
                get: () => false,
                set: () => {},
            });

            const parts = buildElement();
            PARTS.set(this, parts);
            const node = this;

            // Notice the Shapes menu. Every node instance carries an own
            // accessor for `shape` -- a change-tracking wrapper that stores the
            // value and emits an event of its own, and never reaches
            // `onPropertyChanged`, so there is nothing else to hook. Chaining
            // it keeps that behaviour exactly and adds a re-render, which is
            // what a node painting its own box needs in order to follow.
            chainAccessor(this, "shape", () => {
                render(node);
                app.graph?.setDirtyCanvas(true, true);
            });
            watchComfyColor(this);
            this.addDOMWidget("sc_timer", "custom", parts.root, {
                serialize: false,
                // Both matter. A node hands its spare height to widgets through
                // distributeSpace, which reads a minimum and a maximum from
                // each; a custom DOM widget supplying neither is pinned at a
                // built-in 50px floor and never grows with the node.
                getMinHeight: () => widgetHeight(fontSizeOf(node)),
                getMaxHeight: () => UNBOUNDED,
            });

            // Nothing this node shows belongs in the workflow: the reading
            // describes a run, not the graph.
            this.serialize_widgets = false;
            // No title bar means no reason to reserve the gap that clears one.
            this.widgets_start_y = 0;

            render(this);
            fitNode(this);
            // The wrapper does not exist until the widget has mounted and the
            // element has no width until the canvas has laid it out, and
            // neither moment is announced. A ResizeObserver is no substitute:
            // its callbacks come through the rendering pipeline, so it never
            // fires where frames do not run. A short catch-up settles both, and
            // also corrects the width if the platform's monospace turns out
            // wider than the ruler measured it.
            for (const delay of [0, 50, 200, 600]) {
                setTimeout(() => {
                    if (!PARTS.has(node)) {
                        return;
                    }
                    render(node);
                    fitNode(node);
                }, delay);
            }
        };

        /**
         * Join the set that gets ticked -- here, and not in onNodeCreated.
         *
         * A node is constructed before it is added to a graph, so at creation
         * time `node.graph` is still undefined. The first version registered
         * the timer there, and the very first pass of the guard that drops
         * timers no longer on a graph threw it straight back out again: the
         * node was left blank and never ticked. onAdded is the matching half of
         * onRemoved, and LiteGraph has set `graph` by the time it runs.
         */
        const onAdded = nodeType.prototype.onAdded;
        nodeType.prototype.onAdded = function () {
            const result = onAdded?.apply(this, arguments);
            TIMERS.add(this);
            render(this);
            fitNode(this);
            // A timer added while a run is under way joins it, rather than
            // sitting at zero until the next one.
            startTicking();
            return result;
        };

        /**
         * Hide the widget from LiteGraph's own hit testing.
         *
         * This is what makes the node draggable by its middle. LiteGraph asks
         * which widget lies under the pointer *before* it considers dragging; a
         * hit means "the user is interacting with a widget" and the drag never
         * starts. That test is arithmetic on the widget's rectangle and never
         * touches the DOM, so no amount of pointer-events affects it. Nothing
         * is lost by answering "none": LiteGraph neither draws nor operates
         * this widget.
         */
        nodeType.prototype.getWidgetOnPos = function () {
            return null;
        };

        const onPropertyChanged = nodeType.prototype.onPropertyChanged;
        nodeType.prototype.onPropertyChanged = function () {
            const result = onPropertyChanged?.apply(this, arguments);
            // Safe to react unconditionally, unlike SC Label: loading a
            // workflow replays every saved property through this hook from
            // inside configure, before onConfigure runs and against a widget
            // the renderer has not laid out yet -- but everything this node
            // derives comes from the properties themselves rather than from a
            // measurement, so a replay produces the right answer either way.
            render(this);
            fitNode(this);
            return result;
        };

        const onConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function () {
            const result = onConfigure?.apply(this, arguments);
            // The size in the file is deliberately not honoured: this node's
            // size is a function of its point size and its current reading, so
            // a stale one from an older version, or a hand-edited workflow,
            // simply gets the right answer instead.
            render(this);
            fitNode(this);
            return result;
        };

        const getExtraMenuOptions = nodeType.prototype.getExtraMenuOptions;
        nodeType.prototype.getExtraMenuOptions = function (canvas, options) {
            const result = getExtraMenuOptions?.apply(this, arguments);
            const node = this;
            options.push(
                {
                    content: "SC Timer Font Size",
                    has_submenu: true,
                    callback: (_value, _options, event, parent) =>
                        fontSizeSubmenu({
                            current: fontSizeOf(node),
                            sizes: FONT_SIZES,
                            event,
                            parent,
                            title: "Font size",
                            onPick: (size) => setFontSize(node, size),
                            onCustom: () =>
                                openFontSizePanel({
                                    current: fontSizeOf(node),
                                    min: FONT_MIN,
                                    max: FONT_MAX,
                                    sliderMax: FONT_SLIDER_MAX,
                                    at: null,
                                    onApply: (size) => setFontSize(node, size),
                                }),
                        }),
                },
                {
                    content: "SC Timer Text Color",
                    callback: () =>
                        openColorPanel({
                            current: String(node.properties?.[COLOR] ?? DEFAULT),
                            at: null,
                            onApply: (value) => setColor(node, COLOR, value),
                            extras: [
                                {
                                    label: "Default",
                                    value: DEFAULT,
                                    title: "Follow the theme's own node text color",
                                },
                            ],
                        }),
                },
                {
                    content: "SC Timer Background Color",
                    callback: () =>
                        openColorPanel({
                            current: String(node.properties?.[BACKGROUND] ?? DEFAULT),
                            at: null,
                            onApply: (value) => setColor(node, BACKGROUND, value),
                            extras: [
                                {
                                    label: "Default",
                                    value: DEFAULT,
                                    title: "The ordinary ComfyUI node background",
                                },
                                { label: "None", value: TRANSPARENT, title: "No background at all" },
                            ],
                        }),
                },
                {
                    content: "SC Timer Reset Colors",
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
            TIMERS.delete(this);
            PARTS.delete(this);
            closePanel();
            if (TIMERS.size === 0) {
                stopTicking();
            }
            return onRemoved?.apply(this, arguments);
        };
    },

    setup() {
        styles();
        trackPointer();

        // Four listeners and nothing else. They are idle -- genuinely idle, not
        // cheaply polled -- until ComfyUI has something to say, and everything
        // this node does begins with one of them arriving.
        api.addEventListener("execution_start", onExecutionStart);
        api.addEventListener("execution_success", finish(SUCCESS));
        api.addEventListener("execution_error", finish(ERROR));
        api.addEventListener("execution_interrupted", finish(INTERRUPTED));
        // The guard for a run that will never report back: see onDisconnected.
        api.addEventListener("reconnecting", onDisconnected);
        api.addEventListener("graphCleared", onGraphCleared);
        watchRefusedPrompts();

        // Flipping the renderer is a setting, and a setting announces itself:
        // `app.ui.settings` is an EventTarget that dispatches `<id>.change`
        // carrying `{ value, oldValue }`. Without this, everything this module
        // decides from `vueNodes()` -- which box paints the background, whether
        // the node carries a `bgcolor`, whether a floor is stated in the
        // element's terms -- stayed on the answer that was true when the node
        // was last drawn, so a timer that had been switched to Nodes 2.0 sat
        // there mis-laid-out until the next run happened to re-render it.
        //
        // The flip settles asynchronously: a render in the same tick still
        // reads the old value and corrects itself a frame later. Hence the
        // second pass rather than a single one.
        app.ui?.settings?.addEventListener?.("Comfy.VueNodes.Enabled.change", () => {
            renderAll();
            setTimeout(renderAll, 100);
            setTimeout(renderAll, 400);
        });
    },
});
