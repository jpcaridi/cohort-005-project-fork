import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";
import {
  getNotificationSettings,
  saveNotificationSetting,
} from "./notification-settings.server";
import {
  createFakeNotifier,
  loggingNotifier,
  type FakeNotifier,
} from "./notifier.server";

type TestDb = ReturnType<typeof createTestDb>;

let db: TestDb;
let base: ReturnType<typeof seedBaseData>;
let notifier: FakeNotifier;

beforeEach(() => {
  db = createTestDb();
  base = seedBaseData(db);
  notifier = createFakeNotifier();
});

function categoriesShown(settings: { category: string }[]) {
  return settings.map((s) => s.category);
}

describe("getNotificationSettings: which switches a person sees", () => {
  it("shows a Student with no Purchase only Discussion Replies", async () => {
    const settings = await getNotificationSettings(db, notifier, base.user.id);

    expect(categoriesShown(settings)).toEqual(["discussion_replies"]);
  });

  it("shows Refund Request updates to someone with a Purchase", async () => {
    db.insert(schema.purchases)
      .values({ userId: base.user.id, courseId: base.course.id, amountPaid: 4900 })
      .run();

    const settings = await getNotificationSettings(db, notifier, base.user.id);

    expect(categoriesShown(settings)).toEqual([
      "refund_request_updates",
      "discussion_replies",
    ]);
  });

  it("shows Open Refund Requests to a Platform Admin", async () => {
    const admin = db
      .insert(schema.users)
      .values({ name: "Pat Admin", email: "pat@example.com", role: schema.UserRole.Admin })
      .returning()
      .get();

    const settings = await getNotificationSettings(db, notifier, admin.id);

    expect(categoriesShown(settings)).toEqual([
      "open_refund_requests",
      "discussion_replies",
    ]);
  });

  it("shows Seat claims to the Team Admin of a Team Licence", async () => {
    const team = db.insert(schema.teams).values({}).returning().get();
    db.insert(schema.teamMembers)
      .values({ teamId: team.id, userId: base.user.id, role: schema.TeamMemberRole.Admin })
      .run();
    const purchase = db
      .insert(schema.purchases)
      .values({ userId: base.user.id, courseId: base.course.id, amountPaid: 9800 })
      .returning()
      .get();
    db.insert(schema.coupons)
      .values({ teamId: team.id, courseId: base.course.id, code: "SEAT-1", purchaseId: purchase.id })
      .run();

    const settings = await getNotificationSettings(db, notifier, base.user.id);

    expect(categoriesShown(settings)).toEqual([
      "refund_request_updates",
      "seat_claims",
      "discussion_replies",
    ]);
  });

  it("does not show Seat claims to a team member who isn't its Team Admin", async () => {
    const admin = db
      .insert(schema.users)
      .values({ name: "Team Boss", email: "boss@example.com", role: schema.UserRole.Student })
      .returning()
      .get();
    const team = db.insert(schema.teams).values({}).returning().get();
    db.insert(schema.teamMembers)
      .values({ teamId: team.id, userId: base.user.id, role: schema.TeamMemberRole.Member })
      .run();
    const purchase = db
      .insert(schema.purchases)
      .values({ userId: admin.id, courseId: base.course.id, amountPaid: 9800 })
      .returning()
      .get();
    db.insert(schema.coupons)
      .values({ teamId: team.id, courseId: base.course.id, code: "SEAT-1", purchaseId: purchase.id })
      .run();

    const settings = await getNotificationSettings(db, notifier, base.user.id);

    expect(categoriesShown(settings)).toEqual(["discussion_replies"]);
  });

  it("shows Enrollments and Discussion Questions to an Instructor", async () => {
    const settings = await getNotificationSettings(db, notifier, base.instructor.id);

    expect(categoriesShown(settings)).toEqual([
      "enrollments",
      "discussion_questions",
      "discussion_replies",
    ]);
  });

  it("counts a Platform Admin who owns a course as an Instructor", async () => {
    const admin = db
      .insert(schema.users)
      .values({ name: "Pat Admin", email: "pat@example.com", role: schema.UserRole.Admin })
      .returning()
      .get();
    db.insert(schema.courses)
      .values({
        title: "Admin Course",
        slug: "admin-course",
        description: "d",
        salesCopy: "s",
        instructorId: admin.id,
        categoryId: base.category.id,
        status: schema.CourseStatus.Published,
      })
      .run();

    const settings = await getNotificationSettings(db, notifier, admin.id);

    expect(categoriesShown(settings)).toEqual([
      "open_refund_requests",
      "enrollments",
      "discussion_questions",
      "discussion_replies",
    ]);
  });
});

describe("getNotificationSettings: whether each switch is on", () => {
  it("shows the defaults, Enrollments off, when the person has no stored preferences", async () => {
    const settings = await getNotificationSettings(db, notifier, base.instructor.id);

    expect(settings).toEqual([
      { category: "enrollments", enabled: false },
      { category: "discussion_questions", enabled: true },
      { category: "discussion_replies", enabled: true },
    ]);
  });

  it("shows the person's stored preferences", async () => {
    notifier.preferences.set(base.instructor.id, {
      enrollments: { feed: true },
      discussion_questions: { feed: false },
      discussion_replies: { feed: true },
    });

    const settings = await getNotificationSettings(db, notifier, base.instructor.id);

    expect(settings).toEqual([
      { category: "enrollments", enabled: true },
      { category: "discussion_questions", enabled: false },
      { category: "discussion_replies", enabled: true },
    ]);
  });

  it("falls back to the default for a category missing from the stored set", async () => {
    notifier.preferences.set(base.instructor.id, {
      discussion_replies: { feed: false },
    });

    const settings = await getNotificationSettings(db, notifier, base.instructor.id);

    expect(settings).toEqual([
      { category: "enrollments", enabled: false },
      { category: "discussion_questions", enabled: true },
      { category: "discussion_replies", enabled: false },
    ]);
  });

  it("shows the defaults when the Notifier has no preferences store (no Knock key)", async () => {
    const settings = await getNotificationSettings(
      db,
      loggingNotifier(),
      base.instructor.id
    );

    expect(settings).toEqual([
      { category: "enrollments", enabled: false },
      { category: "discussion_questions", enabled: true },
      { category: "discussion_replies", enabled: true },
    ]);
  });

  it("shows the defaults when the Notifier can't read preferences", async () => {
    const failing = {
      ...createFakeNotifier(),
      async getPreferences(): Promise<never> {
        throw new Error("Knock is down");
      },
    };

    const settings = await getNotificationSettings(db, failing, base.instructor.id);

    expect(settings).toEqual([
      { category: "enrollments", enabled: false },
      { category: "discussion_questions", enabled: true },
      { category: "discussion_replies", enabled: true },
    ]);
  });
});

describe("saveNotificationSetting", () => {
  it("merges the one change into the person's set, leaving other categories as they were", async () => {
    notifier.preferences.set(base.instructor.id, {
      enrollments: { feed: false },
      discussion_questions: { feed: false },
      discussion_replies: { feed: true },
    });

    const result = await saveNotificationSetting(
      db,
      notifier,
      base.instructor.id,
      "enrollments",
      true
    );

    expect(result).toEqual({ ok: true });
    expect(notifier.preferences.get(base.instructor.id)).toEqual({
      enrollments: { feed: true },
      discussion_questions: { feed: false },
      discussion_replies: { feed: true },
    });
  });

  it("writes nothing for a switch the person can't see", async () => {
    const result = await saveNotificationSetting(
      db,
      notifier,
      base.user.id,
      "open_refund_requests",
      false
    );

    expect(result).toEqual({
      ok: false,
      status: 403,
      error: expect.any(String),
    });
    expect(notifier.preferences.has(base.user.id)).toBe(false);
  });

  it("reports a failure when the Notifier can't save", async () => {
    const failing = {
      ...createFakeNotifier(),
      async setPreference(): Promise<never> {
        throw new Error("Knock is down");
      },
    };

    const result = await saveNotificationSetting(
      db,
      failing,
      base.user.id,
      "discussion_replies",
      false
    );

    expect(result).toEqual({
      ok: false,
      status: 502,
      error: expect.any(String),
    });
  });
});
