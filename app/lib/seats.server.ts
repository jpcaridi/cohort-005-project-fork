import { and, eq } from "drizzle-orm";
import type { Queryable } from "~/db";
import { coupons, purchases, refunds, RefundStatus } from "~/db/schema";

// ─── Seats and Team Licences ───
// What the Seat-claim, Notification-settings, refunds and team code all need
// to know about a Team Licence and its Seats. See GLOSSARY.md.

export type Seat = typeof coupons.$inferSelect;

export function findSeatByCode(db: Queryable, code: string): Seat | undefined {
  return db.select().from(coupons).where(eq(coupons.code, code)).get();
}

export function isClaimed(seat: Seat) {
  return seat.redeemedAt !== null;
}

export type SeatAvailability = "available" | "claimed" | "on_hold" | "refunded";

/**
 * Whether a Seat can be claimed right now. A Team Licence's Unclaimed Seats are
 * on hold while it has an Open Refund Request, and can never be claimed once
 * that request is approved.
 */
export function getSeatAvailability(
  db: Queryable,
  seat: Seat
): SeatAvailability {
  if (isClaimed(seat)) return "claimed";
  if (seat.refundedAt !== null) return "refunded";
  const openRefundRequest = db
    .select({ id: refunds.id })
    .from(refunds)
    .where(
      and(
        eq(refunds.purchaseId, seat.purchaseId),
        eq(refunds.status, RefundStatus.Open)
      )
    )
    .get();
  return openRefundRequest ? "on_hold" : "available";
}

/**
 * Team Licences with the Team Admin who owns each one. The Team Admin who owns
 * a Team Licence is the person who bought it (GLOSSARY.md: "A Student who buys
 * and manages a Team Licence"); a Team Licence is a Purchase that granted
 * Seats. The one definition behind both who gets a Seat-claim Notification and
 * who sees the Seat claims switch.
 */
function teamLicenceOwners(db: Queryable) {
  return db
    .selectDistinct({ teamLicenceId: purchases.id, ownerId: purchases.userId })
    .from(purchases)
    .innerJoin(coupons, eq(coupons.purchaseId, purchases.id));
}

/** The Team Admin who owns this Team Licence, or undefined if it isn't one. */
export function teamLicenceOwnerId(
  db: Queryable,
  teamLicenceId: number
): number | undefined {
  return teamLicenceOwners(db).where(eq(purchases.id, teamLicenceId)).get()
    ?.ownerId;
}

/** Whether this person owns any Team Licence. */
export function ownsTeamLicence(db: Queryable, userId: number): boolean {
  return (
    teamLicenceOwners(db).where(eq(purchases.userId, userId)).get() !==
    undefined
  );
}
