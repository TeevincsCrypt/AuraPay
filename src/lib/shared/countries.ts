/**
 * AuraPay *target* markets. These are not claims of availability: the services
 * actually offered in each country are fetched live from the utility provider.
 */
export interface TargetCountry {
  code: string;
  name: string;
  flag: string;
  dialCode: string;
  currency: string;
}

export const TARGET_COUNTRIES: TargetCountry[] = [
  { code: "NG", name: "Nigeria", flag: "🇳🇬", dialCode: "234", currency: "NGN" },
  { code: "GH", name: "Ghana", flag: "🇬🇭", dialCode: "233", currency: "GHS" },
  { code: "KE", name: "Kenya", flag: "🇰🇪", dialCode: "254", currency: "KES" },
  { code: "UG", name: "Uganda", flag: "🇺🇬", dialCode: "256", currency: "UGX" },
];

export const TARGET_COUNTRY_CODES = TARGET_COUNTRIES.map((c) => c.code) as [string, ...string[]];

export function countryByCode(code: string): TargetCountry | undefined {
  return TARGET_COUNTRIES.find((c) => c.code === code.toUpperCase());
}
