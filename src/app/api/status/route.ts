import { handler, json } from "@/lib/server/http";
import { integrationStatus } from "@/lib/server/status";

export const dynamic = "force-dynamic";

export const GET = handler(async () => json(await integrationStatus()));
