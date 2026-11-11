import { and, eq, sql } from "drizzle-orm";
import { db } from "~/db";
import { courseRatings, enrollments } from "~/db/schema";

export type CourseRatingSummary = {
  average: number | null;
  count: number;
};

const EMPTY_RATING_SUMMARY: CourseRatingSummary = {
  average: null,
  count: 0,
};

/**
 * Join this onto `courseRatings` so only the ratings of learners who are
 * enrolled count. A refunded learner's rating is kept but left out of the
 * average, and counts again if they buy the course again.
 */
export const countedRatingEnrollment = and(
  eq(enrollments.userId, courseRatings.userId),
  eq(enrollments.courseId, courseRatings.courseId)
);

function roundAverage(average: number) {
  return Math.round(average * 10) / 10;
}

export function getCourseRatingSummary(courseId: number): CourseRatingSummary {
  const result = db
    .select({
      average: sql<number | null>`avg(${courseRatings.rating})`,
      count: sql<number>`count(*)`,
    })
    .from(courseRatings)
    .innerJoin(enrollments, countedRatingEnrollment)
    .where(eq(courseRatings.courseId, courseId))
    .get();

  if (!result || result.count === 0 || result.average === null) {
    return EMPTY_RATING_SUMMARY;
  }

  return { average: roundAverage(result.average), count: result.count };
}
