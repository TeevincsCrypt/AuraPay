import { z } from "zod";
import { TARGET_COUNTRY_CODES } from "@/lib/shared/countries";
import { config } from "@/lib/server/config";
import { AppError, enforceRateLimit, handler, json, parseQuery } from "@/lib/server/http";
import { isAirtimeOperator, isDataOperator, operatorsForCountry } from "@/lib/server/reloadly/catalog";
import { friendlyReloadlyMessage, ReloadlyError } from "@/lib/server/reloadly/client";

export const dynamic = "force-dynamic";

const Query = z.object({
  country: z.enum(TARGET_COUNTRY_CODES),
  service: z.enum(["airtime", "data"]),
});

export const GET = handler(async (req) => {
  enforceRateLimit(req, "catalog", 60, 60);
  if (!config.reloadly.configured) throw new AppError("PROVIDER_DISCONNECTED", "The utility provider is not connected.", 503);
  const { country, service } = parseQuery(req.url, Query);
  try {
    const ops = await operatorsForCountry(country);
    const filtered = ops.filter(service === "data" ? isDataOperator : isAirtimeOperator);
    return json({ environment: config.reloadly.mode, operators: filtered });
  } catch (err) {
    if (err instanceof ReloadlyError) throw new AppError(err.errorCode ?? "PROVIDER_ERROR", friendlyReloadlyMessage(err), err.status === 404 ? 404 : 502);
    throw err;
  }
});
