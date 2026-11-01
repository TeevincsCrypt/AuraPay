import { verifiedEvmAddresses } from "@/lib/server/auth/challenges";
import { enforceRateLimit, handler, json } from "@/lib/server/http";
import { currentUser, destroySession } from "@/lib/server/session";
import { getMyProfile } from "@/lib/server/transfers";

export const dynamic = "force-dynamic";

export const GET = handler(async (req) => {
  enforceRateLimit(req, "auth:session", 120, 60);
  const user = await currentUser();
  if (!user) return json({ user: null });
  const [evmAddresses, profile] = await Promise.all([verifiedEvmAddresses(user.id), getMyProfile(user.id)]);
  return json({ user: { address: user.nimiqAddress, evmAddresses, username: profile.username, receiveEvmAddress: profile.receiveEvmAddress, displayCurrency: profile.displayCurrency } });
});

export const DELETE = handler(async (req) => {
  enforceRateLimit(req, "auth:session", 120, 60);
  await destroySession();
  return json({ ok: true });
});
