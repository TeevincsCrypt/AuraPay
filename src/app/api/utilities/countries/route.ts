import { TARGET_COUNTRIES } from "@/lib/shared/countries";
import type { CountryServices } from "@/lib/shared/types";
import { enforceRateLimit, handler, json } from "@/lib/server/http";
import { errorMessage, log } from "@/lib/server/log";
import { ProviderError, requireUtilityProvider, toAppError } from "@/lib/server/utilities/provider";

export const dynamic = "force-dynamic";

const COUNTRY_TIMEOUT_MS = 8_000;

/** Target countries with the services the provider *actually* offers in each. */
export const GET = handler(async (req) => {
  enforceRateLimit(req, "catalog", 60, 60);
  const provider = await requireUtilityProvider();

  const results = await Promise.all(
    TARGET_COUNTRIES.map(async (c) => {
      try {
        // One slow country must not hold up the rest; it can still be opened and retried.
        const services = await Promise.race([
          provider.countryServices(c.code),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), COUNTRY_TIMEOUT_MS)),
        ]);
        return { ...c, services, error: null as string | null };
      } catch (err) {
        log.warn("catalog.country_failed", { country: c.code, error: errorMessage(err) });
        if (err instanceof ProviderError && err.code === "PROVIDER_AUTH_FAILED") throw err;
        return {
          ...c,
          services: null as CountryServices | null,
          error: err instanceof ProviderError ? err.message : errorMessage(err) === "timeout" ? "Provider is slow — tap to try" : "Couldn't load services.",
        };
      }
    }),
  ).catch((err) => {
    throw toAppError(err);
  });
  return json({ environment: provider.environment, provider: provider.id, countries: results });
});
