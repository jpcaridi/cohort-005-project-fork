import { and, eq, isNull } from "drizzle-orm";
import { coupons, courses, purchases, users } from "~/db/schema";
import { enrollUser, findEnrollment, type Enrollment } from "~/lib/enrollments.server";
import { getSeatAvailability, type Db } from "~/lib/refunds.server";

// ─── Seat claims ───
// A Student claiming a Seat on a Team Licence, which gives them an Enrollment.
// Takes the database first and `now` last, like the refunds service.

type Seat = typeof coupons.$inferSelect;
type Purchase = typeof purchases.$inferSelect;

export const SEAT_ON_HOLD =
  "This seat can't be claimed right now. Ask the person who shared it with you.";
export const SEAT_REFUNDED =
  "This seat is no longer available. Ask the person who shared it with you.";

export type SeatClaim = {
  ok: true;
  seat: Seat;
  teamLicence: Purchase;
  /** The Team Admin who bought the Team Licence. */
  teamAdmin: { id: number; name: string; email: string };
  course: { id: number; title: string; slug: string };
  /** Seats on the Team Licence that can still be claimed, after this one. */
  seatsLeft: number;
  enrollment: Enrollment;
};

export type ClaimResult = SeatClaim | { ok: false; error: string };

export function findSeatByCode(db: Db, code: string) {
  return db.select().from(coupons).where(eq(coupons.code, code)).get();
}

/**
 * Claims the Seat with this code for the Student and enrolls them. A Seat can
 * only be claimed from the country the Team Licence was bought in.
 */
export function claimSeat(
  db: Db,
  code: string,
  userId: number,
  userCountry: string,
  now: Date
): ClaimResult {
  const seat = findSeatByCode(db, code);
  if (!seat) {
    return { ok: false, error: "Coupon not found" };
  }

  if (seat.redeemedByUserId !== null) {
    return { ok: false, error: "Coupon has already been redeemed" };
  }

  const availability = getSeatAvailability(db, seat);
  if (availability === "on_hold") {
    return { ok: false, error: SEAT_ON_HOLD };
  }
  if (availability === "refunded") {
    return { ok: false, error: SEAT_REFUNDED };
  }

  if (findEnrollment(db, userId, seat.courseId)) {
    return { ok: false, error: "You are already enrolled in this course" };
  }

  const teamLicence = db
    .select()
    .from(purchases)
    .where(eq(purchases.id, seat.purchaseId))
    .get();
  const teamAdmin = teamLicence
    ? db
        .select({ id: users.id, name: users.name, email: users.email })
        .from(users)
        .where(eq(users.id, teamLicence.userId))
        .get()
    : undefined;
  const course = db
    .select({ id: courses.id, title: courses.title, slug: courses.slug })
    .from(courses)
    .where(eq(courses.id, seat.courseId))
    .get();

  if (!teamLicence || !teamAdmin || !course) {
    return { ok: false, error: "Coupon not found" };
  }

  if (teamLicence.country && teamLicence.country !== userCountry) {
    return {
      ok: false,
      error:
        "This coupon can only be redeemed from the same country as the purchaser",
    };
  }

  const claimedSeat = db
    .update(coupons)
    .set({ redeemedByUserId: userId, redeemedAt: now.toISOString() })
    .where(eq(coupons.id, seat.id))
    .returning()
    .get();

  const enrollment = enrollUser(db, userId, seat.courseId, now);

  const seatsLeft = db
    .select({ id: coupons.id })
    .from(coupons)
    .where(
      and(
        eq(coupons.purchaseId, teamLicence.id),
        isNull(coupons.redeemedAt),
        isNull(coupons.refundedAt)
      )
    )
    .all().length;

  return {
    ok: true,
    seat: claimedSeat,
    teamLicence,
    teamAdmin,
    course,
    seatsLeft,
    enrollment,
  };
}
