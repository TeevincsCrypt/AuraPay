import "server-only";

/**
 * Mobile network from a number's prefix, for providers without a lookup API (Flutterwave).
 * Numbers can be ported between networks, so the result is a suggestion the user can change.
 * Prefixes are national significant numbers (after the country code).
 */
const PREFIXES: Record<string, Record<string, string[]>> = {
  NG: {
    MTN: ["803", "806", "703", "706", "704", "813", "816", "810", "814", "903", "906", "913", "916", "7025", "7026"],
    Airtel: ["802", "808", "708", "701", "812", "901", "902", "904", "907", "912", "911"],
    Glo: ["805", "807", "705", "815", "811", "905", "915"],
    "9mobile": ["809", "817", "818", "909", "908"],
  },
  GH: {
    MTN: ["24", "54", "55", "59", "25", "53"],
    Telecel: ["20", "50"],
    AirtelTigo: ["26", "56", "27", "57"],
  },
  KE: {
    Safaricom: ["70", "71", "72", "740", "741", "742", "743", "745", "746", "748", "757", "758", "759", "768", "769", "79", "110", "111", "112", "113", "114", "115"],
    Airtel: ["73", "750", "751", "752", "753", "754", "755", "756", "762", "78", "100", "101", "102"],
    Telkom: ["77"],
  },
  UG: {
    MTN: ["77", "78", "76", "79"],
    Airtel: ["70", "75", "74"],
  },
  TZ: {
    Vodacom: ["74", "75", "76"],
    Airtel: ["68", "69", "78"],
    Yas: ["65", "67", "71", "77"],
    Halotel: ["61", "62"],
  },
};

/** Words that identify each network in provider product names. */
export const NETWORK_ALIASES: Record<string, string[]> = {
  MTN: ["mtn"],
  Airtel: ["airtel"],
  Glo: ["glo", "globacom"],
  "9mobile": ["9mobile", "etisalat"],
  Telecel: ["telecel", "vodafone"],
  AirtelTigo: ["airteltigo", "airtel tigo", "at "],
  Safaricom: ["safaricom"],
  Telkom: ["telkom"],
  Vodacom: ["vodacom"],
  Yas: ["yas", "tigo"],
  Halotel: ["halotel"],
};

export function networkFromNumber(e164Digits: string, countryCode: string, dialCode: string): string | null {
  const table = PREFIXES[countryCode];
  if (!table || !e164Digits.startsWith(dialCode)) return null;
  const nsn = e164Digits.slice(dialCode.length);
  let best: { name: string; len: number } | null = null;
  for (const [name, prefixes] of Object.entries(table)) {
    for (const p of prefixes) if (nsn.startsWith(p) && (!best || p.length > best.len)) best = { name, len: p.length };
  }
  return best?.name ?? null;
}

/** The network a provider product/biller name belongs to, if recognisable. */
export function networkFromName(name: string): string | null {
  const n = ` ${name.toLowerCase()} `;
  // Longest alias first so "airteltigo" beats "airtel".
  const entries = Object.entries(NETWORK_ALIASES).flatMap(([net, aliases]) => aliases.map((a) => [net, a] as const)).sort((a, b) => b[1].length - a[1].length);
  for (const [net, alias] of entries) if (n.includes(` ${alias.trim()}`)) return net;
  return null;
}
