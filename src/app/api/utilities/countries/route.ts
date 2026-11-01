import { TARGET_COUNTRIES } from "@/lib/shared/countries";
import type { CountryServices } from "@/lib/shared/types";
import { config } from "@/lib/server/config";
import { AppError, enforceRateLimit, handler, json } from "@/lib/server/http";
import { errorMessage, log } from "@/lib/server/log";
import { countryServices } from "@/lib/server/reloadly/catalog";
import { friendlyReloadlyMessage, ReloadlyError } from "@/lib/server/reloadly/client";

export const dynamic = "force-dynamic";

/** Target countries with the services the provider *actually* offers in each. */
export const GET = handler(async (req) => {
  enforceRateLimit(req, "catalog", 60, 60);
  if (!config.reloadly.configured) throw new AppError("PROVIDER_DISCONNECTED", "The utility provider is not connected.", 503);

  const results = await Promise.all(
    TARGET_COUNTRIES.map(async (c) => {
      try {
        return { ...c, services: await countryServices(c.code), error: null as string | null };
      } catch (err) {
        log.warn("catalog.country_failed", { country: c.code, error: errorMessage(err) });
        if (err instanceof ReloadlyError && (err.status === 401 || err.errorCode === "INVALID_CREDENTIALS")) {
          throw new AppError("PROVIDER_AUTH_FAILED", "Could not authenticate with the utility provider.", 502);
        }
        return {
          ...c,
          services: null as CountryServices | null,
          error: err instanceof ReloadlyError ? friendlyReloadlyMessage(err) : "Couldn't load services.",
        };
      }
    }),
  );
  return json({ environment: config.reloadly.mode, countries: results });
});
