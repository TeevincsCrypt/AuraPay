import { verifiedEvmAddresses } from "@/lib/server/auth/challenges";
import { enforceRateLimit, handler, json } from "@/lib/server/http";
import { currentUser, destroySession } from "@/lib/server/session";

export const dynamic = "force-dynamic";

export const GET = handler(async (req) => {
  enforceRateLimit(req, "auth:session", 120, 60);
  const user = await currentUser();
  if (!user) return json({ user: null });
  return json({ user: { address: user.nimiqAddress, evmAddresses: await verifiedEvmAddresses(user.id) } });
});

export const DELETE = handler(async (req) => {
  enforceRateLimit(req, "auth:session", 120, 60);
  await destroySession();
  return json({ ok: true });
});
