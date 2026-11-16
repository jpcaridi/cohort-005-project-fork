import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";
import { RefundStatus, UserRole } from "~/db/schema";
import { claimSeat } from "./seat-claims.server";

type TestDb = ReturnType<typeof createTestDb>;

const NOW = new Date(2026, 9, 6, 12, 0, 0);

let db: TestDb;
let base: ReturnType<typeof seedBaseData>;
let teamAdmin: typeof schema.users.$inferSelect;

beforeEach(() => {
  db = createTestDb();
  base = seedBaseData(db);
  teamAdmin = addUser("Tess");
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
  it("claims the Seat, enrolls the Student and says who owns the Team Licence and how many Seats are left", () => {
    const { purchase, seats } = buyTeamLicence(3);

    const result = claimSeat(db, seats[0].code, base.user.id, "", NOW);

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

  it("counts down Seats left with each claim", () => {
    const { seats } = buyTeamLicence(2);
    claimSeat(db, seats[0].code, base.user.id, "", NOW);

    const result = claimSeat(db, seats[1].code, addUser("Sam").id, "", NOW);

    expect(result).toMatchObject({ ok: true, seatsLeft: 0 });
  });

  it("refuses an unknown code", () => {
    expect(claimSeat(db, "NOPE", base.user.id, "", NOW)).toEqual({
      ok: false,
      error: "Coupon not found",
    });
  });

  it("refuses a Seat someone already claimed", () => {
    const { seats } = buyTeamLicence(1);
    claimSeat(db, seats[0].code, addUser("Sam").id, "", NOW);

    expect(claimSeat(db, seats[0].code, base.user.id, "", NOW)).toEqual({
      ok: false,
      error: "Coupon has already been redeemed",
    });
  });

  it("refuses a Seat on hold while its Team Licence has an Open Refund Request", () => {
    const { purchase, seats } = buyTeamLicence(1);
    db.insert(schema.refunds)
      .values({
        purchaseId: purchase.id,
        status: RefundStatus.Open,
        reason: "Changed plans",
        requestedAt: NOW.toISOString(),
      })
      .run();

    const result = claimSeat(db, seats[0].code, base.user.id, "", NOW);

    expect(result).toMatchObject({ ok: false });
  });

  it("refuses a Student who already has an Enrollment on the course", () => {
    const { seats } = buyTeamLicence(1);
    db.insert(schema.enrollments)
      .values({ userId: base.user.id, courseId: base.course.id })
      .run();

    expect(claimSeat(db, seats[0].code, base.user.id, "", NOW)).toEqual({
      ok: false,
      error: "You are already enrolled in this course",
    });
  });

  it("refuses a claim from a different country than the purchaser's", () => {
    const { seats } = buyTeamLicence(1, "GB");

    expect(claimSeat(db, seats[0].code, base.user.id, "IN", NOW)).toEqual({
      ok: false,
      error:
        "This coupon can only be redeemed from the same country as the purchaser",
    });
  });
});
