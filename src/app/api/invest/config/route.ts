import { handler, json } from "@/lib/server/http";
import { cowWidgetConfig } from "@/lib/server/investing";

export const dynamic = "force-dynamic";

/** Public, non-secret widget settings (app code, optional partner fee). */
export const GET = handler(async () => json(cowWidgetConfig()));
