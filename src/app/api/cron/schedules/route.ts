import { config } from "@/lib/server/config";
import { AppError, handler, json, requireAdmin } from "@/lib/server/http";
import { runDueSchedules } from "@/lib/server/orders/schedules";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Scheduled-bills runner. Call it every few minutes with `Authorization: Bearer $CRON_SECRET`
 * (Vercel Cron sends this header automatically when CRON_SECRET is set; cron-job.org or
 * Supabase pg_cron can call it too). Each call performs every due run exactly once.
 */
async function run(req: Request) {
  if (!config.cronSecret) throw new AppError("CRON_DISABLED", "Scheduled bills runner is disabled (CRON_SECRET not set).", 503);
  requireAdmin(req, config.cronSecret);
  return json(await runDueSchedules());
}

export const GET = handler(run);
export const POST = handler(run);
