export interface CircleMember {
  username: string;
  position: number;
  status: "invited" | "joined" | "declined";
  isOrganizer: boolean;
  isMe: boolean;
}
export interface CircleRound {
  round: number;
  recipient: string;
  dueAt: string;
  paid: number;
  expected: number;
  complete: boolean;
  contributions: { username: string; status: "confirmed" | "pending" | "missing"; transferId: string | null }[];
}
export interface Circle {
  id: string;
  ref: string;
  name: string;
  currency: "NIM" | "USDT";
  contribution: number;
  contributionAtomic: string;
  frequency: "weekly" | "monthly";
  startAt: string;
  status: "forming" | "active" | "completed" | "cancelled";
  organizer: string;
  isOrganizer: boolean;
  myStatus: "invited" | "joined" | "declined";
  members: CircleMember[];
  rounds: CircleRound[];
  currentRound: number | null;
  pot: number;
  myAction: { type: "accept" | "pay" | "receive" | "start" | "wait" | "none"; round?: number; to?: string; dueAt?: string } | null;
}

export function contributionUrl(c: Circle, round: number, to: string): string {
  const qs = new URLSearchParams({
    to,
    currency: c.currency,
    amount: String(c.contribution),
    note: `${c.name} · round ${round}`.slice(0, 40),
    circle: c.id,
    round: String(round),
  });
  return `/send?${qs}`;
}
