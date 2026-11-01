import { z } from "zod";
import { TARGET_COUNTRY_CODES } from "@/lib/shared/countries";
import { config } from "@/lib/server/config";
import { AppError, enforceRateLimit, handler, json, parseQuery } from "@/lib/server/http";
import { electricityBillers } from "@/lib/server/reloadly/catalog";
import { friendlyReloadlyMessage, ReloadlyError } from "@/lib/server/reloadly/client";

export const dynamic = "force-dynamic";

const Query = z.object({ country: z.enum(TARGET_COUNTRY_CODES) });

export const GET = handler(async (req) => {
  enforceRateLimit(req, "catalog", 60, 60);
  if (!config.reloadly.configured) throw new AppError("PROVIDER_DISCONNECTED", "The utility provider is not connected.", 503);
  const { country } = parseQuery(req.url, Query);
  try {
    return json({ environment: config.reloadly.mode, billers: await electricityBillers(country) });
  } catch (err) {
    if (err instanceof ReloadlyError) throw new AppError(err.errorCode ?? "PROVIDER_ERROR", friendlyReloadlyMessage(err), 502);
    throw err;
  }
});
