/**
 * In-page action primitives — the R-13 **tier 1 ("in-page")** input path, and the default.
 *
 * EVERY event dispatched from this file carries `isTrusted: false`, unavoidably and
 * unforgeably: inside an extension there is no content-script API that produces trusted
 * input (I-01). That is ranked-leak row 1, it cannot be fixed here, and it is precisely why
 * R-13 exists. When a site gates on `isTrusted`, on transient activation (file pickers,
 * clipboard, `window.open`, fullscreen, payment), or on real character-by-character typing,
 * the caller must escalate to the `chrome.debugger` + CDP `Input` tier instead of asking
 * this module to try harder. Nothing here fakes trust.
 *
 * Stealth rules that hold for every function below (R-02):
 *   - no DOM writes beyond the value/selection changes the action itself is *for*
 *     (no marker attributes, no injected styles, no `id`s, no overlays);
 *   - no globals added to the page — this module lives in the ISOLATED world;
 *   - no listener and no timer survives a call: every action is synchronous and leaves
 *     nothing attached.
 *
 * Event cortège and pointer-field realism follow
 * docs/research/trusted-input-and-stealth.md §hygiene rules 4, 5, 7 and 12.
 */
import { resolveRef } from './snapshot';
import { jitterInBox, planPath } from '../input/humanize';

export interface ActionResult {
  ok: boolean;
  error?: string;
}

export interface BoxResult extends ActionResult {
  /** Viewport ("client") coordinates, the same frame `chrome.debugger` Input and OS-level
   *  tiers need to click at real coordinates. */
  box?: { x: number; y: number; width: number; height: number; centerX: number; centerY: number };
  /** Page-level metrics so the caller can convert to device pixels for a screenshot overlay. */
  devicePixelRatio?: number;
}

export interface TypeOptions {
  /** Replace the field's existing content instead of appending. Default true. */
  clear?: boolean;
}

export interface ScrollOptions {
  ref?: string;
  direction?: 'up' | 'down' | 'left' | 'right';
  /** Pixels. Defaults to ~80% of the viewport along the scroll axis. */
  amount?: number;
}

function fail(error: string): ActionResult {
  return { ok: false, error };
}

function element(ref: string): { el: HTMLElement } | { error: string } {
  const found = resolveRef(ref);
  if (!found) return { error: `unknown or stale ref: ${ref}` };
  return { el: found as HTMLElement };
}

function view(el: Element): (Window & typeof globalThis) | null {
  return (el.ownerDocument?.defaultView ?? null) as (Window & typeof globalThis) | null;
}

function rectOf(el: Element): DOMRect {
  return el.getBoundingClientRect();
}

function isInViewport(el: Element): boolean {
  const w = view(el);
  if (!w) return true;
  const r = rectOf(el);
  return r.top >= 0 && r.left >= 0 && r.bottom <= w.innerHeight && r.right <= w.innerWidth;
}

/**
 * Scroll the element into view only when it is not already there. `behavior: 'instant'` is
 * required, not cosmetic: smooth scrolling makes the coordinates we are about to dispatch at
 * stale mid-flight (hygiene rule 12).
 */
function scrollElementIntoView(el: HTMLElement): void {
  if (typeof el.scrollIntoView !== 'function') return;
  try {
    el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' as ScrollBehavior });
  } catch {
    try {
      el.scrollIntoView();
    } catch {
      // Nothing more to try; the dispatch below still uses whatever rect we can read.
    }
  }
}

function ensureVisible(el: HTMLElement): void {
  if (isInViewport(el)) return;
  scrollElementIntoView(el);
}

interface Point {
  clientX: number;
  clientY: number;
}

/**
 * Last pointer position this module dispatched at, with its owning document. Lets a
 * click arrive along a path instead of teleporting. Scoped by document: refs can
 * point inside same-origin iframes, whose coordinate space differs from the top
 * frame's, so a point from another document is never a path start. Plain module
 * state: no listener, no timer, nothing attached to the page.
 */
let lastPoint: { point: Point; doc: Document | null } | null = null;

/**
 * Client position of the last stamped pointer/mouse event, document-scoped like
 * above. `movementX/Y` ride in the event init (the telemetry research row demands
 * deltas matching the coordinate stream): a compat twin (same position twice)
 * repeats the delta once, matching real browsers, then the run goes quiet at rest.
 */
let prevClient: { x: number; y: number; doc: Document | null } | null = null;
/** Delta stamped on the last event: what a compat twin repeats. */
let lastDelta: { x: number; y: number } = { x: 0, y: 0 };

/** Test seam: forget where the pointer was, so the next click has no path to walk. */
export function resetPointerForTests(): void {
  lastPoint = null;
  prevClient = null;
  lastDelta = { x: 0, y: 0 };
}

/** Movement deltas for an event at `point`, advancing the module's position state. */
function movementFor(point: Point, doc: Document | null): { mx: number; my: number } {
  if (prevClient === null || prevClient.doc !== doc) {
    prevClient = { x: point.clientX, y: point.clientY, doc };
    lastDelta = { x: 0, y: 0 };
    return { mx: 0, my: 0 };
  }
  if (point.clientX === prevClient.x && point.clientY === prevClient.y) {
    const repeated = { ...lastDelta };
    lastDelta = { x: 0, y: 0 };
    return { mx: repeated.x, my: repeated.y };
  }
  const mx = point.clientX - prevClient.x;
  const my = point.clientY - prevClient.y;
  prevClient = { x: point.clientX, y: point.clientY, doc };
  lastDelta = { x: mx, y: my };
  return { mx, my };
}

/**
 * Viewport offset of `doc` within the top-level viewport: the sum of every
 * containing frame's box. A point inside a same-origin iframe is in the child's
 * coordinates, so its screen position needs these accumulated — the child
 * window's own screenX/Y identify the browser window, not the frame.
 */
function frameOffset(doc: Document | null): { x: number; y: number } {
  let x = 0;
  let y = 0;
  let current: Document | null = doc;
  try {
    while (current?.defaultView?.frameElement) {
      const rect = (current.defaultView.frameElement as Element).getBoundingClientRect();
      // The child viewport starts inside the frame's border, not at the outer
      // border-box origin — add clientLeft/clientTop (usually 0, nonzero with
      // the browser's default iframe border, accumulating over nested frames).
      const frameEl = current.defaultView.frameElement as Element;
      x += rect.left + (frameEl.clientLeft || 0);
      y += rect.top + (frameEl.clientTop || 0);
      current = (current.defaultView.frameElement as Element).ownerDocument ?? null;
    }
  } catch {
    // A cross-origin frame in the chain: keep the partial offset rather than fail.
  }
  return { x, y };
}

function screenOf(
  w: (Window & typeof globalThis) | null,
  doc: Document | null,
  point: Point,
): { screenX: number; screenY: number } {
  // window.screenX/screenY is the viewport origin in screen pixels. jsdom reports 0
  // and real browsers the window offset; Wayland reports 0, which is also correct
  // there (no global screen coordinates exist). Either way this beats the old
  // `screenX = clientX`, which was a teleporting-window tell on X11.
  const frame = frameOffset(doc);
  const ox = (typeof w?.screenX === 'number' ? w.screenX : 0) + frame.x;
  const oy = (typeof w?.screenY === 'number' ? w.screenY : 0) + frame.y;
  return { screenX: point.clientX + ox, screenY: point.clientY + oy };
}

/**
 * A single, stable, non-zero pointer id per module load. Real pointer streams never use
 * `pointerId: 0` and detectors check for it (ranked-leak row 8).
 */
const POINTER_ID = 1;

function pointerInit(
  point: Point,
  buttons: number,
  pressure: number,
  screen: { screenX: number; screenY: number },
  movement: { mx: number; my: number },
): PointerEventInit {
  return {
    bubbles: true,
    cancelable: true,
    composed: true,
    view: null,
    detail: 0,
    button: 0,
    buttons,
    clientX: point.clientX,
    clientY: point.clientY,
    screenX: screen.screenX,
    screenY: screen.screenY,
    movementX: movement.mx,
    movementY: movement.my,
    pointerId: POINTER_ID,
    pointerType: 'mouse',
    isPrimary: true,
    pressure,
    width: 1,
    height: 1,
  };
}

function mouseInit(
  point: Point,
  buttons: number,
  detail: number,
  screen: { screenX: number; screenY: number },
  movement: { mx: number; my: number },
): MouseEventInit {
  return {
    bubbles: true,
    cancelable: true,
    composed: true,
    detail,
    button: 0,
    buttons,
    clientX: point.clientX,
    clientY: point.clientY,
    screenX: screen.screenX,
    screenY: screen.screenY,
    movementX: movement.mx,
    movementY: movement.my,
  };
}

/**
 * `PointerEvent` is absent in some non-browser DOM implementations used by tests. Fall back
 * to a `MouseEvent` carrying the same fields rather than skipping the event.
 */
function pointerEvent(type: string, init: PointerEventInit): Event {
  const Ctor = (globalThis as { PointerEvent?: typeof PointerEvent }).PointerEvent;
  if (typeof Ctor === 'function') return new Ctor(type, init);
  return new MouseEvent(type, init as MouseEventInit);
}

function dispatch(el: Element, event: Event): void {
  el.dispatchEvent(event);
}

/**
 * Dispatch one pointer event with stamped movement. Every pointer/mouse event in
 * this module goes through here or `mouseAt`, so none can forget its deltas.
 */
function pointerAt(
  el: Element,
  type: string,
  point: Point,
  buttons: number,
  pressure: number,
  screen: { screenX: number; screenY: number },
  opts: { bubbles?: boolean; relatedTarget?: EventTarget | null; movement?: { mx: number; my: number } } = {},
): void {
  const init = pointerInit(point, buttons, pressure, screen, opts.movement ?? movementFor(point, el.ownerDocument ?? null));
  dispatch(
    el,
    pointerEvent(
      type,
      opts.bubbles === false || opts.relatedTarget !== undefined
        ? {
            ...init,
            ...(opts.bubbles === false ? { bubbles: false as const } : {}),
            ...(opts.relatedTarget !== undefined ? { relatedTarget: opts.relatedTarget } : {}),
          }
        : init,
    ),
  );
}

/** Dispatch one mouse event with stamped movement. */
function mouseAt(
  el: Element,
  type: string,
  point: Point,
  buttons: number,
  detail: number,
  screen: { screenX: number; screenY: number },
  opts: { bubbles?: boolean; relatedTarget?: EventTarget | null; movement?: { mx: number; my: number } } = {},
): void {
  const init = mouseInit(point, buttons, detail, screen, opts.movement ?? movementFor(point, el.ownerDocument ?? null));
  dispatch(
    el,
    new MouseEvent(
      type,
      opts.bubbles === false || opts.relatedTarget !== undefined
        ? {
            ...init,
            ...(opts.bubbles === false ? { bubbles: false as const } : {}),
            ...(opts.relatedTarget !== undefined ? { relatedTarget: opts.relatedTarget } : {}),
          }
        : init,
    ),
  );
}

/** The pointer-enter half of a hover, shared by `hover()` and `click()`.
 *
 * `arrival` is what `arrive()` just did: when the path crossed into `el` and is
 * still on it, the enter sequence already fired mid-path and only the move pair
 * repeats — a real transition emits each boundary event once. Otherwise the full
 * hover fires, with the arrival's last target as the related target (delegated
 * handlers use it to tell re-entry from an internal transition).
 */
function dispatchHover(
  el: HTMLElement,
  point: Point,
  screen: { screenX: number; screenY: number },
  arrival: { lastTarget: Element | null; crossedIntoEl: boolean } | null,
): void {
  const entered = !!arrival && arrival.crossedIntoEl && arrival.lastTarget === el;
  const from = arrival?.lastTarget && arrival.lastTarget !== el ? arrival.lastTarget : null;
  if (!entered) {
    pointerAt(el, 'pointerover', point, 0, 0, screen, { relatedTarget: from });
    pointerAt(el, 'pointerenter', point, 0, 0, screen, { bubbles: false, relatedTarget: from });
    mouseAt(el, 'mouseover', point, 0, 0, screen, { relatedTarget: from });
    mouseAt(el, 'mouseenter', point, 0, 0, screen, { bubbles: false, relatedTarget: from });
  }
  pointerAt(el, 'pointermove', point, 0, 0, screen);
  mouseAt(el, 'mousemove', point, 0, 0, screen);
}

/**
 * Where this action lands: a jittered point inside the box (never dead-center),
 * verified with `elementFromPoint` to actually hit the element.
 *
 * Verification degrades honestly: DOMs without hit testing (`elementFromPoint`
 * missing or throwing — jsdom included) have nothing to verify against, so the
 * jittered point stands. A live document reporting nothing under the point means
 * outside its viewport. A real occlusion gets one retry at a second jittered
 * off-center point — never the deterministic box center this change exists to
 * avoid; if that is occluded too the action is refused rather than dispatched
 * at something the agent did not aim at.
 */
function actionPoint(el: HTMLElement): { point: Point } | { error: string } {
  const r = rectOf(el);
  const j = jitterInBox(r);
  const j2 = jitterInBox(r);
  const tries = [
    { clientX: j.x, clientY: j.y },
    { clientX: j2.x, clientY: j2.y },
  ];
  const doc = el.ownerDocument;
  const canVerify = !!doc && typeof doc.elementFromPoint === 'function';
  let lastVerdict: AimVerdict = 'unverifiable';
  for (const point of tries) {
    if (!canVerify) return { point };
    const verdict = verifyAim(el, doc, point);
    if (verdict === 'confirmed' || verdict === 'unverifiable') return { point };
    lastVerdict = verdict;
  }
  return lastVerdict === 'outside'
    ? { error: 'element is outside the viewport at its click point' }
    : { error: 'element is occluded at its click point by another element' };
}

/**
 * Deepest element at the point, drilling through open shadow roots. Document hit
 * testing retargets shadow-encased points to the host, so without the drill-down
 * every shadow-DOM target would read as occluded by its own host.
 *
 * Tri-state: `tested: false` means the hit test itself threw (unverifiable — the
 * caller stands, it does not refuse); a tested null means the live document
 * genuinely reports nothing under the point (outside its viewport).
 */
function tryHit(doc: Document, x: number, y: number): { tested: true; hit: Element | null } | { tested: false } {
  let hit: Element | null;
  try {
    hit = doc.elementFromPoint(x, y);
  } catch {
    return { tested: false };
  }
  while (hit?.shadowRoot && typeof hit.shadowRoot.elementFromPoint === 'function') {
    let inner: Element | null;
    try {
      inner = hit.shadowRoot.elementFromPoint(x, y);
    } catch {
      return { tested: false };
    }
    if (!inner || inner === hit) break;
    hit = inner;
  }
  return { tested: true, hit };
}

/**
 * Whether `hit` confirms the action aims at `el`. A closed shadow root is
 * unreachable from the outside, so a hit on its host (or under it) is the best
 * available evidence and also stands — refusing there would veto every
 * closed-shadow interaction on principle.
 */
function hitConfirms(el: HTMLElement, hit: Element): boolean {
  if (el.contains(hit)) return true;
  const root = el.getRootNode();
  return root instanceof ShadowRoot && (hit === root.host || root.host.contains(hit));
}

type AimVerdict = 'confirmed' | 'occluded' | 'outside' | 'unverifiable';

/** Hit-tests one aim point: confirmed, covered, outside the viewport, or untestable. */
function verifyAim(el: HTMLElement, doc: Document, point: Point): AimVerdict {
  const probed = tryHit(doc, point.clientX, point.clientY);
  if (!probed.tested) return 'unverifiable';
  if (probed.hit === null) return 'outside';
  return hitConfirms(el, probed.hit) ? 'confirmed' : 'occluded';
}

/** Whatever is actually under `point`: the honest target for a mid-path move. */
function hitTarget(el: HTMLElement, point: Point): Element {
  const doc = el.ownerDocument;
  if (doc && typeof doc.elementFromPoint === 'function') {
    const probed = tryHit(doc, point.clientX, point.clientY);
    if (probed.tested && probed.hit) return probed.hit;
  }
  // Hit testing unavailable (or nothing under a mid-path sample): fall through
  // to the action's own element rather than dropping the move.
  return el;
}

/**
 * Where the arrival path starts. A previous point in this document walks; anything
 * else (fresh injection, crossed documents) arrives from a nearby stub point so
 * even the first action walks instead of teleporting.
 */
function startPoint(
  doc: Document | null,
  w: (Window & typeof globalThis) | null,
  point: Point,
): Point {
  if (lastPoint && lastPoint.doc === doc) return lastPoint.point;
  const vw = typeof w?.innerWidth === 'number' && w.innerWidth > 0 ? w.innerWidth : 1024;
  const vh = typeof w?.innerHeight === 'number' && w.innerHeight > 0 ? w.innerHeight : 768;
  const angle = Math.random() * 2 * Math.PI;
  const dist = 40 + Math.random() * 80;
  const clamp = (x: number, max: number): number => Math.min(Math.max(x, 0), max);
  let start = {
    clientX: clamp(point.clientX + Math.cos(angle) * dist, vw),
    clientY: clamp(point.clientY + Math.sin(angle) * dist, vh),
  };
  if (Math.hypot(start.clientX - point.clientX, start.clientY - point.clientY) < 1) {
    // Clamping collapsed the stub onto the point (corner box): step away instead,
    // one way then the other, so there is always a path to walk in a sane viewport.
    const away = { clientX: clamp(point.clientX + 60, vw), clientY: clamp(point.clientY + 40, vh) };
    const back = { clientX: clamp(point.clientX - 60, vw), clientY: clamp(point.clientY - 40, vh) };
    start =
      Math.hypot(away.clientX - point.clientX, away.clientY - point.clientY) >= 1 ? away : back;
  }
  return start;
}

/**
 * Walk the pointer from wherever it last was to `point` along a humanized path,
 * dispatching a move pair per sample at whatever is actually under each sample.
 * When the path crosses elements, the boundary out/leave/over/enter pairs fire at
 * the crossing, as they do for a real transition.
 *
 * Positions only: this module is synchronous by design (no timer may survive a
 * call, R-02), so the path's timestamps are unrealizable here. Temporal realism —
 * holds, inter-key delays, paced moves — belongs to the debugger tier, which sleeps
 * for real. What the in-page tier can honestly do is arrive along a curve at a
 * non-center point, with hover states firing along the way, instead of teleporting.
 */
/**
 * Ancestor chain of `el`, innermost first. Boundary events fire only for nodes
 * actually exited or entered: moving from a button's padding onto an inner span
 * never left the button, so no leave fires on it (hover-driven controls commonly
 * close on leave — a spurious one can mutate or close the target mid-cortège).
 */
function ancestors(el: Element | null): Element[] {
  const chain: Element[] = [];
  let cur: Element | null = el;
  while (cur) {
    chain.push(cur);
    cur = cur.parentElement;
  }
  return chain;
}

function arrive(
  el: HTMLElement,
  w: (Window & typeof globalThis) | null,
  point: Point,
): { lastTarget: Element | null; crossedIntoEl: boolean } {
  const doc = el.ownerDocument ?? null;
  const from = startPoint(doc, w, point);
  lastPoint = { point, doc };
  const path = planPath({ x: from.clientX, y: from.clientY }, { x: point.clientX, y: point.clientY });
  let prevTarget: Element | null = null;
  let crossedIntoEl = false;
  for (const p of path.slice(1)) {
    const mid = { clientX: p.x, clientY: p.y };
    const target = hitTarget(el, mid);
    const screen = screenOf(w, doc, mid);
    // One physical movement per sample: every event in this burst shares the
    // delta from the previous sample, the way a real pointer report does. Letting
    // each boundary event consume the delta instead would leave the final move
    // reporting zero movement at changed coordinates.
    const move = movementFor(mid, doc);
    if (prevTarget && target !== prevTarget) {
      const prevChain = ancestors(prevTarget);
      const prevSet = new Set(prevChain);
      const nextChain = ancestors(target);
      const common = nextChain.find((n) => prevSet.has(n)) ?? null;
      // Nodes actually exited, innermost first; the common ancestor never left.
      // Bubbling out-events fire only on the innermost exited node: ancestors
      // receive them through the bubble path, and a direct dispatch on each
      // would double-deliver (once direct, once bubbled). Leave events do not
      // bubble, so each exited node gets its own.
      const exited = prevChain.slice(0, common ? prevChain.indexOf(common) : prevChain.length);
      if (exited.length > 0) {
        const leaf = exited[0]!;
        pointerAt(leaf, 'pointerout', mid, 0, 0, screen, { movement: move, relatedTarget: target });
        mouseAt(leaf, 'mouseout', mid, 0, 0, screen, { movement: move, relatedTarget: target });
      }
      for (const node of exited) {
        pointerAt(node, 'pointerleave', mid, 0, 0, screen, { bubbles: false, movement: move, relatedTarget: target });
        mouseAt(node, 'mouseleave', mid, 0, 0, screen, { bubbles: false, movement: move, relatedTarget: target });
      }
      // Nodes actually entered, outermost first. Symmetrically, bubbling
      // over-events fire only on the entered target itself.
      const entered = (common ? nextChain.slice(0, nextChain.indexOf(common)) : nextChain).reverse();
      if (entered.length > 0) {
        pointerAt(target, 'pointerover', mid, 0, 0, screen, { movement: move, relatedTarget: prevTarget });
        mouseAt(target, 'mouseover', mid, 0, 0, screen, { movement: move, relatedTarget: prevTarget });
      }
      for (const node of entered) {
        pointerAt(node, 'pointerenter', mid, 0, 0, screen, { bubbles: false, movement: move, relatedTarget: prevTarget });
        mouseAt(node, 'mouseenter', mid, 0, 0, screen, { bubbles: false, movement: move, relatedTarget: prevTarget });
      }
      if (target === el) crossedIntoEl = true;
    }
    prevTarget = target;
    pointerAt(target, 'pointermove', mid, 0, 0, screen, { movement: move });
    mouseAt(target, 'mousemove', mid, 0, 0, screen, { movement: move });
  }
  return { lastTarget: prevTarget, crossedIntoEl };
}

/**
 * Full click cortège in spec order, at a jittered, occlusion-checked point in the
 * element's box — arrived at along a humanized path, never teleported to center.
 *
 * `pointerover → pointerenter → mouseover → mouseenter → pointermove → mousemove →
 *  pointerdown → mousedown → focus → pointerup → mouseup → click`
 * (with zero or more extra move pairs along the arrival path before it).
 *
 * `pressure` is 0.5 while the button is down and 0 while it is up (ranked-leak row 6);
 * `buttons` is consistent across the sequence.
 */
export function click(ref: string): ActionResult {
  const found = element(ref);
  if ('error' in found) return fail(found.error);
  const el = found.el;
  ensureVisible(el);
  const placed = actionPoint(el);
  if ('error' in placed) return fail(placed.error);
  const point = placed.point;
  const w = view(el);
  const screen = screenOf(w, el.ownerDocument ?? null, point);

  const arrival = arrive(el, w, point);
  dispatchHover(el, point, screen, arrival);
  // The arrival moves just ran page hover handlers, which can synchronously open
  // a menu or tooltip over the landing point. Re-verify the same point before
  // pressing rather than clicking through a fresh overlay.
  const doc = el.ownerDocument;
  if (doc && typeof doc.elementFromPoint === 'function') {
    const verdict = verifyAim(el, doc, point);
    if (verdict === 'occluded' || verdict === 'outside') {
      return fail('element became occluded at its click point during hover arrival');
    }
  }
  pointerAt(el, 'pointerdown', point, 1, 0.5, screen);
  mouseAt(el, 'mousedown', point, 1, 1, screen);
  try {
    el.focus({ preventScroll: true });
  } catch {
    // Non-focusable elements throw or no-op; the click still stands.
  }
  pointerAt(el, 'pointerup', point, 0, 0, screen);
  mouseAt(el, 'mouseup', point, 0, 1, screen);
  mouseAt(el, 'click', point, 0, 1, screen);
  return { ok: true };
}

/** Pointer/mouse enter sequence without a press. Useful for hover-revealed menus. */
export function hover(ref: string): ActionResult {
  const found = element(ref);
  if ('error' in found) return fail(found.error);
  ensureVisible(found.el);
  const placed = actionPoint(found.el);
  if ('error' in placed) return fail(placed.error);
  const w = view(found.el);
  const arrival = arrive(found.el, w, placed.point);
  dispatchHover(found.el, placed.point, screenOf(w, found.el.ownerDocument ?? null, placed.point), arrival);
  return { ok: true };
}

/**
 * Assign through the prototype's native `value` setter.
 *
 * A plain `el.value = x` is swallowed by React's instance-level value tracker, so the
 * framework never sees the change (facebook/react#10135; this is `dom-testing-library`'s
 * `setNativeValue`). Going through the prototype descriptor defeats the tracker without
 * patching anything on the page.
 */
function setNativeValue(el: HTMLElement, value: string): boolean {
  const proto = Object.getPrototypeOf(el) as object;
  const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
  if (descriptor?.set) {
    descriptor.set.call(el, value);
    return true;
  }
  const own = Object.getOwnPropertyDescriptor(el, 'value');
  if (own?.set) {
    own.set.call(el, value);
    return true;
  }
  return false;
}

function fireInputAndChange(el: HTMLElement): void {
  dispatch(el, new Event('input', { bubbles: true, composed: true }));
  dispatch(el, new Event('change', { bubbles: true }));
}

/**
 * Set the text of an input, textarea, or contenteditable.
 *
 * This is NOT keystroke emulation: untrusted `KeyboardEvent`s fire listeners but insert no
 * characters, so per-character typing is an R-13 escalation case, not something to fake.
 * Sites that key off `keydown`/`keyup` per character (some autocompletes) need the debugger
 * tier.
 */
export function type(ref: string, text: string, options: TypeOptions = {}): ActionResult {
  const found = element(ref);
  if ('error' in found) return fail(found.error);
  const el = found.el;
  const clear = options.clear ?? true;
  ensureVisible(el);
  try {
    el.focus({ preventScroll: true });
  } catch {
    return fail('element is not focusable');
  }

  const tag = el.localName.toLowerCase();
  if (tag === 'input' || tag === 'textarea') {
    const current = (el as HTMLInputElement).value ?? '';
    const next = clear ? text : current + text;
    if (!setNativeValue(el, next)) return fail('no native value setter on this element');
    fireInputAndChange(el);
    return { ok: true };
  }

  if (el.isContentEditable || el.getAttribute('contenteditable') === 'true' || el.getAttribute('contenteditable') === '') {
    const doc = el.ownerDocument;
    // execCommand is deprecated but is still the only way to mutate a contenteditable with
    // a correct `inputType` and a working undo stack without OS-level keys. A bare
    // dispatched InputEvent changes nothing in the DOM at all.
    try {
      if (clear) {
        doc.execCommand('selectAll', false);
        doc.execCommand('delete', false);
      }
      const inserted = doc.execCommand('insertText', false, text);
      if (!inserted) return fail('execCommand("insertText") was rejected');
    } catch {
      return fail('execCommand("insertText") is unavailable');
    }
    return { ok: true };
  }

  return fail(`element <${tag}> is not a text field`);
}

/** `key` -> `code`, for the keys an agent actually presses. Unlisted keys get a best guess. */
const KEY_CODES: Record<string, string> = {
  Enter: 'Enter',
  Tab: 'Tab',
  Escape: 'Escape',
  Backspace: 'Backspace',
  Delete: 'Delete',
  ArrowUp: 'ArrowUp',
  ArrowDown: 'ArrowDown',
  ArrowLeft: 'ArrowLeft',
  ArrowRight: 'ArrowRight',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  ' ': 'Space',
};

function codeFor(key: string): string {
  const known = KEY_CODES[key];
  if (known) return known;
  if (/^[a-zA-Z]$/.test(key)) return `Key${key.toUpperCase()}`;
  if (/^[0-9]$/.test(key)) return `Digit${key}`;
  return key;
}

/**
 * Dispatch a keydown/keypress/keyup triple at the focused element.
 *
 * Handlers run; **no character is inserted and no default action fires** (untrusted events
 * have not run default actions since Chrome 53, `click` being the grandfathered exception).
 * Use this for `Enter`/`Escape`/arrow-key handlers, not for entering text — that is `type()`,
 * and real typing is an R-13 escalation.
 */
export function press(key: string): ActionResult {
  const doc = (globalThis as unknown as { document: Document }).document;
  const target: Element = (doc.activeElement as Element | null) ?? doc.body ?? doc.documentElement;
  if (!target) return fail('no focused element to receive the key');
  const code = codeFor(key);
  const init: KeyboardEventInit = { key, code, bubbles: true, cancelable: true, composed: true };
  dispatch(target, new KeyboardEvent('keydown', init));
  // keypress only ever fired for character-producing keys; Enter is the historical exception.
  if (key.length === 1 || key === 'Enter') {
    dispatch(target, new KeyboardEvent('keypress', init));
  }
  dispatch(target, new KeyboardEvent('keyup', init));
  return { ok: true };
}

/**
 * Choose a `<select>` option by value, falling back to matching the option's visible label.
 * Plain assignment is correct here — `<select>` has no React value tracker to defeat.
 */
export function select(ref: string, value: string): ActionResult {
  const found = element(ref);
  if ('error' in found) return fail(found.error);
  const el = found.el;
  if (el.localName.toLowerCase() !== 'select') return fail(`element <${el.localName}> is not a <select>`);
  const sel = el as unknown as HTMLSelectElement;
  const options = Array.from(sel.options ?? []);
  const match =
    options.find((o) => o.value === value) ??
    options.find((o) => (o.textContent ?? '').trim() === value.trim());
  if (!match) return fail(`no option with value or label ${JSON.stringify(value)}`);
  ensureVisible(el);
  try {
    el.focus({ preventScroll: true });
  } catch {
    // A select can be unfocusable in exotic layouts; the value change still stands.
  }
  sel.value = match.value;
  match.selected = true;
  fireInputAndChange(el);
  return { ok: true };
}

/** Scroll a specific element's box into view, or scroll the window along an axis. */
export function scroll(options: ScrollOptions = {}): ActionResult {
  const doc = (globalThis as unknown as { document: Document }).document;
  const win = doc.defaultView;
  if (options.ref) {
    const found = element(options.ref);
    if ('error' in found) return fail(found.error);
    scrollElementIntoView(found.el);
    return { ok: true };
  }
  if (!win) return fail('no window to scroll');
  const direction = options.direction ?? 'down';
  const vertical = direction === 'up' || direction === 'down';
  const span = vertical ? win.innerHeight : win.innerWidth;
  const amount = options.amount ?? Math.round(span * 0.8);
  const dx = direction === 'right' ? amount : direction === 'left' ? -amount : 0;
  const dy = direction === 'down' ? amount : direction === 'up' ? -amount : 0;
  if (typeof win.scrollBy === 'function') {
    win.scrollBy({ left: dx, top: dy, behavior: 'instant' as ScrollBehavior });
  } else {
    return fail('window.scrollBy is unavailable');
  }
  return { ok: true };
}

/**
 * Viewport-relative geometry for a ref.
 *
 * This is the handoff point between the DOM tier and the pixel tiers (R-08 `pixels`/`both`,
 * R-13 escalation): the debugger and OS-level tiers click at coordinates, and these are the
 * coordinates they use. `devicePixelRatio` comes along so a captured screenshot's device
 * pixels can be mapped back onto these CSS pixels.
 */
export function getBox(ref: string): BoxResult {
  const found = element(ref);
  if ('error' in found) return { ok: false, error: found.error };
  const r = rectOf(found.el);
  const win = view(found.el);
  return {
    ok: true,
    box: {
      x: r.left,
      y: r.top,
      width: r.width,
      height: r.height,
      centerX: r.left + r.width / 2,
      centerY: r.top + r.height / 2,
    },
    devicePixelRatio: win?.devicePixelRatio ?? 1,
  };
}
