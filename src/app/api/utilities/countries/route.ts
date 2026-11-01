import { TARGET_COUNTRIES } from "@/lib/shared/countries";
import type { CountryServices } from "@/lib/shared/types";
import { enforceRateLimit, handler, json } from "@/lib/server/http";
import { errorMessage, log } from "@/lib/server/log";
import { ProviderError, requireUtilityProvider, toAppError } from "@/lib/server/utilities/provider";

export const dynamic = "force-dynamic";

/** Target countries with the services the provider *actually* offers in each. */
export const GET = handler(async (req) => {
  enforceRateLimit(req, "catalog", 60, 60);
  const provider = await requireUtilityProvider();

  const results = await Promise.all(
    TARGET_COUNTRIES.map(async (c) => {
      try {
        return { ...c, services: await provider.countryServices(c.code), error: null as string | null };
      } catch (err) {
        log.warn("catalog.country_failed", { country: c.code, error: errorMessage(err) });
        if (err instanceof ProviderError && err.code === "PROVIDER_AUTH_FAILED") throw err;
        return {
          ...c,
          services: null as CountryServices | null,
          error: err instanceof ProviderError ? err.message : "Couldn't load services.",
        };
      }
    }),
  ).catch((err) => {
    throw toAppError(err);
  });
  return json({ environment: provider.environment, provider: provider.id, countries: results });
});
