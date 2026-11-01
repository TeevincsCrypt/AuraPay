import { z } from "zod";
import { parsePhoneNumberFromString, type CountryCode } from "libphonenumber-js";
import { TARGET_COUNTRY_CODES } from "@/lib/shared/countries";
import { config } from "@/lib/server/config";
import { AppError, enforceRateLimit, handler, json, parseQuery } from "@/lib/server/http";
import { detectOperator } from "@/lib/server/reloadly/catalog";

export const dynamic = "force-dynamic";

const Query = z.object({
  country: z.enum(TARGET_COUNTRY_CODES),
  phone: z.string().min(5).max(20),
});

/** Validates a phone number and asks the provider which operator serves it. */
export const GET = handler(async (req) => {
  enforceRateLimit(req, "detect", 20, 60);
  if (!config.reloadly.configured) throw new AppError("PROVIDER_DISCONNECTED", "The utility provider is not connected.", 503);
  const { country, phone } = parseQuery(req.url, Query);
  const parsed = parsePhoneNumberFromString(phone, country as CountryCode);
  if (!parsed || !parsed.isValid() || parsed.country !== country) {
    return json({ valid: false, e164: null, operator: null });
  }
  const e164 = parsed.number.replace("+", "");
  const operator = await detectOperator(e164, country);
  return json({ valid: true, e164, national: parsed.formatNational(), operator });
});
