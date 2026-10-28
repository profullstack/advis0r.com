/**
 * /api/v1/webhooks: the @profullstack/webhooks API, owned by the signed-in
 * account (the same session cookie every other account route uses).
 *
 * Verified accounts only: a webhook makes this server POST to a URL the
 * account chose, and an unverified account is free to create in bulk.
 */
import type { Client } from "@libsql/client";
import { type Webhooks, webhooksApi } from "@profullstack/webhooks";
import { requireUser } from "../auth/routes.ts";

export const WEBHOOKS_BASE = "/api/v1/webhooks";

export function webhooksRoute(hooks: Webhooks, db: Client): (req: Request, path: string) => Promise<Response | null> {
  const api = webhooksApi(hooks, {
    basePath: WEBHOOKS_BASE,
    owner: async (req) => {
      const guard = await requireUser(req, db, { requireVerified: true });
      return guard.user?.id ?? null;
    },
  });
  return async (req, path) => {
    if (path !== WEBHOOKS_BASE && !path.startsWith(`${WEBHOOKS_BASE}/`)) return null;
    return await api(req);
  };
}
