import { z } from "zod";
import { enforceRateLimit, handler, json, parseQuery } from "@/lib/server/http";
import { requireUser } from "@/lib/server/session";
import { checkUsernameAvailable } from "@/lib/server/transfers";

export const dynamic = "force-dynamic";

const Query = z.object({ username: z.string().min(1).max(32) });

export const GET = handler(async (req) => {
  enforceRateLimit(req, "users:check", 60, 60);
  await requireUser();
  const { username } = parseQuery(req.url, Query);
  return json(await checkUsernameAvailable(username));
});
