import { describe, expect, it } from "vitest";
import { safeIconHref, safeUrl, sanitizeCss, sanitizeDocument } from "../src/kernel/sanitize";

const doc = (inner: string) => `<!doctype html><html><head><title>t</title></head><body>${inner}</body></html>`;

describe("11. generated scripts and unsafe HTML cannot execute", () => {
  it("removes script elements and their contents", async () => {
    const { html } = await sanitizeDocument(doc('<h1>ok</h1><script>window.pwned = true</script><p>after</p>'));
    expect(html).not.toContain("script");
    expect(html).not.toContain("pwned");
    expect(html).toContain("<h1>ok</h1>");
    expect(html).toContain("<p>after</p>");
  });

  it("removes every scripting vector a model might reach for", async () => {
    const { html } = await sanitizeDocument(
      doc(
        '<img src="/x.png" onerror="steal()" alt="x">' +
          "<script>steal()</script>" +
          "<svg><script>steal()</script></svg>" +
          '<iframe src="/evil"></iframe>' +
          '<object data="/evil"></object>' +
          '<embed src="/evil">' +
          '<a href="javascript:steal()">go</a>' +
          "<noscript>hidden</noscript>" +
          '<body onload="steal()">',
      ),
    );

    expect(html).not.toMatch(/steal\(\)/);
    expect(html).not.toContain("onerror");
    expect(html).not.toContain("onload");
    expect(html).not.toContain("<iframe");
    expect(html).not.toContain("<svg");
    expect(html).not.toContain("<object");
    expect(html).not.toContain("<embed");
    expect(html).not.toContain("javascript:");
    expect(html).toContain('src="/x.png"');
  });

  it("keeps the model's stylesheet, which is how it owns the design", async () => {
    const { html } = await sanitizeDocument(
      '<!doctype html><html><head><style>body{margin:0;font-family:system-ui}h1{letter-spacing:-.02em}@media (prefers-color-scheme:dark){body{background:#111;color:#eee}}</style></head><body><h1 style="color:rebeccapurple">Hi</h1></body></html>',
    );

    expect(html).toContain("font-family:system-ui");
    expect(html).toContain("prefers-color-scheme:dark");
    expect(html).toContain('style="color:rebeccapurple"');
  });

  it("strips CSS that could load remotely or reintroduce scripting", () => {
    expect(sanitizeCss('@import url("https://attacker.test/x.css"); body{color:red}')).not.toContain("@import");
    expect(sanitizeCss("body{background:url(https://attacker.test/track.png)}")).toContain("none");
    expect(sanitizeCss("body{background:url('/local.png')}")).toContain('url("/local.png")');
    expect(sanitizeCss("a{width:expression(alert(1))}")).not.toContain("expression(");
    expect(sanitizeCss("a{behavior:url(#default#time2)}")).not.toContain("behavior:");
    expect(sanitizeCss("a{-moz-binding:url(evil.xml)}")).not.toContain("-moz-binding:");
    expect(sanitizeCss("a{background:url(javascript:alert(1))}")).not.toContain("javascript:");
    // Inline raster artwork is allowed; SVG data URIs are not, since they script.
    expect(sanitizeCss('body{background:url("data:image/png;base64,iVBORw0KGgo=")}')).toContain("data:image/png");
    expect(sanitizeCss('body{background:url("data:image/svg+xml,<svg onload=alert(1)>")}')).toContain("none");
  });

  it("rejects unsafe and remote URLs but keeps same-origin relative ones", () => {
    for (const bad of [
      "javascript:alert(1)",
      "JaVaScRiPt:alert(1)",
      "java\nscript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "vbscript:msgbox",
      "//attacker.test/x",
      "https://attacker.test/x",
      "http://attacker.test/x",
      "mailto:someone@example.test",
    ]) {
      expect(safeUrl(bad), bad).toBeNull();
    }
    expect(safeUrl("/concepts/kettle")).toBe("/concepts/kettle");
    expect(safeUrl("relative/page")).toBe("relative/page");
    expect(safeUrl("#section")).toBe("#section");
  });

  it("blocks remote assets and adds rel on links", async () => {
    const { html } = await sanitizeDocument(
      doc('<img src="https://attacker.test/track.gif" alt="t"><img src="/local.png" alt="l"><a href="/ok">c</a>'),
    );
    expect(html).not.toContain("attacker.test");
    expect(html).toContain('src="/local.png"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it("accepts an inline icon and nothing else claiming to be a link", async () => {
    const icon = "data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2016%2016%22%3E%3Crect%20width%3D%2216%22%20height%3D%2216%22%20fill%3D%22%23111%22%2F%3E%3C%2Fsvg%3E";
    expect(safeIconHref(icon)).toBe(icon);

    const { html } = await sanitizeDocument(
      `<!doctype html><html><head><title>t</title><link rel="icon" href="${icon}"></head><body><p>hi</p></body></html>`,
    );
    // The icon survives, which is what stops the browser fetching /favicon.ico.
    expect(html).toContain('rel="icon"');
    expect(html).toContain("data:image/svg+xml");
  });

  it("refuses icons that could script, fetch, or bloat every response", () => {
    // Scripting, entity expansion and external references, even though the CSP
    // would also block them.
    for (const hostile of [
      "data:image/svg+xml,%3Csvg%20onload%3D%22alert(1)%22%3E%3C%2Fsvg%3E",
      "data:image/svg+xml,%3Csvg%3E%3Cscript%3Ealert(1)%3C%2Fscript%3E%3C%2Fsvg%3E",
      "data:image/svg+xml,%3Csvg%3E%3Cuse%20href%3D%22%23x%22%2F%3E%3C%2Fsvg%3E",
      "data:image/svg+xml,%3C!DOCTYPE%20svg%3E%3Csvg%3E%3C%2Fsvg%3E",
      "data:image/svg+xml,not-actually-svg",
      "data:image/svg+xml,%3Csvg%3E",
      "data:image/svg+xml,%ZZ",
    ]) {
      expect(safeIconHref(hostile), hostile.slice(0, 40)).toBeNull();
    }

    // Anything requiring a request defeats the point of an inline icon.
    expect(safeIconHref("/favicon.ico")).toBeNull();
    expect(safeIconHref("https://attacker.test/icon.svg")).toBeNull();

    // It ships in every response, so size is capped.
    const huge = `data:image/svg+xml,%3Csvg%3E${"%20".repeat(600)}%3C%2Fsvg%3E`;
    expect(safeIconHref(huge)).toBeNull();
  });

  it("still drops stylesheets, preloads and every other link", async () => {
    const { html } = await sanitizeDocument(
      '<!doctype html><html><head><title>t</title>' +
        '<link rel="stylesheet" href="https://attacker.test/x.css">' +
        '<link rel="preload" href="/x" as="script">' +
        '<link rel="icon" href="/favicon.ico">' +
        "</head><body><p>hi</p></body></html>",
    );
    expect(html).not.toContain("<link");
    expect(html).not.toContain("attacker.test");
  });

  it("drops link, base and meta-refresh but keeps ordinary metadata", async () => {
    const { html } = await sanitizeDocument(
      '<!doctype html><html><head><title>t</title>' +
        '<meta charset="utf-8">' +
        '<meta name="description" content="a page">' +
        '<meta http-equiv="refresh" content="0;url=https://attacker.test">' +
        '<link rel="stylesheet" href="https://attacker.test/x.css">' +
        '<base href="https://attacker.test/">' +
        "</head><body><p>hi</p></body></html>",
    );

    expect(html).toContain('charset="utf-8"');
    expect(html).toContain('name="description"');
    expect(html).not.toContain("http-equiv");
    expect(html).not.toContain("<link");
    expect(html).not.toContain("<base");
    expect(html).not.toContain("attacker.test");
  });

  it("refuses credential-collecting and file-picking inputs", async () => {
    const { html } = await sanitizeDocument(
      doc(
        '<form action="/login" method="post">' +
          '<input type="text" name="user">' +
          '<input type="password" name="pass">' +
          '<input type="file" name="upload">' +
          '<input type="hidden" name="_method" value="PUT">' +
          "</form>",
      ),
    );

    expect(html).toContain('type="text"');
    expect(html).toContain('name="_method"');
    expect(html).not.toContain("password");
    expect(html).not.toContain('type="file"');
  });

  it("keeps ordinary semantic markup intact", async () => {
    const source = doc(
      '<article><h1>Title</h1><p>Lede.</p>' +
        '<table><caption>c</caption><thead><tr><th scope="col">k</th></tr></thead><tbody><tr><td colspan="2">v</td></tr></tbody></table>' +
        '<form action="/concepts" method="post"><label for="t">Title</label><input id="t" type="text" name="title" required>' +
        '<textarea name="body" rows="3"></textarea><select name="kind"><option value="a">A</option></select>' +
        "<button type=\"submit\">Save</button></form>" +
        "<details><summary>More</summary><p>detail</p></details>" +
        '<pre><code>GET /</code></pre><nav><ul><li><a href="/next">Next</a></li></ul></nav></article>',
    );
    const { html } = await sanitizeDocument(source);

    for (const fragment of ["<h1>Title</h1>", "<caption>", 'scope="col"', 'colspan="2"', "<textarea", "<option", "<summary>", "<code>GET /</code>", 'href="/next"']) {
      expect(html, fragment).toContain(fragment);
    }
  });

  it("removes comments and reports what it stripped", async () => {
    const result = await sanitizeDocument(doc("<p>a</p><!-- internal note --><script>x</script><p onclick='y'>b</p>"));
    expect(result.html).not.toContain("internal note");
    expect(result.removedElements).toBeGreaterThan(0);
    expect(result.removedAttributes).toBeGreaterThan(0);
  });

  it("survives malformed markup without throwing", async () => {
    await expect(sanitizeDocument("<p><div><span>unclosed")).resolves.toBeTruthy();
    await expect(sanitizeDocument("")).resolves.toBeTruthy();
  });
});
