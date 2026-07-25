/* CrawlProof ad units.

   Ads are for signed-out visitors only: nothing is inserted, and the ad
   network script is never even loaded, while someone is signed in. Placement
   is driven by the `data-ad` zones in index.html — one unit per zone, spread
   through the page, rather than a stack of banners at the end of the body.

   Zones declare a format ("text_link", "banner_300x250", …) or "auto", which
   picks the leaderboard on wide viewports and the mobile banner below it. */

(function () {
  const SLOT = "16098dd0-3e7b-4acb-9210-be85daac11f2";
  const SCRIPT_SRC = "https://crawlproof.com/ad.js";
  const WIDE = 768;

  let scriptRequested = false;
  let resizeTimer = null;
  let authKnown = false;

  const zones = () => document.querySelectorAll("[data-ad]");

  function formatFor(zone) {
    const declared = zone.getAttribute("data-ad");
    if (declared && declared !== "auto") return declared;
    return window.innerWidth >= WIDE ? "banner_728x90" : "banner_320x50";
  }

  function loadScript() {
    if (scriptRequested) {
      // Already loaded: the script only scans on load, so late slots need the
      // manual trigger it exposes.
      if (window.crawlproofAds) window.crawlproofAds.scan();
      return;
    }
    scriptRequested = true;
    const s = document.createElement("script");
    s.src = SCRIPT_SRC;
    s.async = true;
    document.head.appendChild(s);
  }

  function clear() {
    zones().forEach((zone) => {
      zone.innerHTML = "";
      zone.removeAttribute("data-ad-format");
    });
  }

  function render() {
    let changed = false;

    zones().forEach((zone) => {
      const format = formatFor(zone);
      // Re-render only when the format actually changed (a breakpoint cross),
      // so a resize does not throw away an already-served ad.
      if (zone.getAttribute("data-ad-format") === format) return;

      const unit = document.createElement("div");
      unit.setAttribute("data-cp-ad", "");
      unit.setAttribute("data-slot", SLOT);
      unit.setAttribute("data-format", format);
      zone.innerHTML = "";
      zone.appendChild(unit);
      zone.setAttribute("data-ad-format", format);
      changed = true;
    });

    if (changed) loadScript();
  }

  async function isSignedIn() {
    // Once auth.js has reported, its state is authoritative. Before that it
    // still reads as signed out, so the first check has to ask the server —
    // otherwise a signed-in visitor gets a flash of ads on every load.
    if (authKnown && typeof authState !== "undefined" && authState) {
      return Boolean(authState.user);
    }
    try {
      const res = await fetch("/api/auth/me", { credentials: "same-origin" });
      const data = await res.json();
      return Boolean(data.authenticated || data.user);
    } catch {
      // Fail closed: if we cannot tell, assume signed in and show no ads.
      return true;
    }
  }

  async function sync() {
    if (await isSignedIn()) clear();
    else render();
  }

  window.addEventListener("advis0r:auth-changed", () => {
    authKnown = true;
    sync();
  });
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(sync, 200);
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", sync, { once: true });
  } else {
    sync();
  }
})();
