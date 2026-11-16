import crypto from "crypto";
import { and, eq } from "drizzle-orm";
import type { Db, Tx } from "~/db";
import {
  coupons,
  purchases,
  teamMembers,
  teams,
  TeamMemberRole,
} from "~/db/schema";
import {
  notifyEnrollment,
  saveEnrollment,
  type Enrollment,
} from "~/lib/enrollments.server";
import type { Notifier } from "~/lib/notifier.server";
import type { Seat } from "~/lib/seats.server";

// ─── Purchases ───
// Buying a course: an Individual Purchase gives the buyer an Enrollment; a
// Team Licence grants Seats and no Enrollment (GLOSSARY.md). Takes the
// database first, the Notifier next and `now` last.

export type Purchase = typeof purchases.$inferSelect;

export type PurchaseOrder =
  | { kind: "individual_purchase"; amountPaid: number }
  | { kind: "team_licence"; amountPaid: number; seatCount: number };

export type CompletedPurchase = {
  purchase: Purchase;
  /** The buyer's Enrollment; null for a Team Licence. */
  enrollment: Enrollment | null;
  /** The Seats granted; empty for an Individual Purchase. */
  seats: Seat[];
};

/**
 * Records the Purchase and what it grants, in one transaction. Only an
 * Individual Purchase enrolls the buyer, so only it sends an Enrollment
 * Notification (after the transaction commits; best-effort).
 */
export async function purchaseCourse(
  db: Db,
  notifier: Notifier,
  buyerId: number,
  courseId: number,
  order: PurchaseOrder,
  country: string | null,
  now: Date
): Promise<CompletedPurchase> {
  const completed = db.transaction((tx) => {
    const purchase = tx
      .insert(purchases)
      .values({
        userId: buyerId,
        courseId,
        amountPaid: order.amountPaid,
        country,
        createdAt: now.toISOString(),
      })
      .returning()
      .get();

    if (order.kind === "individual_purchase") {
      const saved = saveEnrollment(tx, buyerId, courseId, now);
      return { purchase, saved, seats: [] };
    }

    const teamId = teamAdministeredBy(tx, buyerId);
    const seats = Array.from({ length: order.seatCount }, () =>
      tx
        .insert(coupons)
        .values({
          teamId,
          courseId,
          code: crypto.randomBytes(12).toString("base64url"),
          purchaseId: purchase.id,
        })
        .returning()
        .get()
    );
    return { purchase, saved: null, seats };
  });

  if (completed.saved) {
    await notifyEnrollment(db, notifier, completed.saved);
  }

  return {
    purchase: completed.purchase,
    enrollment: completed.saved?.enrollment ?? null,
    seats: completed.seats,
  };
}

/** The team this person is Team Admin of, made for them if they have none. */
function teamAdministeredBy(tx: Tx, userId: number): number {
  const membership = tx
    .select({ teamId: teamMembers.teamId })
    .from(teamMembers)
    .where(
      and(
        eq(teamMembers.userId, userId),
        eq(teamMembers.role, TeamMemberRole.Admin)
      )
    )
    .get();
  if (membership) return membership.teamId;

  const team = tx.insert(teams).values({}).returning().get();
  tx.insert(teamMembers)
    .values({ teamId: team.id, userId, role: TeamMemberRole.Admin })
    .run();
  return team.id;
}
