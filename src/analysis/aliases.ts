/**
 * Model alias resolution (PRD §8.1).
 *
 * Aliases (fast/balanced/deep/latest) are resolved dynamically against the
 * provider's live model list — we do NOT permanently hardcode a "latest"
 * model id. A requested-but-unavailable model must fail loudly, never fall
 * back silently.
 */
import type { ModelDescriptor } from "../types.ts";

export type ModelAlias = "fast" | "balanced" | "deep" | "latest";

export const ALIASES: ModelAlias[] = ["fast", "balanced", "deep", "latest"];

export function isAlias(value: string): value is ModelAlias {
  return (ALIASES as string[]).includes(value);
}

/**
 * Resolve an alias or explicit id against a live model list.
 * Throws if an explicit id is not present (no silent fallback, PRD §8.1.6).
 */
export function resolveModel(
  requested: string,
  models: ModelDescriptor[],
  hints: { deep?: RegExp; fast?: RegExp; balanced?: RegExp },
): string {
  if (!isAlias(requested)) {
    const found = models.find((m) => m.id === requested);
    if (!found) {
      throw new Error(
        `Requested model "${requested}" is not available. Available: ${models
          .map((m) => m.id)
          .join(", ")}`,
      );
    }
    return found.id;
  }

  const byNewest = [...models].sort((a, b) =>
    (b.createdAt ?? "").localeCompare(a.createdAt ?? ""),
  );

  switch (requested) {
    case "latest":
      if (!byNewest[0]) throw new Error("No models available to resolve 'latest'.");
      return byNewest[0].id;
    case "deep": {
      const hit = byNewest.find((m) => hints.deep?.test(m.id));
      return (hit ?? byNewest[0])?.id ?? fail();
    }
    case "fast": {
      const hit = byNewest.find((m) => hints.fast?.test(m.id));
      return (hit ?? byNewest.at(-1))?.id ?? fail();
    }
    case "balanced": {
      const hit = byNewest.find((m) => hints.balanced?.test(m.id));
      return (hit ?? byNewest[Math.floor(byNewest.length / 2)])?.id ?? fail();
    }
  }
}

function fail(): never {
  throw new Error("No models available to resolve alias.");
}
