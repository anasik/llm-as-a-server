// Server-side sanitizer for model-authored HTML.
//
// The model owns the entire document, including its own CSS. This runs in the
// Worker with HTMLRewriter so the browser needs no JavaScript at all: what
// arrives at the client is already a plain, safe HTML document.
//
// The rule is allowlist-only. Scripting and remote resource loading are removed
// outright; presentation is left alone. Combined with the response CSP, model
// output cannot execute script, reach the network, or frame anything.
import { LIMITS } from "./limits";

// Elements the model may use, with the attributes permitted on each.
const ALLOWED: Record<string, string[]> = {
  html: ["lang", "dir"],
  head: [],
  title: [],
  meta: ["charset", "name", "content"],
  style: ["media"],
  // Only `rel="icon"` with an inline data: URI survives; see safeIconHref.
  // Everything else claiming to be a <link> is removed.
  link: ["rel", "href", "type", "sizes"],
  body: [],

  a: ["href", "rel", "hreflang", "type", "download"],
  abbr: ["title"],
  address: [],
  article: [],
  aside: [],
  b: [],
  bdi: [], bdo: ["dir"],
  blockquote: ["cite"],
  br: [],
  button: ["type", "name", "value", "disabled", "form"],
  caption: [],
  cite: [],
  code: [],
  col: ["span"], colgroup: ["span"],
  data: ["value"],
  datalist: [],
  dd: [], dl: [], dt: [],
  del: ["datetime"],
  details: ["open"],
  dfn: [],
  div: [],
  em: [],
  fieldset: ["disabled", "name"],
  figcaption: [], figure: [],
  footer: [],
  form: ["action", "method", "accept-charset", "novalidate"],
  h1: [], h2: [], h3: [], h4: [], h5: [], h6: [],
  header: [], hgroup: [],
  hr: [],
  i: [],
  img: ["src", "alt", "width", "height", "loading", "decoding"],
  input: [
    "type", "name", "value", "placeholder", "required", "min", "max", "step",
    "checked", "readonly", "disabled", "maxlength", "minlength", "pattern",
    "list", "autocomplete", "size", "multiple",
  ],
  ins: ["datetime"],
  kbd: [],
  label: ["for"],
  legend: [],
  li: ["value"],
  main: [],
  mark: [],
  menu: [],
  meter: ["value", "min", "max", "low", "high", "optimum"],
  nav: [],
  ol: ["start", "reversed", "type"],
  optgroup: ["label", "disabled"],
  option: ["value", "selected", "disabled", "label"],
  output: ["for", "name"],
  p: [],
  picture: [],
  pre: [],
  progress: ["value", "max"],
  q: ["cite"],
  rp: [], rt: [], ruby: [],
  s: [], samp: [], section: [], small: [], span: [], strong: [],
  sub: [], summary: [], sup: [],
  table: [], tbody: [], td: ["colspan", "rowspan", "headers"],
  textarea: ["name", "rows", "cols", "placeholder", "required", "readonly", "disabled", "maxlength", "wrap"],
  tfoot: [], th: ["colspan", "rowspan", "scope", "abbr", "headers"], thead: [],
  time: ["datetime"],
  tr: [],
  u: [], ul: [], var: [], wbr: [],
};

// Attributes accepted on any allowed element. `style` is included because the
// model is responsible for the site's appearance.
const GLOBAL_ATTRS = new Set(["class", "id", "lang", "dir", "title", "role", "hidden", "style", "tabindex"]);

// Removed together with everything inside them.
const DROP_WITH_CONTENT = new Set([
  "script", "iframe", "object", "embed", "applet", "frame", "frameset",
  "noscript", "template", "canvas", "audio", "video", "source", "track",
  "svg", "math", "portal", "marquee", "base", "slot", "dialog",
]);

// Credential and file inputs are refused: this is a simulation and must never
// look like somewhere to type a real secret or hand over a real file.
const BLOCKED_INPUT_TYPES = new Set(["password", "file", "image"]);

const EVENT_ATTR = /^on/i;
const CONTROL_CHARS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

/**
 * Same-origin relative references only. No schemes, no protocol-relative URLs,
 * no absolute URLs — so model output cannot load or leak to a remote host.
 */
export function safeUrl(value: string, { allowDataImage = false } = {}): string | null {
  const raw = value.replace(CONTROL_CHARS, "").trim();
  if (raw === "") return null;

  if (allowDataImage && /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=\s]+$/i.test(raw)) {
    return raw.length <= LIMITS.dataUriChars ? raw : null;
  }
  if (raw.startsWith("//")) return null;
  if (raw.startsWith("#")) return raw;
  if (raw.startsWith("/")) return raw;
  // Anything carrying a scheme separator is rejected rather than guessed at.
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.includes(":")) return null;
  return raw;
}

const ICON_RASTER = /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=\s]+$/i;
const ICON_SVG = /^data:image\/svg\+xml,(.+)$/is;

/**
 * A page may declare its own icon inline, which stops the browser issuing a
 * separate /favicon.ico request — and every such request would otherwise cost a
 * whole inference. Only self-contained data: URIs qualify: no network, no
 * same-origin path (which would be another request), and no scripting.
 *
 * SVG is permitted here and nowhere else. It is inert as an icon, the response
 * CSP grants no script source, and it is the only format a model reliably
 * produces byte-correct — base64 PNG comes back malformed.
 */
export function safeIconHref(value: string): string | null {
  const raw = value.replace(CONTROL_CHARS, "").trim();
  if (raw.length === 0 || raw.length > LIMITS.iconHrefChars) return null;
  if (ICON_RASTER.test(raw)) return raw;

  const svg = raw.match(ICON_SVG);
  if (!svg) return null;

  let decoded: string;
  try {
    decoded = decodeURIComponent(svg[1]!);
  } catch {
    return null;
  }
  if (!/^<svg[\s>]/i.test(decoded.trim())) return null;
  if (!/<\/svg>\s*$/i.test(decoded.trim())) return null;
  // Belt and braces: an icon is never scripted, never fetches, never expands.
  if (/<script|<foreignObject|<use\b|<!ENTITY|<!DOCTYPE|\son[a-z]+\s*=|javascript:|href\s*=|xlink/i.test(decoded)) {
    return null;
  }
  return raw;
}

/**
 * CSS is allowed to shape the page but not to reach the network or reintroduce
 * scripting. Anything that could do either is removed.
 */
export function sanitizeCss(css: string): string {
  let out = css.slice(0, LIMITS.styleChars).replace(CONTROL_CHARS, "");

  // Remote loading and legacy scripting vectors.
  out = out.replace(/@import[^;}]*(;|$)/gi, "");
  out = out.replace(/@charset[^;}]*(;|$)/gi, "");
  out = out.replace(/expression\s*\(/gi, "void(");
  out = out.replace(/behavior\s*:/gi, "void:");
  out = out.replace(/-moz-binding\s*:/gi, "void:");
  out = out.replace(/javascript\s*:/gi, "void:");
  out = out.replace(/vbscript\s*:/gi, "void:");

  // url(...) may only reference same-origin paths or inline raster images.
  //
  // Quoted forms are matched first and allow parentheses inside the quotes: a
  // payload like url("data:image/svg+xml,<svg onload=alert(1)>") must not slip
  // past a matcher that stops at the first closing paren.
  // Approved references are parked on a sentinel so the catch-all below cannot
  // rewrite the output of this pass. Any occurrence of the sentinel in the
  // input is removed first so it cannot be used to smuggle a reference through.
  const SENTINEL = "__las_checked_url__";
  out = out.split(SENTINEL).join("");
  const rewriteUrl = (target: string) => {
    const safe = safeUrl(target, { allowDataImage: true });
    return safe ? `${SENTINEL}("${safe}")` : "none";
  };
  out = out.replace(/url\(\s*"([^"]*)"\s*\)/gi, (_match, target: string) => rewriteUrl(target));
  out = out.replace(/url\(\s*'([^']*)'\s*\)/gi, (_match, target: string) => rewriteUrl(target));
  out = out.replace(/url\(\s*([^'")]*)\s*\)/gi, (_match, target: string) => rewriteUrl(target));
  // Anything still calling url( was not a complete, well-formed reference.
  out = out.replace(/url\s*\(/gi, "none(");
  out = out.split(SENTINEL).join("url");

  // A stray closing tag inside a text node cannot escape the element, but
  // removing it keeps the output unambiguous.
  return out.replace(/<\/style/gi, "");
}

export interface SanitizeResult {
  html: string;
  removedElements: number;
  removedAttributes: number;
}

/**
 * Rewrites a model-authored document into a safe one. Returns the HTML plus
 * counts of what was stripped, which become safe telemetry.
 */
export async function sanitizeDocument(html: string): Promise<SanitizeResult> {
  let removedElements = 0;
  let removedAttributes = 0;
  let styleBuffer = "";

  const rewriter = new HTMLRewriter()
    .on("*", {
      element(element) {
        const tag = element.tagName.toLowerCase();

        if (DROP_WITH_CONTENT.has(tag)) {
          element.remove();
          removedElements++;
          return;
        }
        // Unknown or custom elements lose the tag but keep readable text.
        if (!Object.prototype.hasOwnProperty.call(ALLOWED, tag)) {
          element.removeAndKeepContent();
          removedElements++;
          return;
        }
        if (tag === "link") {
          const rel = (element.getAttribute("rel") ?? "").toLowerCase().trim();
          const safe = rel === "icon" ? safeIconHref(element.getAttribute("href") ?? "") : null;
          if (safe === null) {
            element.remove();
            removedElements++;
            return;
          }
          element.setAttribute("href", safe);
        }

        if (tag === "input") {
          const type = (element.getAttribute("type") ?? "text").toLowerCase();
          if (BLOCKED_INPUT_TYPES.has(type)) {
            element.remove();
            removedElements++;
            return;
          }
        }

        const permitted = ALLOWED[tag]!;
        for (const attribute of [...element.attributes]) {
          const name = attribute[0] ?? "";
          const value = attribute[1] ?? "";
          const lower = name.toLowerCase();

          if (EVENT_ATTR.test(lower) || lower.startsWith("xlink:") || lower.startsWith("xmlns")) {
            element.removeAttribute(name);
            removedAttributes++;
            continue;
          }
          if (!GLOBAL_ATTRS.has(lower) && !permitted.includes(lower)) {
            element.removeAttribute(name);
            removedAttributes++;
            continue;
          }
          if (lower === "style") {
            const cleaned = sanitizeCss(value);
            if (cleaned.trim() === "") {
              element.removeAttribute(name);
              removedAttributes++;
            } else {
              element.setAttribute(name, cleaned);
            }
            continue;
          }
          if (tag === "link" && lower === "href") continue; // already vetted above
          if (lower === "href" || lower === "src" || lower === "action" || lower === "cite" || lower === "formaction") {
            const safe = safeUrl(value, { allowDataImage: lower === "src" });
            if (safe === null) {
              element.removeAttribute(name);
              removedAttributes++;
            } else if (safe !== value) {
              element.setAttribute(name, safe);
            }
            continue;
          }
          if (lower === "srcset" || lower === "ping" || lower === "target") {
            element.removeAttribute(name);
            removedAttributes++;
          }
        }

        if (tag === "a" && element.getAttribute("href")) {
          element.setAttribute("rel", "noopener noreferrer");
        }
        if (tag === "meta") {
          // Only charset and ordinary descriptive metadata survive; refresh
          // redirects and CSP overrides do not.
          const name = (element.getAttribute("name") ?? "").toLowerCase();
          const hasCharset = element.getAttribute("charset") !== null;
          if (!hasCharset && !["description", "viewport", "author", "generator", "theme-color", "color-scheme"].includes(name)) {
            element.remove();
            removedElements++;
          }
        }
      },
      comments(comment) {
        comment.remove();
      },
    })
    .on("style", {
      text(chunk) {
        styleBuffer += chunk.text;
        if (chunk.lastInTextNode) {
          chunk.replace(sanitizeCss(styleBuffer), { html: false });
          styleBuffer = "";
        } else {
          chunk.remove();
        }
      },
    });

  const transformed = rewriter.transform(new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } }));
  return { html: await transformed.text(), removedElements, removedAttributes };
}
