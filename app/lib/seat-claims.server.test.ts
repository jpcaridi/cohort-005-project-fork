import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";
import { RefundStatus, UserRole } from "~/db/schema";
import {
  createFakeNotifier,
  type FakeNotifier,
  type Notifier,
} from "./notifier.server";
import { claimSeat } from "./seat-claims.server";

type TestDb = ReturnType<typeof createTestDb>;

const NOW = new Date(2026, 9, 6, 12, 0, 0);

let db: TestDb;
let base: ReturnType<typeof seedBaseData>;
let teamAdmin: typeof schema.users.$inferSelect;
let notifier: FakeNotifier;

beforeEach(() => {
  db = createTestDb();
  base = seedBaseData(db);
  teamAdmin = addUser("Tess");
  notifier = createFakeNotifier();
});

function addUser(name: string) {
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

function buyTeamLicence(seatCount: number, country: string | null = null) {
  const team = db.insert(schema.teams).values({}).returning().get();
  const purchase = db
    .insert(schema.purchases)
    .values({
      userId: teamAdmin.id,
      courseId: base.course.id,
      amountPaid: 7900 * seatCount,
      country,
    })
    .returning()
    .get();
  const seats = Array.from({ length: seatCount }, (_, i) =>
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
  return { purchase, seats };
}

describe("claimSeat", () => {
  it("claims the Seat, enrolls the Student and says who owns the Team Licence and how many Seats are left", async () => {
    const { purchase, seats } = buyTeamLicence(3);

    const result = await claimSeat(db, notifier, seats[0].code, base.user.id, "", NOW);

    expect(result).toMatchObject({
      ok: true,
      seat: {
        id: seats[0].id,
        redeemedByUserId: base.user.id,
        redeemedAt: NOW.toISOString(),
      },
      teamLicence: { id: purchase.id },
      teamAdmin: { id: teamAdmin.id, name: "Tess" },
      course: { id: base.course.id, title: "Test Course" },
      seatsLeft: 2,
      enrollment: { userId: base.user.id, courseId: base.course.id },
    });
  });

  it("counts down Seats left with each claim", async () => {
    const { seats } = buyTeamLicence(2);
    await claimSeat(db, notifier, seats[0].code, base.user.id, "", NOW);

    const result = await claimSeat(db, notifier, seats[1].code, addUser("Sam").id, "", NOW);

    expect(result).toMatchObject({ ok: true, seatsLeft: 0 });
  });

  it("refuses an unknown code", async () => {
    expect(await claimSeat(db, notifier, "NOPE", base.user.id, "", NOW)).toEqual({
      ok: false,
      error: "Coupon not found",
    });
  });

  it("refuses a Seat someone already claimed", async () => {
    const { seats } = buyTeamLicence(1);
    await claimSeat(db, notifier, seats[0].code, addUser("Sam").id, "", NOW);

    expect(await claimSeat(db, notifier, seats[0].code, base.user.id, "", NOW)).toEqual({
      ok: false,
      error: "Coupon has already been redeemed",
    });
  });

  it("refuses a Seat on hold while its Team Licence has an Open Refund Request", async () => {
    const { purchase, seats } = buyTeamLicence(1);
    db.insert(schema.refunds)
      .values({
        purchaseId: purchase.id,
        status: RefundStatus.Open,
        reason: "Changed plans",
        requestedAt: NOW.toISOString(),
      })
      .run();

    const result = await claimSeat(db, notifier, seats[0].code, base.user.id, "", NOW);

    expect(result).toMatchObject({ ok: false });
  });

  it("refuses a Student who already has an Enrollment on the course", async () => {
    const { seats } = buyTeamLicence(1);
    db.insert(schema.enrollments)
      .values({ userId: base.user.id, courseId: base.course.id })
      .run();

    expect(await claimSeat(db, notifier, seats[0].code, base.user.id, "", NOW)).toEqual({
      ok: false,
      error: "You are already enrolled in this course",
    });
  });

  it("refuses a claim from a different country than the purchaser's", async () => {
    const { seats } = buyTeamLicence(1, "GB");

    expect(await claimSeat(db, notifier, seats[0].code, base.user.id, "IN", NOW)).toEqual({
      ok: false,
      error:
        "This coupon can only be redeemed from the same country as the purchaser",
    });
  });
});

describe("Seat-claim Notifications", () => {
  function seatClaimedNotifications() {
    return notifier.notifications.filter((n) => n.kind === "seat_claimed");
  }

  it("tells the Team Admin who claimed a Seat, on which course, and how many Seats are left", async () => {
    const { seats } = buyTeamLicence(3);

    await claimSeat(db, notifier, seats[0].code, base.user.id, "", NOW);

    expect(seatClaimedNotifications()).toEqual([
      {
        kind: "seat_claimed",
        recipients: [
          {
            id: teamAdmin.id,
            name: "Tess",
            email: "tess@example.com",
            avatarUrl: null,
          },
        ],
        actor: {
          id: base.user.id,
          name: "Test User",
          email: "test@example.com",
          avatarUrl: null,
        },
        idempotencyKey: `seat-claimed:${seats[0].id}`,
        data: {
          seatId: seats[0].id,
          courseTitle: "Test Course",
          seatsLeft: 2,
          url: "/team",
        },
      },
    ]);
  });

  it("sends one Notification per claim", async () => {
    const { seats } = buyTeamLicence(2);

    await claimSeat(db, notifier, seats[0].code, base.user.id, "", NOW);
    await claimSeat(db, notifier, seats[1].code, addUser("Sam").id, "", NOW);

    expect(seatClaimedNotifications()).toMatchObject([
      { idempotencyKey: `seat-claimed:${seats[0].id}`, data: { seatsLeft: 1 } },
      { idempotencyKey: `seat-claimed:${seats[1].id}`, data: { seatsLeft: 0 } },
    ]);
  });

  it("also tells the course's Instructor about the Enrollment", async () => {
    const { seats } = buyTeamLicence(1);

    await claimSeat(db, notifier, seats[0].code, base.user.id, "", NOW);

    expect(
      notifier.notifications.filter((n) => n.kind === "enrollment")
    ).toMatchObject([
      {
        recipients: [{ id: base.instructor.id }],
        actor: { id: base.user.id },
      },
    ]);
  });

  it("sends no Seat-claim Notification when the Team Admin claims a Seat themselves", async () => {
    const { seats } = buyTeamLicence(2);

    await claimSeat(db, notifier, seats[0].code, teamAdmin.id, "", NOW);

    expect(seatClaimedNotifications()).toEqual([]);
  });

  it("sends nothing when the claim is refused", async () => {
    await claimSeat(db, notifier, "NOPE", base.user.id, "", NOW);

    expect(notifier.notifications).toEqual([]);
  });

  it("still claims the Seat, and logs, when the Notifier fails", async () => {
    const { seats } = buyTeamLicence(1);
    const failing: Notifier = {
      ...createFakeNotifier(),
      async notify() {
        throw new Error("Knock is down");
      },
    };
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await claimSeat(
      db,
      failing,
      seats[0].code,
      base.user.id,
      "",
      NOW
    );

    expect(result).toMatchObject({ ok: true, seatsLeft: 0 });
    expect(error).toHaveBeenCalledWith(
      `Notification seat_claimed (seat-claimed:${seats[0].id}) failed:`,
      expect.any(Error)
    );
    error.mockRestore();
  });
});
