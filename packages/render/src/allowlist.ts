/** Element and attribute allowlists. Anything not listed is removed (see sanitize.ts for the drop-vs-unwrap rule). */

export const HTML_ELEMENTS = new Set([
  "html", "head", "body", "title", "meta", "link", "style",
  "a", "abbr", "address", "area", "article", "aside", "audio", "b", "bdi", "bdo", "big", "blockquote", "br", "button",
  "caption", "center", "cite", "code", "col", "colgroup", "data", "datalist", "dd", "del", "details", "dfn", "div", "dl", "dt",
  "em", "fieldset", "figcaption", "figure", "font", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hgroup",
  "hr", "i", "img", "input", "ins", "kbd", "label", "legend", "li", "main", "map", "mark", "menu", "meter", "nav", "ol",
  "optgroup", "option", "output", "p", "picture", "pre", "progress", "q", "rp", "rt", "ruby", "s", "samp", "search", "section",
  "select", "small", "source", "span", "strike", "strong", "sub", "summary", "sup", "table", "tbody", "td", "textarea", "tfoot",
  "th", "thead", "time", "tr", "track", "tt", "u", "ul", "var", "video", "wbr",
]);

/** Removed together with everything inside them. */
export const HTML_DROP = new Set([
  "script", "template", "iframe", "frame", "frameset", "noframes", "object", "embed", "applet", "param", "base", "bgsound",
  "xmp", "plaintext", "listing", "noembed", "portal", "fencedframe", "isindex", "keygen", "math", "svg-script", "audioscope",
  "dialog", "slot", "canvas", "selectedcontent",
]);

/** `<noscript>` content is shown (the page was archived without scripts) but the wrapper goes. */
export const HTML_UNWRAP_ALWAYS = new Set(["noscript"]);

export const SVG_ELEMENTS = new Set([
  "svg", "g", "defs", "symbol", "use", "path", "circle", "ellipse", "line", "polyline", "polygon", "rect", "text", "tspan",
  "textpath", "title", "desc", "lineargradient", "radialgradient", "stop", "pattern", "clippath", "mask", "marker", "image",
  "filter", "fegaussianblur", "feoffset", "feblend", "fecolormatrix", "fecomposite", "feflood", "femerge", "femergenode",
  "fedropshadow", "view",
]);

export const SVG_UNWRAP = new Set(["a", "switch"]);

/** Attributes valid on every HTML element. */
export const GLOBAL_ATTRS = new Set([
  "class", "id", "lang", "dir", "title", "style", "role", "hidden", "tabindex", "translate", "itemprop", "itemtype", "itemscope",
  "align", "valign", "bgcolor", "border", "cellpadding", "cellspacing", "nowrap", "width", "height", "color", "face", "size",
  "hspace", "vspace", "clear", "noshade", "start", "type", "value", "reversed", "span", "colspan", "rowspan", "headers", "scope",
  "abbr", "summary", "open", "datetime", "for", "name", "alt", "label", "kind", "srclang", "default", "controls", "loop", "muted",
  "playsinline", "preload", "loading", "decoding", "sizes", "media", "rel", "href", "src", "srcset", "poster", "shape", "coords",
  "min", "max", "low", "high", "optimum", "rows", "cols", "wrap", "maxlength", "minlength", "placeholder", "readonly", "disabled",
  "checked", "selected", "multiple", "required", "pattern", "step", "autocomplete", "inputmode", "usemap", "hreflang", "content",
  "charset", "rev", "char", "charoff", "frame", "rules", "compact", "list",
]);

/** The HTML attributes whose value is a URL. Handled by resource or link rewriting, never copied through. */
export const URL_ATTRS = new Set(["href", "src", "srcset", "poster"]);

/** Which of the globally allowed names make sense on which element is not policed beyond this; browsers ignore the rest. */
export const SVG_ATTRS = new Set([
  "viewbox", "width", "height", "x", "y", "x1", "x2", "y1", "y2", "cx", "cy", "r", "rx", "ry", "d", "points", "transform",
  "fill", "fill-opacity", "fill-rule", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin", "stroke-dasharray",
  "stroke-dashoffset", "stroke-opacity", "stroke-miterlimit", "opacity", "offset", "stop-color", "stop-opacity", "gradientunits",
  "gradienttransform", "spreadmethod", "fx", "fy", "patternunits", "patterncontentunits", "patterntransform", "clip-path",
  "clip-rule", "clippathunits", "mask", "maskunits", "maskcontentunits", "marker-start", "marker-mid", "marker-end", "markerwidth",
  "markerheight", "markerunits", "refx", "refy", "orient", "preserveaspectratio", "font-family", "font-size", "font-weight",
  "font-style", "text-anchor", "dominant-baseline", "alignment-baseline", "letter-spacing", "word-spacing", "text-decoration",
  "dx", "dy", "rotate", "textlength", "lengthadjust", "startoffset", "visibility", "display", "overflow", "vector-effect",
  "id", "class", "style", "role", "lang", "xml:space", "xmlns", "xmlns:xlink", "version", "filter", "stddeviation", "in", "in2",
  "result", "mode", "values", "type", "operator", "k1", "k2", "k3", "k4", "flood-color", "flood-opacity", "color", "color-interpolation-filters",
  "filterunits", "primitiveunits", "aria-hidden", "aria-label", "aria-labelledby", "focusable", "href", "xlink:href", "systemlanguage",
]);

export const INPUT_TYPES = new Set([
  "text", "search", "email", "url", "tel", "number", "password", "checkbox", "radio", "range", "color", "date", "datetime-local",
  "month", "week", "time", "button", "submit", "reset", "file",
]);

export const META_NAMES = new Set(["viewport", "description", "color-scheme", "theme-color", "author", "generator"]);

/** `rel` tokens of `<link>` that are kept, mapped to the kind of resource they load. */
export function linkKind(rel: string): "css" | "icon" | null {
  const tokens = rel.toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.includes("stylesheet") && !tokens.includes("alternate")) return "css";
  if (tokens.some((t) => t === "icon" || t === "apple-touch-icon" || t === "apple-touch-icon-precomposed")) return "icon";
  return null;
}
