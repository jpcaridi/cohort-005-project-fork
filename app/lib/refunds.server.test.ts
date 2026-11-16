import { describe, it, expect, beforeEach, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";
import { LessonProgressStatus, RefundStatus, UserRole } from "~/db/schema";
import {
  approveRefundRequest,
  checkRefundRequest,
  declineRefundRequest,
  getRefundOffer,
  getSeatAvailability,
  listRefundRequestsForBuyer,
  listRefundRequestsForReview,
  listTeamLicences,
  raiseRefundRequest,
} from "./refunds.server";
import {
  createFakeNotifier,
  type FakeNotifier,
  type Notifier,
} from "./notifier.server";

type TestDb = ReturnType<typeof createTestDb>;

const NOW = new Date(2026, 9, 6, 12, 0, 0);

function daysBefore(days: number) {
  const when = new Date(NOW);
  when.setDate(when.getDate() - days);
  return when.toISOString();
}

let db: TestDb;
let base: ReturnType<typeof seedBaseData>;
let platformAdmin: typeof schema.users.$inferSelect;
let lessonIds: number[];
let notifier: FakeNotifier;

beforeEach(() => {
  db = createTestDb();
  base = seedBaseData(db);
  notifier = createFakeNotifier();

  platformAdmin = db
    .insert(schema.users)
    .values({
      name: "Pat Admin",
      email: "pat@example.com",
      role: UserRole.Admin,
    })
    .returning()
    .get();

  const module = db
    .insert(schema.modules)
    .values({ courseId: base.course.id, title: "Basics", position: 1 })
    .returning()
    .get();

  lessonIds = [1, 2, 3, 4].map(
    (position) =>
      db
        .insert(schema.lessons)
        .values({ moduleId: module.id, title: `Lesson ${position}`, position })
        .returning()
        .get().id
  );
});

function addLearner(name: string) {
  return db
    .insert(schema.users)
    .values({
      name,
      email: `${name.toLowerCase()}@example.com`,
      role: UserRole.Student,
    })
    .returning()
    .get();
}

function buyForSelf(userId: number, daysAgo = 3, amountPaid = 7900) {
  const purchase = db
    .insert(schema.purchases)
    .values({
      userId,
      courseId: base.course.id,
      amountPaid,
      createdAt: daysBefore(daysAgo),
    })
    .returning()
    .get();
  db.insert(schema.enrollments)
    .values({ userId, courseId: base.course.id })
    .run();
  return purchase;
}

function buySeats(userId: number, seats: number, daysAgo = 3) {
  const team = db.insert(schema.teams).values({}).returning().get();
  const purchase = db
    .insert(schema.purchases)
    .values({
      userId,
      courseId: base.course.id,
      amountPaid: 7900 * seats,
      createdAt: daysBefore(daysAgo),
    })
    .returning()
    .get();
  const seatRows = Array.from({ length: seats }, (_, i) =>
    db
      .insert(schema.coupons)
      .values({
        teamId: team.id,
        courseId: base.course.id,
        code: `SEAT-${purchase.id}-${i}`,
        purchaseId: purchase.id,
      })
      .returning()
      .get()
  );
  return { purchase, seats: seatRows };
}

function claimSeat(seatId: number, userId: number) {
  db.update(schema.coupons)
    .set({ redeemedByUserId: userId, redeemedAt: daysBefore(1) })
    .where(eq(schema.coupons.id, seatId))
    .run();
  db.insert(schema.enrollments)
    .values({ userId, courseId: base.course.id })
    .run();
}

function isEnrolled(userId: number) {
  return !!db
    .select()
    .from(schema.enrollments)
    .where(
      and(
        eq(schema.enrollments.userId, userId),
        eq(schema.enrollments.courseId, base.course.id)
      )
    )
    .get();
}

async function raise(purchaseId: number, buyerId: number) {
  const result = await raiseRefundRequest(
    db,
    notifier,
    purchaseId,
    buyerId,
    "It was not what I expected.",
    NOW
  );
  if (!result.ok) throw new Error(result.error);
  return result.refundRequestId;
}

function getSeat(seatId: number) {
  const seat = db
    .select()
    .from(schema.coupons)
    .where(eq(schema.coupons.id, seatId))
    .get();
  if (!seat) throw new Error("Seat not found");
  return seat;
}

describe("raising a Refund Request", () => {
  it("lets the buyer raise one on an Individual Purchase inside the window", async () => {
    const purchase = buyForSelf(base.user.id);

    const result = await raiseRefundRequest(
      db,
      notifier,
      purchase.id,
      base.user.id,
      "Nope.",
      NOW
    );

    expect(result).toMatchObject({ ok: true, kind: "individual_purchase" });
  });

  it("refuses anyone but the buyer", async () => {
    const purchase = buyForSelf(base.user.id);
    const someoneElse = addLearner("Ben");

    expect(
      checkRefundRequest(db, purchase.id, someoneElse.id, NOW)
    ).toMatchObject({ ok: false, status: 404 });
  });

  it("allows only one Open Refund Request per Purchase", async () => {
    const purchase = buyForSelf(base.user.id);
    await raise(purchase.id, base.user.id);

    expect(
      checkRefundRequest(db, purchase.id, base.user.id, NOW)
    ).toMatchObject({ ok: false, status: 409 });
  });

  it("keeps the fourteenth day open and closes the fifteenth", async () => {
    const onDay14 = buyForSelf(base.user.id, 14);
    const onDay15 = buyForSelf(addLearner("Ben").id, 15);

    expect(checkRefundRequest(db, onDay14.id, onDay14.userId, NOW).ok).toBe(
      true
    );
    expect(
      checkRefundRequest(db, onDay15.id, onDay15.userId, NOW)
    ).toMatchObject({ ok: false, error: "The 14-day window has closed." });
  });

  it("refuses a buyer who has completed half the lessons", async () => {
    const purchase = buyForSelf(base.user.id);
    db.insert(schema.lessonProgress)
      .values(
        lessonIds.slice(0, 2).map((lessonId) => ({
          userId: base.user.id,
          lessonId,
          status: LessonProgressStatus.Completed,
        }))
      )
      .run();

    expect(
      checkRefundRequest(db, purchase.id, base.user.id, NOW)
    ).toMatchObject({ ok: false, status: 403 });
  });

  it("refuses a buyer who has watched two hours", async () => {
    const purchase = buyForSelf(base.user.id);
    db.insert(schema.videoWatchEvents)
      .values([
        {
          userId: base.user.id,
          lessonId: lessonIds[0],
          eventType: "progress",
          positionSeconds: 3600,
        },
        {
          userId: base.user.id,
          lessonId: lessonIds[1],
          eventType: "progress",
          positionSeconds: 3600,
        },
      ])
      .run();

    expect(
      checkRefundRequest(db, purchase.id, base.user.id, NOW)
    ).toMatchObject({ ok: false, status: 403 });
  });

  it("refuses a Team Licence with a Claimed Seat", async () => {
    const teamAdmin = addLearner("Priya");
    const { purchase, seats } = buySeats(teamAdmin.id, 3);
    claimSeat(seats[0].id, addLearner("Ben").id);

    expect(
      checkRefundRequest(db, purchase.id, teamAdmin.id, NOW)
    ).toMatchObject({
      ok: false,
      status: 403,
    });
  });
});

describe("the refund offer on the course page", () => {
  it("offers the newest Individual Purchase, not a newer Team Licence", async () => {
    const individual = buyForSelf(base.user.id, 3);
    buySeats(base.user.id, 5, 1);

    expect(getRefundOffer(db, base.user.id, base.course.id, NOW)).toMatchObject(
      {
        purchaseId: individual.id,
        amount: 7900,
      }
    );
  });

  it("offers nothing once the purchase has been refunded", async () => {
    const purchase = buyForSelf(base.user.id);
    const id = await raise(purchase.id, base.user.id);
    await approveRefundRequest(db, notifier, id, platformAdmin.id, null, NOW);

    expect(getRefundOffer(db, base.user.id, base.course.id, NOW)).toBeNull();
  });
});

describe("approving a Refund Request", () => {
  it("removes the buyer's Enrollment but keeps their progress", async () => {
    const purchase = buyForSelf(base.user.id);
    db.insert(schema.lessonProgress)
      .values({
        userId: base.user.id,
        lessonId: lessonIds[0],
        status: LessonProgressStatus.Completed,
      })
      .run();
    const id = await raise(purchase.id, base.user.id);

    const result = await approveRefundRequest(
      db,
      notifier,
      id,
      platformAdmin.id,
      null,
      NOW
    );

    expect(result.ok).toBe(true);
    expect(isEnrolled(base.user.id)).toBe(false);
    expect(
      db
        .select()
        .from(schema.lessonProgress)
        .where(eq(schema.lessonProgress.userId, base.user.id))
        .all()
    ).toHaveLength(1);

    const refundRequest = db
      .select()
      .from(schema.refunds)
      .where(eq(schema.refunds.id, id))
      .get();
    expect(refundRequest).toMatchObject({
      status: RefundStatus.Approved,
      amountRefunded: 7900,
      resolvedByUserId: platformAdmin.id,
    });
  });

  it("keeps the buyer's Enrollment if they also hold a Claimed Seat for the course", async () => {
    const priya = addLearner("Priya");
    const { seats } = buySeats(priya.id, 2);
    // Liam claims a Seat first, so his Enrollment came from it.
    claimSeat(seats[0].id, base.user.id);
    const purchase = db
      .insert(schema.purchases)
      .values({
        userId: base.user.id,
        courseId: base.course.id,
        amountPaid: 7900,
        createdAt: daysBefore(2),
      })
      .returning()
      .get();
    const id = await raise(purchase.id, base.user.id);

    await approveRefundRequest(db, notifier, id, platformAdmin.id, null, NOW);

    expect(isEnrolled(base.user.id)).toBe(true);
  });

  it("makes a Team Licence's Unclaimed Seats unclaimable", async () => {
    const priya = addLearner("Priya");
    const { purchase, seats } = buySeats(priya.id, 2);
    const id = await raise(purchase.id, priya.id);

    const result = await approveRefundRequest(
      db,
      notifier,
      id,
      platformAdmin.id,
      null,
      NOW
    );

    expect(result.ok).toBe(true);
    for (const seat of seats) {
      expect(getSeatAvailability(db, getSeat(seat.id))).toBe("refunded");
    }
  });

  it("refuses a Team Licence whose Seat was claimed after the request", async () => {
    const priya = addLearner("Priya");
    const { purchase, seats } = buySeats(priya.id, 2);
    const id = await raise(purchase.id, priya.id);
    // Seats are on hold while Open, but older data can still hold a claim.
    claimSeat(seats[0].id, addLearner("Ben").id);

    expect(
      await approveRefundRequest(db, notifier, id, platformAdmin.id, null, NOW)
    ).toMatchObject({
      ok: false,
      status: 409,
    });
    expect(getSeatAvailability(db, getSeat(seats[1].id))).toBe("on_hold");
  });

  it("lets the first decision win", async () => {
    const purchase = buyForSelf(base.user.id);
    const id = await raise(purchase.id, base.user.id);
    await approveRefundRequest(db, notifier, id, platformAdmin.id, null, NOW);

    expect(
      await declineRefundRequest(
        db,
        notifier,
        id,
        platformAdmin.id,
        "Too late.",
        NOW
      )
    ).toMatchObject({
      ok: false,
      status: 409,
      error: "This refund request was already approved.",
    });
  });

  it("emails the buyer that the refund is on its way", async () => {
    const purchase = buyForSelf(base.user.id);
    const id = await raise(purchase.id, base.user.id);

    const result = await approveRefundRequest(
      db,
      notifier,
      id,
      platformAdmin.id,
      null,
      NOW
    );

    if (!result.ok) throw new Error(result.error);
    expect(result.email.to).toBe("test@example.com");
    expect(result.email.subject).toBe("Refund approved — Test Course");
    expect(result.email.body).toContain("$79.00");
  });
});

describe("declining a Refund Request", () => {
  it("needs a note", async () => {
    const purchase = buyForSelf(base.user.id);
    const id = await raise(purchase.id, base.user.id);

    expect(
      await declineRefundRequest(db, notifier, id, platformAdmin.id, "  ", NOW)
    ).toMatchObject({
      ok: false,
      status: 400,
    });
  });

  it("keeps the buyer's Enrollment and lets them raise a new Refund Request", async () => {
    const purchase = buyForSelf(base.user.id);
    const id = await raise(purchase.id, base.user.id);

    const result = await declineRefundRequest(
      db,
      notifier,
      id,
      platformAdmin.id,
      "You finished the course.",
      NOW
    );

    if (!result.ok) throw new Error(result.error);
    expect(result.email.body).toContain("You finished the course.");
    expect(isEnrolled(base.user.id)).toBe(true);
    expect(checkRefundRequest(db, purchase.id, base.user.id, NOW).ok).toBe(
      true
    );
  });

  it("frees a Team Licence's Seats again", async () => {
    const priya = addLearner("Priya");
    const { purchase, seats } = buySeats(priya.id, 1);
    const id = await raise(purchase.id, priya.id);
    expect(getSeatAvailability(db, getSeat(seats[0].id))).toBe("on_hold");

    await declineRefundRequest(
      db,
      notifier,
      id,
      platformAdmin.id,
      "Seats are in use.",
      NOW
    );

    expect(getSeatAvailability(db, getSeat(seats[0].id))).toBe("available");
  });
});

describe("listing Refund Requests", () => {
  it("shows a Platform Admin live figures and the rules a request breaks", async () => {
    const purchase = buyForSelf(base.user.id);
    const id = await raise(purchase.id, base.user.id);
    // Since raising the request, the buyer has finished half the course.
    db.insert(schema.lessonProgress)
      .values(
        lessonIds.slice(0, 2).map((lessonId) => ({
          userId: base.user.id,
          lessonId,
          status: LessonProgressStatus.Completed,
        }))
      )
      .run();

    const [row] = listRefundRequestsForReview(db, RefundStatus.Open, NOW);

    expect(row).toMatchObject({
      id,
      buyerName: "Test User",
      daysSincePurchase: 3,
      figures: {
        kind: "individual_purchase",
        lessonsCompleted: 2,
        lessonCount: 4,
      },
      ruleBreaks: ["completed_too_much"],
      canApprove: true,
    });
  });

  it("shows a Team Licence's Seats instead of the buyer's progress", async () => {
    const priya = addLearner("Priya");
    const { purchase } = buySeats(priya.id, 3);
    await raise(purchase.id, priya.id);

    const [row] = listRefundRequestsForReview(db, RefundStatus.Open, NOW);

    expect(row.figures).toEqual({
      kind: "team_licence",
      seatCount: 3,
      claimedSeatCount: 0,
    });
  });

  it("lists only the requested status, oldest first", async () => {
    const first = buyForSelf(base.user.id);
    const ben = addLearner("Ben");
    const second = buyForSelf(ben.id);
    const firstId = await raise(first.id, base.user.id);
    const secondId = await raiseRefundRequest(
      db,
      notifier,
      second.id,
      ben.id,
      "Changed my mind.",
      new Date(NOW.getTime() + 60_000)
    );
    if (!secondId.ok) throw new Error(secondId.error);

    expect(
      listRefundRequestsForReview(db, RefundStatus.Open, NOW).map((r) => r.id)
    ).toEqual([firstId, secondId.refundRequestId]);

    await approveRefundRequest(
      db,
      notifier,
      firstId,
      platformAdmin.id,
      null,
      NOW
    );

    expect(
      listRefundRequestsForReview(db, RefundStatus.Approved, NOW)
    ).toMatchObject([{ id: firstId, decidedByName: "Pat Admin" }]);
  });

  it("shows a buyer their decided requests with the decline note", async () => {
    const purchase = buyForSelf(base.user.id);
    const id = await raise(purchase.id, base.user.id);
    await declineRefundRequest(
      db,
      notifier,
      id,
      platformAdmin.id,
      "Past half way.",
      NOW
    );

    expect(listRefundRequestsForBuyer(db, base.user.id)).toMatchObject([
      { id, status: RefundStatus.Declined, decisionNote: "Past half way." },
    ]);
  });

  it("lists a Team Admin's Team Licences and whether each can be refunded", async () => {
    const priya = addLearner("Priya");
    buySeats(priya.id, 2);
    const { seats } = buySeats(priya.id, 2);
    claimSeat(seats[0].id, addLearner("Ben").id);

    expect(listTeamLicences(db, priya.id, NOW)).toMatchObject([
      { seatCount: 2, claimedSeatCount: 1, canRequestRefund: false },
      { seatCount: 2, claimedSeatCount: 0, canRequestRefund: true },
    ]);
  });
});

describe("Refund Request Notifications", () => {
  const testUser = {
    id: 0,
    name: "Test User",
    email: "test@example.com",
    avatarUrl: null,
  };

  function sent(kind: string) {
    return notifier.notifications.filter((n) => n.kind === kind);
  }

  it("confirms a raised Refund Request to the buyer, from Cadence itself", async () => {
    const purchase = buyForSelf(base.user.id);

    const id = await raise(purchase.id, base.user.id);

    expect(sent("refund_requested")).toEqual([
      {
        kind: "refund_requested",
        recipients: [{ ...testUser, id: base.user.id }],
        actor: null,
        idempotencyKey: `refund-requested:${id}`,
        data: {
          refundRequestId: id,
          courseTitle: "Test Course",
          amount: 7900,
          url: null,
        },
      },
    ]);
  });

  it("tells every Platform Admin, and nobody else, about a new Open Refund Request", async () => {
    const sam = db
      .insert(schema.users)
      .values({
        name: "Sam Admin",
        email: "sam@example.com",
        role: UserRole.Admin,
      })
      .returning()
      .get();
    const purchase = buyForSelf(base.user.id);

    const id = await raise(purchase.id, base.user.id);

    expect(sent("open_refund_request")).toEqual([
      {
        kind: "open_refund_request",
        recipients: [
          {
            id: platformAdmin.id,
            name: "Pat Admin",
            email: "pat@example.com",
            avatarUrl: null,
          },
          {
            id: sam.id,
            name: "Sam Admin",
            email: "sam@example.com",
            avatarUrl: null,
          },
        ],
        actor: { ...testUser, id: base.user.id },
        idempotencyKey: `open-refund-request:${id}`,
        data: {
          refundRequestId: id,
          courseTitle: "Test Course",
          amount: 7900,
          reason: "It was not what I expected.",
          url: "/admin/refunds",
        },
      },
    ]);
    const everyone = notifier.notifications.flatMap((n) =>
      n.recipients.map((r) => r.id)
    );
    expect(new Set(everyone)).toEqual(
      new Set([base.user.id, platformAdmin.id, sam.id])
    );
  });

  it("tells the buyer their Refund Request was approved, with the note", async () => {
    const purchase = buyForSelf(base.user.id);
    const id = await raise(purchase.id, base.user.id);

    await approveRefundRequest(
      db,
      notifier,
      id,
      platformAdmin.id,
      "Sorry it wasn't for you.",
      NOW
    );

    expect(sent("refund_approved")).toEqual([
      {
        kind: "refund_approved",
        recipients: [{ ...testUser, id: base.user.id }],
        actor: {
          id: platformAdmin.id,
          name: "Pat Admin",
          email: "pat@example.com",
          avatarUrl: null,
        },
        idempotencyKey: `refund-approved:${id}`,
        data: {
          refundRequestId: id,
          purchaseId: purchase.id,
          courseTitle: "Test Course",
          amount: 7900,
          decisionNote: "Sorry it wasn't for you.",
          url: "/settings",
        },
      },
    ]);
  });

  it("tells the buyer their Refund Request was declined, with the note", async () => {
    const purchase = buyForSelf(base.user.id);
    const id = await raise(purchase.id, base.user.id);

    await declineRefundRequest(
      db,
      notifier,
      id,
      platformAdmin.id,
      "  Past half way.  ",
      NOW
    );

    expect(sent("refund_declined")).toMatchObject([
      {
        recipients: [{ id: base.user.id }],
        actor: { id: platformAdmin.id },
        idempotencyKey: `refund-declined:${id}`,
        data: {
          refundRequestId: id,
          purchaseId: purchase.id,
          courseTitle: "Test Course",
          decisionNote: "Past half way.",
        },
      },
    ]);
    expect(sent("refund_approved")).toEqual([]);
  });

  it("sends a Team Licence's Refund Request Notifications to its Team Admin", async () => {
    const priya = addLearner("Priya");
    const { purchase } = buySeats(priya.id, 2);
    const id = await raise(purchase.id, priya.id);

    await approveRefundRequest(db, notifier, id, platformAdmin.id, null, NOW);

    expect(sent("refund_requested")).toMatchObject([
      {
        recipients: [{ id: priya.id, name: "Priya" }],
        data: { amount: 15800 },
      },
    ]);
    expect(sent("refund_approved")).toMatchObject([
      {
        recipients: [{ id: priya.id }],
        data: { decisionNote: null, url: "/team" },
      },
    ]);
  });

  it("sends nothing when the Refund Request is refused", async () => {
    const purchase = buyForSelf(base.user.id);
    const id = await raise(purchase.id, base.user.id);
    notifier.notifications.length = 0;

    await raiseRefundRequest(
      db,
      notifier,
      purchase.id,
      base.user.id,
      "Again.",
      NOW
    );
    await declineRefundRequest(db, notifier, id, platformAdmin.id, "  ", NOW);

    expect(notifier.notifications).toEqual([]);
  });

  it("still raises and decides, and logs, when the Notifier fails", async () => {
    const failing: Notifier = {
      ...createFakeNotifier(),
      async notify() {
        throw new Error("Knock is down");
      },
    };
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const purchase = buyForSelf(base.user.id);

    const raised = await raiseRefundRequest(
      db,
      failing,
      purchase.id,
      base.user.id,
      "Nope.",
      NOW
    );
    if (!raised.ok) throw new Error(raised.error);
    const approved = await approveRefundRequest(
      db,
      failing,
      raised.refundRequestId,
      platformAdmin.id,
      null,
      NOW
    );

    expect(raised.email.subject).toBe("Refund requested — Test Course");
    expect(approved).toMatchObject({
      ok: true,
      email: { subject: "Refund approved — Test Course" },
    });
    expect(isEnrolled(base.user.id)).toBe(false);
    expect(errorLog).toHaveBeenCalledWith(
      expect.stringContaining(`refund-requested:${raised.refundRequestId}`),
      expect.any(Error)
    );
    expect(errorLog).toHaveBeenCalledWith(
      expect.stringContaining(`refund-approved:${raised.refundRequestId}`),
      expect.any(Error)
    );
    errorLog.mockRestore();
  });
});
