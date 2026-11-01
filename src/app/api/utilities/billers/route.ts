import { z } from "zod";
import { TARGET_COUNTRY_CODES } from "@/lib/shared/countries";
import { enforceRateLimit, handler, json, parseQuery } from "@/lib/server/http";
import { requireUtilityProvider, toAppError } from "@/lib/server/utilities/provider";

export const dynamic = "force-dynamic";

const Query = z.object({ country: z.enum(TARGET_COUNTRY_CODES) });

export const GET = handler(async (req) => {
  enforceRateLimit(req, "catalog", 60, 60);
  const provider = await requireUtilityProvider();
  const { country } = parseQuery(req.url, Query);
  try {
    return json({ environment: provider.environment, provider: provider.id, billers: await provider.billers(country) });
  } catch (err) {
    throw toAppError(err);
  }
});
