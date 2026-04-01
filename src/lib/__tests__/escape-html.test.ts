import { describe, it, expect } from "vitest";
import { escapeHtml } from "../escape-html.js";

describe("escapeHtml", () => {
  it("escapes ampersands", () => {
    expect(escapeHtml("J&A Fleet")).toBe("J&amp;A Fleet");
  });

  it("escapes angle brackets", () => {
    expect(escapeHtml("<script>alert('xss')</script>")).toBe(
      "&lt;script&gt;alert(&#39;xss&#39;)&lt;/script&gt;",
    );
  });

  it("escapes double quotes", () => {
    expect(escapeHtml('value="test"')).toBe("value=&quot;test&quot;");
  });

  it("returns plain text unchanged", () => {
    expect(escapeHtml("Hello World 123")).toBe("Hello World 123");
  });

  it("handles empty string", () => {
    expect(escapeHtml("")).toBe("");
  });

  it("escapes all special characters together", () => {
    expect(escapeHtml(`<div class="x">'a' & 'b'</div>`)).toBe(
      "&lt;div class=&quot;x&quot;&gt;&#39;a&#39; &amp; &#39;b&#39;&lt;/div&gt;",
    );
  });
});
