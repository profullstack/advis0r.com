import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { handlePlayerRoute } from "../src/player-bundle.ts";

test("/pf-player.js is one same-origin ES module with createPlayer in it", async () => {
  const res = await handlePlayerRoute("/pf-player.js");
  expect(res?.status).toBe(200);
  expect(res?.headers.get("content-type")).toContain("javascript");
  const js = await res!.text();
  expect(js).toContain("pux-player");
  expect(js).toMatch(/export\s*\{[^}]*createPlayer/);
});

test("/pf-player.css is the house player stylesheet; other paths fall through", async () => {
  const res = await handlePlayerRoute("/pf-player.css");
  expect(res?.status).toBe(200);
  expect(await res!.text()).toContain(".pux-player");
  expect(await handlePlayerRoute("/app.js")).toBeNull();
});

test("a direct video source renders as a player host; iframes stay iframes", () => {
  const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  expect(app).toContain('<div class="src-video src-player" data-pf-player data-src="${esc(s.embedUrl)}"><video controls');
  expect(app).toContain('import("/pf-player.js")');
  expect(app).toContain('<div class="src-embed"><iframe');
});
