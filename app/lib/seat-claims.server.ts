import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "~/db";
import { coupons, courses, purchases } from "~/db/schema";
import {
  findEnrollment,
  notifyEnrollment,
  saveEnrollment,
  type Enrollment,
} from "~/lib/enrollments.server";
import { notifySafely, type Notifier } from "~/lib/notifier.server";
import { getPeople } from "~/lib/people.server";
import {
  findSeatByCode,
  getSeatAvailability,
  teamLicenceOwnerId,
  type Seat,
} from "~/lib/seats.server";

// ─── Seat claims ───
// A Student claiming a Seat on a Team Licence, which gives them an Enrollment.
// Takes the database first, the Notifier next and `now` last, like the
// comments service.

export const SEAT_ON_HOLD =
  "This seat can't be claimed right now. Ask the person who shared it with you.";
export const SEAT_REFUNDED =
  "This seat is no longer available. Ask the person who shared it with you.";

/** A claim the Student can't make, with a message they can read. */
export class SeatClaimRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SeatClaimRefused";
  }
}

export type SeatClaim = {
  seat: Seat;
  course: { id: number; title: string; slug: string };
  /** Seats on the Team Licence that can still be claimed, after this one. */
  seatsLeft: number;
  enrollment: Enrollment;
};

/**
 * Claims the Seat with this code for the Student and enrolls them, in one
 * transaction: the Seat is claimed only if the Enrollment is saved. A Seat can
 * only be claimed from the country the Team Licence was bought in. Throws
 * `SeatClaimRefused` for a claim the Student can't make.
 *
 * Once the claim has committed, the Team Admin who owns the Team Licence gets
 * a Seat-claim Notification (unless they claimed it themselves) and the
 * Instructor an Enrollment Notification (best-effort: a failure is logged, not
 * thrown).
 */
export async function claimSeat(
  db: Db,
  notifier: Notifier,
  code: string,
  userId: number,
  userCountry: string,
  now: Date
): Promise<SeatClaim> {
  const claim = db.transaction((tx) => {
    const seat = findSeatByCode(tx, code);
    if (!seat) {
      throw new SeatClaimRefused("Seat not found");
    }

    const availability = getSeatAvailability(tx, seat);
    if (availability === "claimed") {
      throw new SeatClaimRefused("This Seat has already been claimed");
    }
    if (availability === "on_hold") {
      throw new SeatClaimRefused(SEAT_ON_HOLD);
    }
    if (availability === "refunded") {
      throw new SeatClaimRefused(SEAT_REFUNDED);
    }

    if (findEnrollment(tx, userId, seat.courseId)) {
      throw new SeatClaimRefused("You are already enrolled in this course");
    }

    // Foreign keys guarantee the Team Licence exists; a missing one is a bug,
    // not a claim the Student can't make.
    const teamLicence = tx
      .select({ country: purchases.country })
      .from(purchases)
      .where(eq(purchases.id, seat.purchaseId))
      .get();
    if (!teamLicence) {
      throw new Error(`Seat ${seat.id} has no Team Licence`);
    }
    if (teamLicence.country && teamLicence.country !== userCountry) {
      throw new SeatClaimRefused(
        "This Seat can only be claimed from the country its Team Licence was bought in"
      );
    }

    const claimedSeat = tx
      .update(coupons)
      .set({ redeemedByUserId: userId, redeemedAt: now.toISOString() })
      .where(eq(coupons.id, seat.id))
      .returning()
      .get();

    const saved = saveEnrollment(tx, userId, seat.courseId, now);

    const course = tx
      .select({ id: courses.id, title: courses.title, slug: courses.slug })
      .from(courses)
      .where(eq(courses.id, seat.courseId))
      .get();
    if (!course) {
      throw new Error(`Seat ${seat.id} has no course`);
    }

    const seatsLeft = tx
      .select({ id: coupons.id })
      .from(coupons)
      .where(
        and(
          eq(coupons.purchaseId, seat.purchaseId),
          isNull(coupons.redeemedAt),
          isNull(coupons.refundedAt)
        )
      )
      .all().length;

    return { seat: claimedSeat, course, seatsLeft, saved };
  });

  await notifyEnrollment(db, notifier, claim.saved);
  await notifySeatClaimed(db, notifier, claim.seat, claim.course.title, claim.seatsLeft);

  return {
    seat: claim.seat,
    course: claim.course,
    seatsLeft: claim.seatsLeft,
    enrollment: claim.saved.enrollment,
  };
}

/** Tells the Team Admin who owns the Team Licence, unless they claimed it. */
async function notifySeatClaimed(
  db: Db,
  notifier: Notifier,
  seat: Seat,
  courseTitle: string,
  seatsLeft: number
) {
  const ownerId = teamLicenceOwnerId(db, seat.purchaseId);
  const studentId = seat.redeemedByUserId;
  if (ownerId === undefined || studentId === null || ownerId === studentId) {
    return;
  }

  const people = getPeople(db, [ownerId, studentId]);
  const recipient = people.get(ownerId);
  const student = people.get(studentId);
  if (!recipient || !student) return;

  await notifySafely(notifier, {
    kind: "seat_claimed",
    recipients: [recipient],
    actor: student,
    idempotencyKey: `seat-claimed:${seat.id}`,
    data: {
      seatId: seat.id,
      courseTitle,
      seatsLeft,
      url: "/team",
    },
  });
}
