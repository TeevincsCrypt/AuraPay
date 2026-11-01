import { z } from "zod";
import { AppError, enforceRateLimit, handler, json, parseBody } from "@/lib/server/http";
import { deleteRecurring, getRecurring, updateRecurring } from "@/lib/server/recurring";
import { requireUser } from "@/lib/server/session";

export const dynamic = "force-dynamic";

const Patch = z.object({
  active: z.boolean().optional(),
  frequency: z.enum(["once", "weekly", "monthly"]).optional(),
  nextDueAt: z.string().datetime({ offset: true }).optional(),
});

const idOf = async (ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  if (!z.string().uuid().safeParse(id).success) throw new AppError("NOT_FOUND", "Reminder not found.", 404);
  return id;
};

export const GET = handler(async (req, ctx: { params: Promise<{ id: string }> }) => {
  enforceRateLimit(req, "recurring:get", 120, 60);
  const user = await requireUser();
  return json({ item: await getRecurring(user.id, await idOf(ctx)) });
});

export const PATCH = handler(async (req, ctx: { params: Promise<{ id: string }> }) => {
  enforceRateLimit(req, "recurring:update", 30, 60);
  const user = await requireUser();
  const body = await parseBody(req, Patch);
  return json({ item: await updateRecurring(user.id, await idOf(ctx), body) });
});

export const DELETE = handler(async (req, ctx: { params: Promise<{ id: string }> }) => {
  enforceRateLimit(req, "recurring:delete", 30, 60);
  const user = await requireUser();
  await deleteRecurring(user.id, await idOf(ctx));
  return json({ ok: true });
});
