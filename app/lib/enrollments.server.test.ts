import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";
import { enrollUser } from "./enrollments.server";
import {
  createFakeNotifier,
  type FakeNotifier,
  type Notifier,
} from "./notifier.server";

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

describe("enrollUser", () => {
  it("gives the Student an Enrollment on the course", async () => {
    const enrollment = await enrollUser(db, notifier, base.user.id, base.course.id, NOW);

    expect(enrollment).toMatchObject({
      userId: base.user.id,
      courseId: base.course.id,
      enrolledAt: NOW.toISOString(),
    });
  });

  it("refuses a second Enrollment on the same course", async () => {
    await enrollUser(db, notifier, base.user.id, base.course.id, NOW);

    await expect(
      enrollUser(db, notifier, base.user.id, base.course.id, NOW)
    ).rejects.toThrow("User is already enrolled in this course");
  });

  it("refuses a course that doesn't exist", async () => {
    await expect(
      enrollUser(db, notifier, base.user.id, 9999, NOW)
    ).rejects.toThrow("Course not found");
  });

  it("enrolls a Lapsed Student again", async () => {
    const module = db
      .insert(schema.modules)
      .values({ courseId: base.course.id, title: "Basics", position: 1 })
      .returning()
      .get();
    const lesson = db
      .insert(schema.lessons)
      .values({ moduleId: module.id, title: "Lesson 1", position: 1 })
      .returning()
      .get();
    db.insert(schema.lessonProgress)
      .values({
        userId: base.user.id,
        lessonId: lesson.id,
        status: schema.LessonProgressStatus.Completed,
      })
      .run();
    // Lapsed: progress on the course, but no Enrollment any more.

    const enrollment = await enrollUser(db, notifier, base.user.id, base.course.id, NOW);

    expect(enrollment).toMatchObject({
      userId: base.user.id,
      courseId: base.course.id,
    });
    expect(notifier.notifications).toMatchObject([
      {
        kind: "enrollment",
        recipients: [{ id: base.instructor.id }],
        actor: { id: base.user.id },
      },
    ]);
  });
});

describe("Enrollment Notifications", () => {
  it("tells the course's Instructor which Student enrolled on which course", async () => {
    const enrollment = await enrollUser(
      db,
      notifier,
      base.user.id,
      base.course.id,
      NOW
    );

    expect(notifier.notifications).toEqual([
      {
        kind: "enrollment",
        recipients: [
          {
            id: base.instructor.id,
            name: "Test Instructor",
            email: base.instructor.email,
            avatarUrl: null,
          },
        ],
        actor: {
          id: base.user.id,
          name: "Test User",
          email: base.user.email,
          avatarUrl: null,
        },
        idempotencyKey: `enrollment:${enrollment.id}`,
        data: {
          enrollmentId: enrollment.id,
          courseTitle: "Test Course",
          url: `/instructor/${base.course.id}/students`,
        },
      },
    ]);
  });

  it("sends nothing when the Instructor enrolls on their own course", async () => {
    await enrollUser(db, notifier, base.instructor.id, base.course.id, NOW);

    expect(notifier.notifications).toEqual([]);
  });

  it("still enrolls the Student, and logs, when the Notifier fails", async () => {
    const failing: Notifier = {
      ...createFakeNotifier(),
      async notify() {
        throw new Error("Knock is down");
      },
    };
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const enrollment = await enrollUser(
      db,
      failing,
      base.user.id,
      base.course.id,
      NOW
    );

    expect(enrollment).toMatchObject({ userId: base.user.id });
    expect(error).toHaveBeenCalledWith(
      `Notification enrollment (enrollment:${enrollment.id}) failed:`,
      expect.any(Error)
    );
    error.mockRestore();
  });
});
