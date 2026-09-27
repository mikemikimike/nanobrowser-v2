/**
 * ARIA role mapping + W3C AccName computation, implemented from scratch in plain DOM JS.
 *
 * Why hand-rolled: `element.computedRole` / `element.computedName` (AOM) have never shipped —
 * they have been behind a flag since Chrome 41 and are slated for removal, and CDP's
 * `Accessibility.getFullAXTree` is off-limits at the in-page tier (R-13 tier 1, R-02).
 * See docs/research/dom-snapshot-and-actions.md §4.
 *
 * Stealth (R-02): every function here is read-only. Nothing in this file writes an attribute,
 * a property, a style, or a global. Reads use `getComputedStyle`/`getAttribute` only.
 *
 * Spec references: WAI-ARIA 1.2, ARIA in HTML (html-aria), AccName 1.2.
 */

/** Roles whose accessible name may be computed from the element's own subtree text. */
const NAME_FROM_CONTENT = new Set([
  'button',
  'caption',
  'cell',
  'checkbox',
  'code',
  'columnheader',
  'deletion',
  'emphasis',
  'gridcell',
  'heading',
  'insertion',
  'link',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'paragraph',
  'radio',
  'row',
  'rowheader',
  'strong',
  'subscript',
  'superscript',
  'switch',
  'tab',
  'term',
  'time',
  'tooltip',
  'treeitem',
]);

/** ARIA landmark roles (plus `heading`-adjacent document structure worth keeping in a snapshot). */
export const LANDMARK_ROLES = new Set([
  'banner',
  'complementary',
  'contentinfo',
  'form',
  'main',
  'navigation',
  'region',
  'search',
  'dialog',
  'alertdialog',
]);

/** Roles a follower can plausibly act on. Used by the snapshot's interactivity filter. */
export const INTERACTIVE_ROLES = new Set([
  'button',
  'checkbox',
  'combobox',
  'link',
  'listbox',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'radio',
  'searchbox',
  'slider',
  'spinbutton',
  'switch',
  'tab',
  'textbox',
  'treeitem',
]);

/** `<input type=...>` -> implicit ARIA role. Types absent here have no mapped role. */
const INPUT_TYPE_ROLE: Record<string, string> = {
  button: 'button',
  checkbox: 'checkbox',
  email: 'textbox',
  image: 'button',
  number: 'spinbutton',
  radio: 'radio',
  range: 'slider',
  reset: 'button',
  search: 'searchbox',
  submit: 'button',
  tel: 'textbox',
  text: 'textbox',
  url: 'textbox',
};

/**
 * `<input type=...>` values that behave as free-text fields (value is worth reporting).
 *
 * `password` is deliberately absent (R-12): the snapshot is sent to the model on every
 * step and into the run log, so emitting a filled password's value would hand a
 * credential to the provider and to disk. The node itself is still emitted — the agent
 * needs to see the field to call `blocked` — only the value is withheld.
 */
export const TEXT_INPUT_TYPES = new Set([
  '',
  'email',
  'number',
  'search',
  'tel',
  'text',
  'url',
]);

/** Tag name -> implicit ARIA role, for tags whose role does not depend on attributes. */
const TAG_ROLE: Record<string, string> = {
  article: 'article',
  aside: 'complementary',
  blockquote: 'blockquote',
  button: 'button',
  caption: 'caption',
  code: 'code',
  datalist: 'listbox',
  dd: 'definition',
  del: 'deletion',
  details: 'group',
  dfn: 'term',
  dialog: 'dialog',
  dl: 'list',
  dt: 'term',
  em: 'emphasis',
  fieldset: 'group',
  figure: 'figure',
  form: 'form',
  hr: 'separator',
  html: 'document',
  ins: 'insertion',
  li: 'listitem',
  main: 'main',
  math: 'math',
  menu: 'list',
  meter: 'meter',
  nav: 'navigation',
  ol: 'list',
  optgroup: 'group',
  option: 'option',
  output: 'status',
  p: 'paragraph',
  progress: 'progressbar',
  search: 'search',
  strong: 'strong',
  sub: 'subscript',
  sup: 'superscript',
  svg: 'graphics-document',
  table: 'table',
  tbody: 'rowgroup',
  textarea: 'textbox',
  tfoot: 'rowgroup',
  thead: 'rowgroup',
  time: 'time',
  tr: 'row',
  ul: 'list',
};

const HEADING_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);

function tag(el: Element): string {
  return el.localName.toLowerCase();
}

function attr(el: Element, name: string): string | null {
  return el.getAttribute(name);
}

function trimmed(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * The `role` attribute's first token that is a non-abstract role name. Per WAI-ARIA the
 * attribute is a space-separated fallback list; the first valid token wins.
 */
function explicitRole(el: Element): string | null {
  const raw = attr(el, 'role');
  if (!raw) return null;
  for (const token of raw.split(/\s+/)) {
    const role = token.toLowerCase();
    if (role) return role;
  }
  return null;
}

/**
 * Implicit (native host language) role for an element, per ARIA in HTML.
 * Returns `'generic'` when the element has no mapped role.
 */
export function implicitRole(el: Element): string {
  const name = tag(el);

  if (HEADING_TAGS.has(name)) return 'heading';

  switch (name) {
    case 'a':
    case 'area':
      return el.hasAttribute('href') ? 'link' : 'generic';
    case 'header':
      return isScopedToBody(el) ? 'banner' : 'generic';
    case 'footer':
      return isScopedToBody(el) ? 'contentinfo' : 'generic';
    case 'section':
      // `region` only when the section carries an accessible name (ARIA in HTML).
      return hasNameAttribute(el) ? 'region' : 'generic';
    case 'img': {
      const alt = attr(el, 'alt');
      // alt="" is an explicit "decorative" signal.
      return alt === '' ? 'none' : 'img';
    }
    case 'input': {
      const type = (attr(el, 'type') ?? 'text').toLowerCase();
      if (type === 'hidden') return 'none';
      return INPUT_TYPE_ROLE[type] ?? 'textbox';
    }
    case 'select': {
      const multiple = el.hasAttribute('multiple');
      const size = Number(attr(el, 'size') ?? '0');
      return multiple || size > 1 ? 'listbox' : 'combobox';
    }
    case 'td':
      return 'cell';
    case 'th':
      return attr(el, 'scope') === 'row' ? 'rowheader' : 'columnheader';
    default:
      return TAG_ROLE[name] ?? 'generic';
  }
}

/** `<header>`/`<footer>` map to landmarks only when not nested in sectioning content. */
function isScopedToBody(el: Element): boolean {
  let node = el.parentElement;
  while (node) {
    const name = tag(node);
    if (name === 'article' || name === 'aside' || name === 'main' || name === 'nav' || name === 'section') {
      return false;
    }
    node = node.parentElement;
  }
  return true;
}

function hasNameAttribute(el: Element): boolean {
  return Boolean(trimmed(attr(el, 'aria-label')) || attr(el, 'aria-labelledby') || trimmed(attr(el, 'title')));
}

/**
 * Computed ARIA role: explicit `role` attribute first, then the native element mapping.
 * `presentation` is normalised to `none`.
 */
export function computeRole(el: Element): string {
  const explicit = explicitRole(el);
  if (explicit) return explicit === 'presentation' ? 'none' : explicit;
  return implicitRole(el);
}

/** True when `role` takes its accessible name from the element's descendant text. */
export function namesFromContent(role: string): boolean {
  return NAME_FROM_CONTENT.has(role);
}

function idRefs(el: Element, attribute: string): Element[] {
  const raw = attr(el, attribute);
  if (!raw) return [];
  const root = el.getRootNode() as Document | ShadowRoot;
  const out: Element[] = [];
  for (const id of raw.split(/\s+/)) {
    if (!id) continue;
    const found = typeof root.getElementById === 'function' ? root.getElementById(id) : null;
    if (found) out.push(found);
  }
  return out;
}

/** `<label>` elements associated with a form control, both `for=` and ancestor forms. */
function labelsFor(el: Element): Element[] {
  const out: Element[] = [];
  const native = (el as HTMLInputElement).labels;
  if (native && native.length) {
    for (const label of Array.from(native)) out.push(label);
    return out;
  }
  const id = el.id;
  if (id) {
    const root = el.getRootNode() as Document | ShadowRoot;
    if (typeof root.querySelectorAll === 'function') {
      // CSS.escape is not present in every test DOM; fall back to a manual scan.
      for (const label of Array.from(root.querySelectorAll('label'))) {
        if (label.getAttribute('for') === id) out.push(label);
      }
    }
  }
  const ancestor = el.closest?.('label');
  if (ancestor && !out.includes(ancestor)) out.push(ancestor);
  return out;
}

/**
 * Whether the element is hidden for accessible-name purposes. Deliberately narrower than the
 * snapshot's visibility filter: AccName only excludes hidden subtrees, and referenced
 * `aria-labelledby` targets are exempt from it.
 */
function isHiddenForName(el: Element): boolean {
  if (el.getAttribute('aria-hidden') === 'true') return true;
  if (el.hasAttribute('hidden')) return true;
  const view = el.ownerDocument?.defaultView;
  if (!view) return false;
  try {
    const style = view.getComputedStyle(el as HTMLElement);
    return style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse';
  } catch {
    return false;
  }
}

interface NameContext {
  /** Guards against `aria-labelledby` cycles (AccName step 2B). */
  visited: Set<Element>;
  /** True while descending into a subtree for name-from-content. */
  inContent: boolean;
  /** True when this node was reached through an `aria-labelledby` reference. */
  referenced: boolean;
  /**
   * AccName follows `aria-labelledby` only one level deep: a referenced element's own
   * `aria-labelledby` is ignored, so this is cleared when descending into a reference.
   */
  followLabelledby: boolean;
}

function textAlternative(node: Node, ctx: NameContext): string {
  if (node.nodeType === 3 /* TEXT_NODE */) return node.nodeValue ?? '';
  if (node.nodeType !== 1 /* ELEMENT_NODE */) return '';
  const el = node as Element;
  if (ctx.visited.has(el)) return '';
  if (!ctx.referenced && isHiddenForName(el)) return '';
  ctx.visited.add(el);
  try {
    return nameOf(el, ctx);
  } finally {
    ctx.visited.delete(el);
  }
}

function contentName(el: Element, ctx: NameContext): string {
  const parts: string[] = [];
  const childCtx: NameContext = {
    visited: ctx.visited,
    inContent: true,
    referenced: false,
    followLabelledby: ctx.followLabelledby,
  };
  for (const child of Array.from(el.childNodes)) {
    const part = textAlternative(child, childCtx);
    if (part) parts.push(part);
  }
  // Pseudo-element content (::before/::after) is part of AccName; jsdom returns '' for it.
  return trimmed(parts.join(' '));
}

function nameOf(el: Element, ctx: NameContext): string {
  const name = tag(el);
  const role = computeRole(el);

  // AccName step 2B: aria-labelledby (followed exactly one level deep).
  if (ctx.followLabelledby) {
    const refs = idRefs(el, 'aria-labelledby');
    if (refs.length) {
      const parts: string[] = [];
      for (const ref of refs) {
        const refCtx: NameContext = {
          // A referenced element is always named from its content, whatever its role
          // (AccName step 2B recurses into step 2F), but its own `aria-labelledby` is
          // not followed a second time.
          visited: ctx.visited,
          inContent: true,
          referenced: true,
          followLabelledby: false,
        };
        if (ctx.visited.has(ref)) continue;
        ctx.visited.add(ref);
        try {
          parts.push(nameOf(ref, refCtx));
        } finally {
          ctx.visited.delete(ref);
        }
      }
      const joined = trimmed(parts.join(' '));
      if (joined) return joined;
    }
  }

  // AccName step 2C: aria-label.
  const ariaLabel = trimmed(attr(el, 'aria-label'));
  if (ariaLabel) return ariaLabel;

  // AccName step 2D: native host-language labelling.
  const native = nativeName(el, name, ctx);
  if (native) return native;

  // AccName step 2F: name from content, for roles that support it.
  if (namesFromContent(role) || ctx.inContent) {
    const content = contentName(el, ctx);
    if (content) return content;
  }

  // AccName step 2I: title, then the HTML-AAM placeholder fallback for text controls.
  const title = trimmed(attr(el, 'title'));
  if (title) return title;

  const placeholder = trimmed(attr(el, 'placeholder'));
  if (placeholder && (name === 'input' || name === 'textarea')) return placeholder;

  return '';
}

function nativeName(el: Element, name: string, ctx: NameContext): string {
  switch (name) {
    case 'input': {
      const type = (attr(el, 'type') ?? 'text').toLowerCase();
      if (type === 'submit') return trimmed(attr(el, 'value')) || 'Submit';
      if (type === 'reset') return trimmed(attr(el, 'value')) || 'Reset';
      if (type === 'button') return trimmed(attr(el, 'value'));
      if (type === 'image') return trimmed(attr(el, 'alt')) || trimmed(attr(el, 'value'));
      return labelText(el, ctx);
    }
    case 'select':
    case 'textarea':
    case 'meter':
    case 'output':
    case 'progress':
      return labelText(el, ctx);
    case 'img':
    case 'area': {
      const alt = attr(el, 'alt');
      return alt === null ? '' : trimmed(alt);
    }
    case 'fieldset': {
      const legend = el.querySelector?.('legend');
      return legend ? contentName(legend, ctx) : '';
    }
    case 'table': {
      const caption = el.querySelector?.('caption');
      return caption ? contentName(caption, ctx) : '';
    }
    case 'iframe':
    case 'frame':
      return trimmed(attr(el, 'title')) || trimmed(attr(el, 'name'));
    case 'optgroup':
      return trimmed(attr(el, 'label'));
    case 'option':
      return trimmed(attr(el, 'label')) || trimmed(el.textContent);
    case 'svg': {
      const svgTitle = el.querySelector?.('title');
      return svgTitle ? trimmed(svgTitle.textContent) : '';
    }
    default:
      return '';
  }
}

function labelText(el: Element, ctx: NameContext): string {
  const parts: string[] = [];
  for (const label of labelsFor(el)) {
    if (ctx.visited.has(label)) continue;
    ctx.visited.add(label);
    try {
      parts.push(contentName(label, ctx));
    } finally {
      ctx.visited.delete(label);
    }
  }
  return trimmed(parts.join(' '));
}

/** Accessible name for an element, per AccName 1.2 (the subset that matters on real pages). */
export function computeAccessibleName(el: Element): string {
  const ctx: NameContext = {
    visited: new Set([el]),
    inContent: false,
    referenced: false,
    followLabelledby: true,
  };
  return trimmed(nameOf(el, ctx));
}

/** Heading level from `aria-level` or the `h1`-`h6` tag name; `0` when not a heading. */
export function headingLevel(el: Element): number {
  const explicit = Number(attr(el, 'aria-level') ?? '');
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const name = tag(el);
  return HEADING_TAGS.has(name) ? Number(name.slice(1)) : 0;
}
