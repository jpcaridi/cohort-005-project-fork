import { describe, it, expect, beforeEach, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";
import {
  RefundRequestStatus,
  RefundStatus,
  UserRole,
} from "~/db/schema";

let testDb: ReturnType<typeof createTestDb>;

vi.mock("~/db", () => ({
  get db() {
    return testDb;
  },
}));

import {
  approveRefundRequest,
  getRefundRequestFacts,
  canRaiseRefundRequest,
  declineRefundRequest,
  listRefundRequests,
  markRefundFailed,
  markRefundIssued,
  raiseRefundRequestForLearner,
} from "./refund-requests.server";

const NOW = new Date("2026-11-11T12:00:00.000Z");

function daysBefore(days: number) {
  return new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

let base: ReturnType<typeof seedBaseData>;
let admin: typeof schema.users.$inferSelect;

beforeEach(() => {
  testDb = createTestDb();
  base = seedBaseData(testDb);
  admin = testDb
    .insert(schema.users)
    .values({ name: "Ada Admin", email: "ada@example.com", role: UserRole.Admin })
    .returning()
    .get();
});

function buyCourse(
  amountPaid = 7900,
  daysAgo = 9,
  courseId = base.course.id
) {
  const purchase = testDb
    .insert(schema.purchases)
    .values({
      userId: base.user.id,
      courseId,
      amountPaid,
      createdAt: daysBefore(daysAgo),
    })
    .returning()
    .get();
  testDb
    .insert(schema.enrollments)
    .values({
      userId: base.user.id,
      courseId,
      enrolledAt: daysBefore(daysAgo),
    })
    .run();
  return purchase;
}

function openRequest(purchaseId: number, daysAgo = 4) {
  return testDb
    .insert(schema.refundRequests)
    .values({
      purchaseId,
      reason: "Bought the wrong one, I meant the advanced course.",
      requestedAt: daysBefore(daysAgo),
    })
    .returning()
    .get();
}

function getRequest(id: number) {
  const row = testDb
    .select()
    .from(schema.refundRequests)
    .where(eq(schema.refundRequests.id, id))
    .get();
  if (!row) throw new Error("refund request missing");
  return row;
}

function isEnrolled() {
  return !!testDb
    .select()
    .from(schema.enrollments)
    .where(
      and(
        eq(schema.enrollments.userId, base.user.id),
        eq(schema.enrollments.courseId, base.course.id)
      )
    )
    .get();
}

/** The HTTP status a rule rejects with, or null when it doesn't throw. */
function rejectionStatus(action: () => unknown): number | null {
  try {
    action();
    return null;
  } catch (error) {
    const init = (error as { init?: { status?: number } }).init;
    return init?.status ?? null;
  }
}

describe("approving a Refund Request", () => {
  it("creates a Pending Refund for the full amount and ends access", () => {
    const purchase = buyCourse(7900);
    const request = openRequest(purchase.id);

    approveRefundRequest(request.id, admin.id, 7900, null, NOW);

    const approved = getRequest(request.id);
    expect(approved.status).toBe(RefundRequestStatus.Approved);
    expect(approved.refundStatus).toBe(RefundStatus.Pending);
    expect(approved.amountRefunded).toBe(7900);
    expect(approved.resolvedByUserId).toBe(admin.id);
    expect(approved.resolvedAt).toBe(NOW.toISOString());
    expect(isEnrolled()).toBe(false);
  });

  it("can only be done by an Admin", () => {
    const purchase = buyCourse();
    const request = openRequest(purchase.id);

    expect(
      rejectionStatus(() =>
        approveRefundRequest(request.id, base.instructor.id, 7900, null, NOW)
      )
    ).toBe(403);
    expect(getRequest(request.id).status).toBe(RefundRequestStatus.Open);
    expect(isEnrolled()).toBe(true);
  });

  it.each([0, -100, 7901])(
    "rejects a refund of %i cents on a $79 purchase",
    (amount) => {
      const purchase = buyCourse(7900);
      const request = openRequest(purchase.id);

      expect(
        rejectionStatus(() =>
          approveRefundRequest(request.id, admin.id, amount, "Reason", NOW)
        )
      ).toBe(400);
      expect(getRequest(request.id).status).toBe(RefundRequestStatus.Open);
    }
  );

  it("needs a reason for a Partial Refund", () => {
    const purchase = buyCourse(7900);
    const request = openRequest(purchase.id);

    expect(
      rejectionStatus(() =>
        approveRefundRequest(request.id, admin.id, 4000, "  ", NOW)
      )
    ).toBe(400);

    approveRefundRequest(
      request.id,
      admin.id,
      4000,
      "Watched most of the course after asking.",
      NOW
    );
    const approved = getRequest(request.id);
    expect(approved.amountRefunded).toBe(4000);
    expect(approved.decisionReason).toBe(
      "Watched most of the course after asking."
    );
  });

  it("can't be done twice, because decisions are final", () => {
    const purchase = buyCourse(7900);
    const request = openRequest(purchase.id);
    approveRefundRequest(request.id, admin.id, 7900, null, NOW);

    expect(
      rejectionStatus(() =>
        approveRefundRequest(request.id, admin.id, 4000, "Again", NOW)
      )
    ).toBe(409);
    expect(getRequest(request.id).amountRefunded).toBe(7900);
  });

  it("emails the learner the amount", () => {
    const purchase = buyCourse(7900);
    const request = openRequest(purchase.id);

    const { email } = approveRefundRequest(request.id, admin.id, 7900, null, NOW);

    expect(email.to).toBe("test@example.com");
    expect(email.subject).toBe("Refund approved — Test Course");
    expect(email.body).toContain("$79.00");
  });

  it("tells the learner why a Partial Refund is less than they paid", () => {
    const purchase = buyCourse(7900);
    const request = openRequest(purchase.id);

    const { email } = approveRefundRequest(
      request.id,
      admin.id,
      4000,
      "Watched most of the course after asking.",
      NOW
    );

    expect(email.body).toContain("$40.00 of the $79.00 you paid");
    expect(email.body).toContain("Watched most of the course after asking.");
  });
});

describe("declining a Refund Request", () => {
  it("records the reason, keeps access and emails the reason", () => {
    const purchase = buyCourse();
    const request = openRequest(purchase.id);

    const { email } = declineRefundRequest(
      request.id,
      admin.id,
      "You have finished the course.",
      NOW
    );

    const declined = getRequest(request.id);
    expect(declined.status).toBe(RefundRequestStatus.Declined);
    expect(declined.decisionReason).toBe("You have finished the course.");
    expect(declined.resolvedByUserId).toBe(admin.id);
    expect(declined.refundStatus).toBeNull();
    expect(declined.amountRefunded).toBeNull();
    expect(isEnrolled()).toBe(true);
    expect(email.subject).toBe("Refund request declined — Test Course");
    expect(email.body).toContain("You have finished the course.");
  });

  it("needs a reason", () => {
    const purchase = buyCourse();
    const request = openRequest(purchase.id);

    expect(
      rejectionStatus(() => declineRefundRequest(request.id, admin.id, " ", NOW))
    ).toBe(400);
    expect(getRequest(request.id).status).toBe(RefundRequestStatus.Open);
  });

  it("can only be done by an Admin, on an Open Refund Request", () => {
    const purchase = buyCourse();
    const request = openRequest(purchase.id);

    expect(
      rejectionStatus(() =>
        declineRefundRequest(request.id, base.instructor.id, "No.", NOW)
      )
    ).toBe(403);

    declineRefundRequest(request.id, admin.id, "No.", NOW);
    expect(
      rejectionStatus(() =>
        declineRefundRequest(request.id, admin.id, "No again.", NOW)
      )
    ).toBe(409);
  });
});

describe("an Admin raising a Refund Request for a learner", () => {
  it("is approved as it is raised, even after the refund window", () => {
    const purchase = buyCourse(7900, 30);

    const { email } = raiseRefundRequestForLearner(
      purchase.id,
      admin.id,
      "Agreed by email: the videos would not play.",
      7900,
      null,
      NOW
    );

    const [raised] = testDb.select().from(schema.refundRequests).all();
    expect(raised.status).toBe(RefundRequestStatus.Approved);
    expect(raised.raisedByUserId).toBe(admin.id);
    expect(raised.reason).toBe("Agreed by email: the videos would not play.");
    expect(raised.refundStatus).toBe(RefundStatus.Pending);
    expect(raised.amountRefunded).toBe(7900);
    expect(isEnrolled()).toBe(false);
    expect(email.subject).toBe("Refund approved — Test Course");
  });

  it("needs the learner's reason", () => {
    const purchase = buyCourse();

    expect(
      rejectionStatus(() =>
        raiseRefundRequestForLearner(purchase.id, admin.id, "", 7900, null, NOW)
      )
    ).toBe(400);
  });

  it("can only be done by an Admin", () => {
    const purchase = buyCourse();

    expect(
      rejectionStatus(() =>
        raiseRefundRequestForLearner(
          purchase.id,
          base.instructor.id,
          "Agreed by email.",
          7900,
          null,
          NOW
        )
      )
    ).toBe(403);
  });

  it("isn't allowed while the purchase has an Open Refund Request", () => {
    const purchase = buyCourse();
    openRequest(purchase.id);

    expect(
      rejectionStatus(() =>
        raiseRefundRequestForLearner(
          purchase.id,
          admin.id,
          "Agreed by email.",
          7900,
          null,
          NOW
        )
      )
    ).toBe(409);
  });

  it("isn't allowed on a purchase that has already been refunded", () => {
    const purchase = buyCourse();
    raiseRefundRequestForLearner(
      purchase.id,
      admin.id,
      "Agreed by email.",
      7900,
      null,
      NOW
    );

    expect(
      rejectionStatus(() =>
        raiseRefundRequestForLearner(
          purchase.id,
          admin.id,
          "Agreed by email again.",
          7900,
          null,
          NOW
        )
      )
    ).toBe(409);
  });

  it("isn't allowed for a claimed team seat", () => {
    const purchase = buyCourse();
    const team = testDb.insert(schema.teams).values({}).returning().get();
    testDb
      .insert(schema.coupons)
      .values({
        teamId: team.id,
        courseId: base.course.id,
        code: "TEAM-SEAT-1",
        purchaseId: purchase.id,
        redeemedByUserId: base.user.id,
        redeemedAt: daysBefore(8),
      })
      .run();

    expect(
      rejectionStatus(() =>
        raiseRefundRequestForLearner(
          purchase.id,
          admin.id,
          "Agreed by email.",
          7900,
          null,
          NOW
        )
      )
    ).toBe(403);
  });
});

describe("the Refund", () => {
  function approvedRequest() {
    const purchase = buyCourse(7900);
    const request = openRequest(purchase.id);
    approveRefundRequest(request.id, admin.id, 7900, null, NOW);
    return request;
  }

  it("becomes Issued when the Admin confirms the money was sent", () => {
    const request = approvedRequest();

    const { email } = markRefundIssued(request.id, admin.id, NOW);

    expect(getRequest(request.id).refundStatus).toBe(RefundStatus.Issued);
    expect(email.subject).toBe("Refund sent — Test Course");
    expect(email.body).toContain("$79.00");
  });

  it("becomes Failed with an optional reason, and asks the learner to reply", () => {
    const request = approvedRequest();

    const { email } = markRefundFailed(
      request.id,
      admin.id,
      "The card has been closed.",
      NOW
    );

    const failed = getRequest(request.id);
    expect(failed.refundStatus).toBe(RefundStatus.Failed);
    expect(failed.refundFailureReason).toBe("The card has been closed.");
    expect(failed.status).toBe(RefundRequestStatus.Approved);
    expect(email.subject).toBe("We couldn't send your refund — Test Course");
    expect(email.body).toContain("Reply to this email");

    markRefundFailed(request.id, admin.id, null, NOW);
    expect(getRequest(request.id).refundFailureReason).toBeNull();
  });

  it("can be retried after it fails, until it is Issued", () => {
    const request = approvedRequest();
    markRefundFailed(request.id, admin.id, "Processor timed out.", NOW);
    markRefundFailed(request.id, admin.id, "Timed out again.", NOW);

    markRefundIssued(request.id, admin.id, NOW);

    expect(getRequest(request.id).refundStatus).toBe(RefundStatus.Issued);
    expect(
      rejectionStatus(() => markRefundFailed(request.id, admin.id, null, NOW))
    ).toBe(409);
    expect(
      rejectionStatus(() => markRefundIssued(request.id, admin.id, NOW))
    ).toBe(409);
  });

  it("doesn't exist for a Refund Request that isn't approved", () => {
    const purchase = buyCourse();
    const request = openRequest(purchase.id);

    expect(
      rejectionStatus(() => markRefundIssued(request.id, admin.id, NOW))
    ).toBe(409);
  });

  it("can only be updated by an Admin", () => {
    const request = approvedRequest();

    expect(
      rejectionStatus(() =>
        markRefundIssued(request.id, base.instructor.id, NOW)
      )
    ).toBe(403);
  });
});

describe("listing Refund Requests", () => {
  function otherInstructorsCourse() {
    const otherInstructor = testDb
      .insert(schema.users)
      .values({
        name: "Other Instructor",
        email: "other@example.com",
        role: UserRole.Instructor,
      })
      .returning()
      .get();
    return testDb
      .insert(schema.courses)
      .values({
        title: "Other Course",
        slug: "other-course",
        description: "Another course",
        salesCopy: "## Other Course",
        instructorId: otherInstructor.id,
        categoryId: base.category.id,
        status: schema.CourseStatus.Published,
      })
      .returning()
      .get();
  }

  it("marks an Open Refund Request overdue after 3 calendar days", () => {
    const waitedThree = openRequest(buyCourse().id, 3);
    const waitedFour = openRequest(buyCourse().id, 4);

    const rows = listRefundRequests(admin.id, NOW);

    const overdueById = new Map(rows.map((row) => [row.id, row.isOverdue]));
    expect(overdueById.get(waitedThree.id)).toBe(false);
    expect(overdueById.get(waitedFour.id)).toBe(true);
  });

  it("flags Overdue Refund Requests and Failed Refunds as needing action", () => {
    const overdue = openRequest(buyCourse().id, 5);
    const failed = openRequest(buyCourse().id, 1);
    approveRefundRequest(failed.id, admin.id, 7900, null, NOW);
    markRefundFailed(failed.id, admin.id, null, NOW);
    const pending = openRequest(buyCourse().id, 5);
    approveRefundRequest(pending.id, admin.id, 7900, null, NOW);
    const fresh = openRequest(buyCourse().id, 1);

    const needsAction = new Map(
      listRefundRequests(admin.id, NOW).map((row) => [row.id, row.needsAction])
    );

    expect(needsAction.get(overdue.id)).toBe(true);
    expect(needsAction.get(failed.id)).toBe(true);
    expect(needsAction.get(pending.id)).toBe(false);
    expect(needsAction.get(fresh.id)).toBe(false);
  });

  it("shows an Instructor only the Refund Requests on their own courses", () => {
    const mine = openRequest(buyCourse().id);
    openRequest(buyCourse(7900, 9, otherInstructorsCourse().id).id);

    const rows = listRefundRequests(base.instructor.id, NOW);

    expect(rows.map((row) => row.id)).toEqual([mine.id]);
    expect(rows[0].courseTitle).toBe("Test Course");
    expect(rows[0].learnerName).toBe("Test User");
  });

  it("shows an Admin every Refund Request", () => {
    openRequest(buyCourse().id);
    openRequest(buyCourse(7900, 9, otherInstructorsCourse().id).id);

    expect(listRefundRequests(admin.id, NOW)).toHaveLength(2);
  });

  it("isn't available to learners", () => {
    expect(rejectionStatus(() => listRefundRequests(base.user.id, NOW))).toBe(
      403
    );
  });
});

describe("the decision screen", () => {
  function courseWithLessons() {
    const module = testDb
      .insert(schema.modules)
      .values({ courseId: base.course.id, title: "Basics", position: 1 })
      .returning()
      .get();
    return [10, 20, null].map((durationMinutes, i) =>
      testDb
        .insert(schema.lessons)
        .values({
          moduleId: module.id,
          title: `Lesson ${i + 1}`,
          position: i + 1,
          durationMinutes,
        })
        .returning()
        .get()
    );
  }

  function watch(lessonId: number, positionSeconds: number, daysAgo: number) {
    testDb
      .insert(schema.videoWatchEvents)
      .values({
        userId: base.user.id,
        lessonId,
        eventType: "heartbeat",
        positionSeconds,
        createdAt: daysBefore(daysAgo),
      })
      .run();
  }

  it("shows progress against the course totals, before and since the request", () => {
    const [first, second] = courseWithLessons();
    const purchase = buyCourse(7900, 9);
    testDb
      .insert(schema.lessonProgress)
      .values({
        userId: base.user.id,
        lessonId: first.id,
        status: schema.LessonProgressStatus.Completed,
        completedAt: daysBefore(8),
      })
      .run();
    watch(first.id, 600, 8);
    watch(second.id, 300, 6);
    const request = openRequest(purchase.id, 4);
    watch(second.id, 900, 2);

    const facts = getRefundRequestFacts(request.id, admin.id, NOW);

    expect(facts.lessons).toEqual({ completed: 1, total: 3 });
    expect(facts.watched).toEqual({
      secondsBeforeRequest: 900,
      secondsSinceRequest: 600,
      courseSeconds: 1800,
      lessonsWithoutDuration: 1,
    });
    expect(facts.dayOfWindowWhenRequested).toBe(5);
    expect(facts.refundWindowDays).toBe(14);
    expect(facts.amountPaid).toBe(7900);
    expect(facts.learnerName).toBe("Test User");
    expect(facts.courseTitle).toBe("Test Course");
  });

  it("shows quiz attempts", () => {
    const [first] = courseWithLessons();
    const purchase = buyCourse();
    const quiz = testDb
      .insert(schema.quizzes)
      .values({ lessonId: first.id, title: "Check", passingScore: 0.7 })
      .returning()
      .get();
    for (const [score, passed] of [
      [0.4, false],
      [0.9, true],
    ] as const) {
      testDb
        .insert(schema.quizAttempts)
        .values({ userId: base.user.id, quizId: quiz.id, score, passed })
        .run();
    }
    const request = openRequest(purchase.id);

    const facts = getRefundRequestFacts(request.id, admin.id, NOW);

    expect(facts.quizAttempts).toEqual({ attempts: 2, quizzesPassed: 1 });
  });

  it("shows the learner's past Refund Requests", () => {
    const purchase = buyCourse();
    const earlier = openRequest(purchase.id, 6);
    declineRefundRequest(earlier.id, admin.id, "Not enough detail.", NOW);
    const request = openRequest(purchase.id, 2);

    const facts = getRefundRequestFacts(request.id, admin.id, NOW);

    expect(facts.pastRefundRequests).toEqual([
      expect.objectContaining({
        id: earlier.id,
        courseTitle: "Test Course",
        status: RefundRequestStatus.Declined,
        decisionReason: "Not enough detail.",
      }),
    ]);
  });

  it("lets an Admin decide, and lets the course's Instructor only look", () => {
    const request = openRequest(buyCourse().id);

    expect(getRefundRequestFacts(request.id, admin.id, NOW).canDecide).toBe(
      true
    );
    expect(
      getRefundRequestFacts(request.id, base.instructor.id, NOW).canDecide
    ).toBe(false);
  });

  it("isn't shown to an Instructor of a different course", () => {
    const request = openRequest(buyCourse().id);
    const otherInstructor = testDb
      .insert(schema.users)
      .values({
        name: "Other Instructor",
        email: "other@example.com",
        role: UserRole.Instructor,
      })
      .returning()
      .get();

    expect(
      rejectionStatus(() =>
        getRefundRequestFacts(request.id, otherInstructor.id, NOW)
      )
    ).toBe(403);
  });
});

describe("whether a learner can raise a new Refund Request on a purchase", () => {
  it("is yes with no Refund Request, or after a decline", () => {
    const purchase = buyCourse();
    expect(canRaiseRefundRequest(purchase.id)).toBe(true);

    const request = openRequest(purchase.id);
    declineRefundRequest(request.id, admin.id, "Not enough detail.", NOW);

    expect(canRaiseRefundRequest(purchase.id)).toBe(true);
  });

  it("is no while one is Open, or once one is approved", () => {
    const purchase = buyCourse();
    const request = openRequest(purchase.id);
    expect(canRaiseRefundRequest(purchase.id)).toBe(false);

    approveRefundRequest(request.id, admin.id, 7900, null, NOW);

    expect(canRaiseRefundRequest(purchase.id)).toBe(false);
  });
});
