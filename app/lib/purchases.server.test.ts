import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";
import { purchaseCourse } from "./purchases.server";
import { createFakeNotifier, type FakeNotifier } from "./notifier.server";

type TestDb = ReturnType<typeof createTestDb>;

const NOW = new Date(2026, 9, 6, 12, 0, 0);

let db: TestDb;
let base: ReturnType<typeof seedBaseData>;
let notifier: FakeNotifier;

beforeEach(() => {
  db = createTestDb();
  base = seedBaseData(db);
  notifier = createFakeNotifier();
});

function enrollmentsOf(userId: number) {
  return db
    .select()
    .from(schema.enrollments)
    .all()
    .filter((e) => e.userId === userId);
}

describe("purchaseCourse: an Individual Purchase", () => {
  it("records the Purchase and gives the buyer an Enrollment", async () => {
    const result = await purchaseCourse(
      db,
      notifier,
      base.user.id,
      base.course.id,
      { kind: "individual_purchase", amountPaid: 4900 },
      "GB",
      NOW
    );

    expect(result.purchase).toMatchObject({
      userId: base.user.id,
      courseId: base.course.id,
      amountPaid: 4900,
      country: "GB",
    });
    expect(enrollmentsOf(base.user.id)).toHaveLength(1);
  });

  it("tells the course's Instructor about the Enrollment", async () => {
    await purchaseCourse(
      db,
      notifier,
      base.user.id,
      base.course.id,
      { kind: "individual_purchase", amountPaid: 4900 },
      null,
      NOW
    );

    expect(notifier.notifications).toMatchObject([
      {
        kind: "enrollment",
        recipients: [{ id: base.instructor.id }],
        actor: { id: base.user.id },
      },
    ]);
  });
});

describe("purchaseCourse: a Team Licence", () => {
  it("records the Purchase and grants Seats, with no Enrollment for the buyer", async () => {
    const result = await purchaseCourse(
      db,
      notifier,
      base.user.id,
      base.course.id,
      { kind: "team_licence", amountPaid: 9800, seatCount: 2 },
      null,
      NOW
    );

    expect(result.purchase).toMatchObject({ userId: base.user.id, amountPaid: 9800 });
    expect(result.seats).toHaveLength(2);
    expect(enrollmentsOf(base.user.id)).toEqual([]);
  });

  it("sends no Enrollment Notification", async () => {
    await purchaseCourse(
      db,
      notifier,
      base.user.id,
      base.course.id,
      { kind: "team_licence", amountPaid: 9800, seatCount: 2 },
      null,
      NOW
    );

    expect(notifier.notifications).toEqual([]);
  });

  it("makes the buyer the Team Admin of one team across Team Licences", async () => {
    const first = await purchaseCourse(
      db,
      notifier,
      base.user.id,
      base.course.id,
      { kind: "team_licence", amountPaid: 4900, seatCount: 1 },
      null,
      NOW
    );
    const second = await purchaseCourse(
      db,
      notifier,
      base.user.id,
      base.course.id,
      { kind: "team_licence", amountPaid: 4900, seatCount: 1 },
      null,
      NOW
    );

    expect(second.seats[0].teamId).toBe(first.seats[0].teamId);
    expect(db.select().from(schema.teamMembers).all()).toMatchObject([
      { userId: base.user.id, role: schema.TeamMemberRole.Admin },
    ]);
  });
});
