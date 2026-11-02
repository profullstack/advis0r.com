/**
 * @profullstack/player for the browser, served from advis0r's own origin.
 *
 * advis0r has no client build step: public/app.js is plain JS. So the player is bundled here, once,
 * the first time it is asked for, into one ES module (/pf-player.js) plus its stylesheet
 * (/pf-player.css). app.js imports it only when a report has a direct video file to play.
 * Same pattern as pit.world's src/player-bundle.ts.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

let js: Promise<string> | null = null;
let css: string | null = null;

export function playerJs(): Promise<string> {
  js ??= (async () => {
    const out = await Bun.build({
      entrypoints: [new URL("./client/player-entry.ts", import.meta.url).pathname],
      target: "browser",
      format: "esm",
      splitting: false,
      minify: true,
    });
    if (!out.success) throw new Error(`player bundle failed: ${out.logs.map((l) => l.message).join("; ")}`);
    return await out.outputs[0]!.text();
  })().catch((error) => {
    js = null;
    throw error;
  });
  return js;
}

export function playerCss(): string {
  css ??= readFileSync(createRequire(import.meta.url).resolve("@profullstack/player/player.css"), "utf8");
  return css;
}

/** /pf-player.js and /pf-player.css, or null for any other path. */
export async function handlePlayerRoute(pathname: string): Promise<Response | null> {
  if (pathname === "/pf-player.js") {
    try {
      return new Response(await playerJs(), {
        headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "public, max-age=3600" },
      });
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      return new Response("player unavailable", { status: 503, headers: { "content-type": "text/plain" } });
    }
  }
  if (pathname === "/pf-player.css") {
    return new Response(playerCss(), {
      headers: { "content-type": "text/css; charset=utf-8", "cache-control": "public, max-age=3600" },
    });
  }
  return null;
}
