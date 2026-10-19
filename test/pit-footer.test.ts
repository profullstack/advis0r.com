import { beforeEach, describe, expect, test } from "bun:test";
import { injectPitFooter, pitFooterHtml, resetPitFooterCache } from "../src/util/pit-footer.ts";

const SNIPPET = '<style>.pit-foot{}</style><nav class="pit-foot" data-pit-footer>x</nav>';
const ok = (async () => new Response(SNIPPET)) as unknown as typeof fetch;
const boom = (async () => {
  throw new Error("down");
}) as unknown as typeof fetch;

describe("pit footer", () => {
  beforeEach(resetPitFooterCache);

  test("injects before the last </body>", () => {
    const out = injectPitFooter("<html><body><p>hi</p></body></html>", SNIPPET);
    expect(out).toBe(`<html><body><p>hi</p>${SNIPPET}\n</body></html>`);
  });

  test("never adds a second copy and leaves pages without </body> alone", () => {
    const once = injectPitFooter("<body></body>", SNIPPET);
    expect(injectPitFooter(once, SNIPPET)).toBe(once);
    expect(injectPitFooter("<p>fragment</p>", SNIPPET)).toBe("<p>fragment</p>");
    expect(injectPitFooter("<body></body>", "")).toBe("<body></body>");
  });

  test("fetch failure renders nothing", async () => {
    expect(await pitFooterHtml(boom)).toBe("");
  });

  test("caches the snippet and serves it stale", async () => {
    expect(await pitFooterHtml(ok)).toBe(SNIPPET);
    expect(await pitFooterHtml(boom)).toBe(SNIPPET);
  });
});
