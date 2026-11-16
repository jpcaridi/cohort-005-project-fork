import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";
import { enrollUser } from "./enrollments.server";

type TestDb = ReturnType<typeof createTestDb>;

const NOW = new Date(2026, 9, 6, 12, 0, 0);

let db: TestDb;
let base: ReturnType<typeof seedBaseData>;

beforeEach(() => {
  db = createTestDb();
  base = seedBaseData(db);
});

describe("enrollUser", () => {
  it("gives the Student an Enrollment on the course", () => {
    const enrollment = enrollUser(db, base.user.id, base.course.id, NOW);

    expect(enrollment).toMatchObject({
      userId: base.user.id,
      courseId: base.course.id,
      enrolledAt: NOW.toISOString(),
    });
  });

  it("refuses a second Enrollment on the same course", () => {
    enrollUser(db, base.user.id, base.course.id, NOW);

    expect(() => enrollUser(db, base.user.id, base.course.id, NOW)).toThrow(
      "User is already enrolled in this course"
    );
  });

  it("refuses a course that doesn't exist", () => {
    expect(() => enrollUser(db, base.user.id, 9999, NOW)).toThrow(
      "Course not found"
    );
  });

  it("enrolls a Lapsed Student again", () => {
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

    const enrollment = enrollUser(db, base.user.id, base.course.id, NOW);

    expect(enrollment).toMatchObject({
      userId: base.user.id,
      courseId: base.course.id,
    });
  });
});
