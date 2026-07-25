/**
 * Ad placement guards.
 *
 * Two things must stay true: ad markup is never in the served HTML (it is
 * injected by ads.js only after the visitor is known to be signed out), and
 * the units stay spread across declared zones instead of being stacked at the
 * end of the body the way the generated embed did it.
 */
import { describe, expect, test } from "bun:test";

const html = await Bun.file(new URL("../public/index.html", import.meta.url)).text();
const adsJs = await Bun.file(new URL("../public/ads.js", import.meta.url)).text();

describe("index.html", () => {
  test("ships no ad markup and no ad-network script tag", () => {
    expect(html).not.toContain("data-cp-ad");
    expect(html).not.toContain("crawlproof.com/ad.js");
  });

  test("loads the ad placement script", () => {
    expect(html).toContain('<script src="/ads.js">');
  });

  test("declares one zone per placement, not a stack of banners", () => {
    const zones = [...html.matchAll(/data-ad="([^"]+)"/g)].map((m) => m[1]);
    expect(zones).toEqual(["text_link", "banner_300x250", "auto"]);
  });
});

describe("ads.js", () => {
  test("asks the server whether the visitor is signed in", () => {
    expect(adsJs).toContain("/api/auth/me");
  });

  test("fails closed — no ads when the auth check cannot be answered", () => {
    const catchBlock = adsJs.slice(adsJs.indexOf("} catch {"));
    expect(catchBlock).toContain("return true;");
  });

  test("clears rendered units when the user signs in", () => {
    expect(adsJs).toContain("advis0r:auth-changed");
    expect(adsJs).toContain("if (await isSignedIn()) clear();");
  });
});
