import { describe, it, expect, beforeEach, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";
import { UserRole } from "~/db/schema";

let testDb: ReturnType<typeof createTestDb>;

vi.mock("~/db", () => ({
  get db() {
    return testDb;
  },
}));

import { getCourseRatingSummary } from "./ratings.server";

let base: ReturnType<typeof seedBaseData>;

beforeEach(() => {
  testDb = createTestDb();
  base = seedBaseData(testDb);
});

function enrolledLearnerWhoRated(email: string, rating: number) {
  const learner = testDb
    .insert(schema.users)
    .values({ name: email, email, role: UserRole.Student })
    .returning()
    .get();
  testDb
    .insert(schema.enrollments)
    .values({ userId: learner.id, courseId: base.course.id })
    .run();
  testDb
    .insert(schema.courseRatings)
    .values({ userId: learner.id, courseId: base.course.id, rating })
    .run();
  return learner;
}

function endEnrollment(userId: number) {
  testDb
    .delete(schema.enrollments)
    .where(
      and(
        eq(schema.enrollments.userId, userId),
        eq(schema.enrollments.courseId, base.course.id)
      )
    )
    .run();
}

describe("getCourseRatingSummary", () => {
  it("averages the ratings of learners who are enrolled", () => {
    enrolledLearnerWhoRated("a@example.com", 5);
    enrolledLearnerWhoRated("b@example.com", 2);

    expect(getCourseRatingSummary(base.course.id)).toEqual({
      average: 3.5,
      count: 2,
    });
  });

  it("leaves out a refunded learner's rating, and counts it again if they buy again", () => {
    enrolledLearnerWhoRated("a@example.com", 5);
    const refunded = enrolledLearnerWhoRated("liam@example.com", 2);

    endEnrollment(refunded.id);
    expect(getCourseRatingSummary(base.course.id)).toEqual({
      average: 5,
      count: 1,
    });

    testDb
      .insert(schema.enrollments)
      .values({ userId: refunded.id, courseId: base.course.id })
      .run();
    expect(getCourseRatingSummary(base.course.id)).toEqual({
      average: 3.5,
      count: 2,
    });
  });
});
