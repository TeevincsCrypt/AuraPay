import { z } from "zod";
import { TARGET_COUNTRY_CODES } from "@/lib/shared/countries";
import { enforceRateLimit, handler, json, parseQuery } from "@/lib/server/http";
import { requireUtilityProvider, toAppError } from "@/lib/server/utilities/provider";

export const dynamic = "force-dynamic";

const Query = z.object({ country: z.enum(TARGET_COUNTRY_CODES), service: z.enum(["electricity", "cable", "internet"]).default("electricity") });

export const GET = handler(async (req) => {
  enforceRateLimit(req, "catalog", 60, 60);
  const provider = await requireUtilityProvider();
  const { country, service } = parseQuery(req.url, Query);
  try {
    return json({ environment: provider.environment, provider: provider.id, service, billers: await provider.billers(country, service) });
  } catch (err) {
    throw toAppError(err);
  }
});
