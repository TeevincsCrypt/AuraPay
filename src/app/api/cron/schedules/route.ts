import { config } from "@/lib/server/config";
import { AppError, handler, json, requireAdmin } from "@/lib/server/http";
import { runDueSchedules } from "@/lib/server/orders/schedules";
import { autoReleaseDue } from "@/lib/server/savings";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Scheduled-bills runner. Call it every few minutes with `Authorization: Bearer $CRON_SECRET`
 * (Vercel Cron sends this header automatically when CRON_SECRET is set; cron-job.org or
 * Supabase pg_cron can call it too). Each call performs every due run exactly once, and releases
 * matured Savings locks.
 */
async function run(req: Request) {
  if (!config.cronSecret) throw new AppError("CRON_DISABLED", "Scheduled bills runner is disabled (CRON_SECRET not set).", 503);
  requireAdmin(req, config.cronSecret);
  const schedules = await runDueSchedules();
  // The same runner releases matured Savings locks (paid to their owners) when a relayer is set.
  const savings = await autoReleaseDue().catch((e: Error) => ({ released: 0, error: e.message }));
  return json({ ...schedules, savings });
}

export const GET = handler(run);
export const POST = handler(run);
