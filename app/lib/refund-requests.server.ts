import { data } from "react-router";
import {
  and,
  desc,
  eq,
  inArray,
  isNotNull,
  lt,
  ne,
  sql,
  type SQL,
} from "drizzle-orm";
import { db } from "~/db";
import { formatPrice } from "~/lib/utils";
import {
  coupons,
  courses,
  enrollments,
  lessonProgress,
  LessonProgressStatus,
  lessons,
  modules,
  purchases,
  quizAttempts,
  quizzes,
  refundRequests,
  RefundRequestStatus,
  RefundStatus,
  UserRole,
  users,
  videoWatchEvents,
} from "~/db/schema";

// ─── Refund Requests ───
// The rules for deciding a Refund Request and tracking its Refund. Vocabulary
// follows GLOSSARY.md; the decision and the money are kept apart per
// docs/adr/0001-refund-requests-and-refunds-are-separate.md.
//
// Uses positional parameters (project convention). `now` is passed in so the
// rules that depend on the date can be tested.

function getRefundRequest(refundRequestId: number) {
  const refundRequest = db
    .select()
    .from(refundRequests)
    .where(eq(refundRequests.id, refundRequestId))
    .get();
  if (!refundRequest) throw data("Refund Request not found.", { status: 404 });
  return refundRequest;
}

function getPurchase(purchaseId: number) {
  const purchase = db
    .select()
    .from(purchases)
    .where(eq(purchases.id, purchaseId))
    .get();
  if (!purchase) throw data("Purchase not found.", { status: 404 });
  return purchase;
}

function getOpenRefundRequest(refundRequestId: number) {
  const refundRequest = getRefundRequest(refundRequestId);
  if (refundRequest.status !== RefundRequestStatus.Open) {
    throw data("This Refund Request has already been decided.", {
      status: 409,
    });
  }
  return refundRequest;
}

function requireAdmin(userId: number) {
  const user = db.select().from(users).where(eq(users.id, userId)).get();
  if (!user || user.role !== UserRole.Admin) {
    throw data("Only an Admin can do that.", { status: 403 });
  }
  return user;
}

// A Refund is more than nothing and no more than the learner paid. A $0
// "refund" is a decline and should be done as one.
function requireRefundableAmount(amount: number, amountPaid: number) {
  if (!Number.isInteger(amount) || amount <= 0 || amount > amountPaid) {
    throw data("A refund must be more than $0 and no more than was paid.", {
      status: 400,
    });
  }
}

// ─── Emails ───
// There is no mail transport yet, so the routes log these to the server.

export type RefundEmail = { to: string; subject: string; body: string };

export function logRefundEmail(email: RefundEmail) {
  console.log(`[email] to=${email.to} subject=${email.subject}\n${email.body}`);
}

function getLearnerAndCourse(purchase: typeof purchases.$inferSelect) {
  const learner = db
    .select()
    .from(users)
    .where(eq(users.id, purchase.userId))
    .get();
  const course = db
    .select()
    .from(courses)
    .where(eq(courses.id, purchase.courseId))
    .get();
  if (!learner || !course) {
    throw data("Purchase is missing its learner or course.", { status: 500 });
  }
  return { learner, course };
}

function buildEmail(
  purchase: typeof purchases.$inferSelect,
  subject: string,
  lines: string[]
): RefundEmail {
  const { learner, course } = getLearnerAndCourse(purchase);
  return {
    to: learner.email,
    subject: `${subject} — ${course.title}`,
    body: [
      `Hi ${learner.name},`,
      "",
      ...lines.map((line) => line.replaceAll("{course}", course.title)),
      "",
      "— The Cadence team",
    ].join("\n"),
  };
}

function buildApprovedEmail(
  purchase: typeof purchases.$inferSelect,
  amount: number,
  reason: string | null
) {
  const isPartial = amount < purchase.amountPaid;
  return buildEmail(purchase, "Refund approved", [
    `We have approved your refund request for "{course}".`,
    isPartial
      ? `You will get back ${formatPrice(amount)} of the ${formatPrice(purchase.amountPaid)} you paid, because: ${reason}`
      : `You will get back ${formatPrice(amount)}, the full amount you paid.`,
    "",
    "Your access to the course has ended. We will email you again once the money has been sent.",
  ]);
}

function blankToNull(text: string | null) {
  const trimmed = text?.trim() ?? "";
  return trimmed === "" ? null : trimmed;
}

/** Checks the amount and returns the reason to record with the decision. */
function checkRefund(
  purchase: typeof purchases.$inferSelect,
  amount: number,
  reason: string | null
) {
  requireRefundableAmount(amount, purchase.amountPaid);
  const decisionReason = blankToNull(reason);
  if (amount < purchase.amountPaid && !decisionReason) {
    throw data("Say why the refund is less than was paid.", { status: 400 });
  }
  return decisionReason;
}

// Approval ends the enrollment. Progress, watch history, quiz attempts,
// comments and the rating are kept.
function endAccess(purchase: typeof purchases.$inferSelect) {
  db.delete(enrollments)
    .where(
      and(
        eq(enrollments.userId, purchase.userId),
        eq(enrollments.courseId, purchase.courseId)
      )
    )
    .run();
}

/**
 * Approves an Open Refund Request. The learner loses access straight away and
 * the Refund starts as Pending.
 */
export function approveRefundRequest(
  refundRequestId: number,
  adminId: number,
  amount: number,
  reason: string | null,
  now: Date
) {
  requireAdmin(adminId);
  const refundRequest = getOpenRefundRequest(refundRequestId);
  const purchase = getPurchase(refundRequest.purchaseId);
  const decisionReason = checkRefund(purchase, amount, reason);

  db.update(refundRequests)
    .set({
      status: RefundRequestStatus.Approved,
      resolvedAt: now.toISOString(),
      resolvedByUserId: adminId,
      decisionReason,
      amountRefunded: amount,
      refundStatus: RefundStatus.Pending,
      refundUpdatedAt: now.toISOString(),
    })
    .where(eq(refundRequests.id, refundRequestId))
    .run();

  endAccess(purchase);

  return { email: buildApprovedEmail(purchase, amount, decisionReason) };
}

/**
 * Declines an Open Refund Request. The learner keeps access and may raise a
 * new Refund Request while the refund window is open.
 */
export function declineRefundRequest(
  refundRequestId: number,
  adminId: number,
  reason: string,
  now: Date
) {
  requireAdmin(adminId);
  const refundRequest = getOpenRefundRequest(refundRequestId);
  const purchase = getPurchase(refundRequest.purchaseId);
  const decisionReason = blankToNull(reason);
  if (!decisionReason) {
    throw data("Say why the Refund Request is declined.", { status: 400 });
  }

  db.update(refundRequests)
    .set({
      status: RefundRequestStatus.Declined,
      resolvedAt: now.toISOString(),
      resolvedByUserId: adminId,
      decisionReason,
    })
    .where(eq(refundRequests.id, refundRequestId))
    .run();

  return {
    email: buildEmail(purchase, "Refund request declined", [
      `We have looked at your refund request for "{course}" and can't approve it, because: ${decisionReason}`,
      "",
      "You still have access to the course. If you think we got this wrong, reply to this email.",
    ]),
  };
}

/**
 * A new Refund Request can be raised on a purchase unless it already has one
 * that is Open or Approved. Only a Declined Refund Request leaves room for
 * another. The refund window and watch limit are checked separately.
 */
export function canRaiseRefundRequest(purchaseId: number) {
  return !db
    .select({ id: refundRequests.id })
    .from(refundRequests)
    .where(
      and(
        eq(refundRequests.purchaseId, purchaseId),
        inArray(refundRequests.status, [
          RefundRequestStatus.Open,
          RefundRequestStatus.Approved,
        ])
      )
    )
    .get();
}

/** A seat from a team licence that has been claimed belongs to the team. */
export function isClaimedTeamSeat(purchaseId: number) {
  return !!db
    .select({ id: coupons.id })
    .from(coupons)
    .where(and(eq(coupons.purchaseId, purchaseId), isNotNull(coupons.redeemedAt)))
    .get();
}

/**
 * Raises a Refund Request on a learner's behalf — for a refund agreed outside
 * the app — and approves it as it is raised. It skips the refund window and
 * the watched-hours limit, but not the one-at-a-time rule or claimed seats.
 */
export function raiseRefundRequestForLearner(
  purchaseId: number,
  adminId: number,
  learnerReason: string,
  amount: number,
  reason: string | null,
  now: Date
) {
  requireAdmin(adminId);
  const purchase = getPurchase(purchaseId);
  const requestReason = blankToNull(learnerReason);
  if (!requestReason) {
    throw data("Enter the learner's reason for the refund.", { status: 400 });
  }
  if (!canRaiseRefundRequest(purchase.id)) {
    throw data(
      "This purchase already has an Open or Approved Refund Request.",
      { status: 409 }
    );
  }
  if (isClaimedTeamSeat(purchase.id)) {
    throw data("A claimed team seat cannot be refunded.", { status: 403 });
  }
  const decisionReason = checkRefund(purchase, amount, reason);

  const raised = db
    .insert(refundRequests)
    .values({
      purchaseId: purchase.id,
      status: RefundRequestStatus.Approved,
      reason: requestReason,
      raisedByUserId: adminId,
      requestedAt: now.toISOString(),
      resolvedAt: now.toISOString(),
      resolvedByUserId: adminId,
      decisionReason,
      amountRefunded: amount,
      refundStatus: RefundStatus.Pending,
      refundUpdatedAt: now.toISOString(),
    })
    .returning()
    .get();

  endAccess(purchase);

  return {
    refundRequest: raised,
    email: buildApprovedEmail(purchase, amount, decisionReason),
  };
}

// A Refund that is Pending or Failed is still waiting for its money. Once it
// is Issued it is done.
function getUnsentRefund(refundRequestId: number) {
  const refundRequest = getRefundRequest(refundRequestId);
  if (
    refundRequest.refundStatus !== RefundStatus.Pending &&
    refundRequest.refundStatus !== RefundStatus.Failed
  ) {
    throw data("There is no unsent Refund on this Refund Request.", {
      status: 409,
    });
  }
  return refundRequest;
}

/** Confirms the money was sent — first time, or on a retry after a failure. */
export function markRefundIssued(
  refundRequestId: number,
  adminId: number,
  now: Date
) {
  requireAdmin(adminId);
  const refundRequest = getUnsentRefund(refundRequestId);
  const purchase = getPurchase(refundRequest.purchaseId);

  db.update(refundRequests)
    .set({
      refundStatus: RefundStatus.Issued,
      refundFailureReason: null,
      refundUpdatedAt: now.toISOString(),
    })
    .where(eq(refundRequests.id, refundRequestId))
    .run();

  return {
    email: buildEmail(purchase, "Refund sent", [
      `We have sent your refund of ${formatPrice(refundRequest.amountRefunded)} for "{course}".`,
      "Depending on your bank, it can take a few days to show up.",
    ]),
  };
}

/**
 * Records that the money couldn't be sent. The decision stands, so access
 * stays ended, and the Admin can retry until the Refund is Issued.
 */
export function markRefundFailed(
  refundRequestId: number,
  adminId: number,
  reason: string | null,
  now: Date
) {
  requireAdmin(adminId);
  const refundRequest = getUnsentRefund(refundRequestId);
  const purchase = getPurchase(refundRequest.purchaseId);

  db.update(refundRequests)
    .set({
      refundStatus: RefundStatus.Failed,
      refundFailureReason: blankToNull(reason),
      refundUpdatedAt: now.toISOString(),
    })
    .where(eq(refundRequests.id, refundRequestId))
    .run();

  return {
    email: buildEmail(purchase, "We couldn't send your refund", [
      `We tried to send your refund of ${formatPrice(refundRequest.amountRefunded)} for "{course}", but it didn't go through.`,
      "Reply to this email and we'll sort it out.",
    ]),
  };
}

// ─── Overdue ───

/** Admins aim to decide a Refund Request within this many calendar days. */
export const OVERDUE_AFTER_DAYS = 3;

// Counted in whole calendar days, like the refund window.
function calendarDayNumber(when: Date) {
  return Math.floor(
    Date.UTC(when.getFullYear(), when.getMonth(), when.getDate()) /
      (24 * 60 * 60 * 1000)
  );
}

export function calendarDaysBetween(fromIso: string, now: Date) {
  return calendarDayNumber(now) - calendarDayNumber(new Date(fromIso));
}

/** An Open Refund Request that has waited longer than Admins aim to take. */
export function isOverdue(
  refundRequest: { status: RefundRequestStatus; requestedAt: string },
  now: Date
) {
  return (
    refundRequest.status === RefundRequestStatus.Open &&
    calendarDaysBetween(refundRequest.requestedAt, now) > OVERDUE_AFTER_DAYS
  );
}

// ─── Viewing ───
// Admins see and act on every Refund Request. Instructors see the ones on
// their own courses, read-only. Learners don't see this view.

type Viewer = { userId: number; isAdmin: boolean };

function requireViewer(userId: number): Viewer {
  const user = db.select().from(users).where(eq(users.id, userId)).get();
  if (
    !user ||
    (user.role !== UserRole.Admin && user.role !== UserRole.Instructor)
  ) {
    throw data("Only Admins and Instructors can see Refund Requests.", {
      status: 403,
    });
  }
  return { userId: user.id, isAdmin: user.role === UserRole.Admin };
}

function selectRefundRequestRows(where: SQL | undefined) {
  return db
    .select({
      refundRequest: refundRequests,
      purchase: purchases,
      courseId: courses.id,
      courseTitle: courses.title,
      instructorId: courses.instructorId,
      learnerId: users.id,
      learnerName: users.name,
      learnerEmail: users.email,
    })
    .from(refundRequests)
    .innerJoin(purchases, eq(refundRequests.purchaseId, purchases.id))
    .innerJoin(courses, eq(purchases.courseId, courses.id))
    .innerJoin(users, eq(purchases.userId, users.id))
    .where(where)
    .orderBy(desc(refundRequests.requestedAt))
    .all();
}

/**
 * The Refund Requests the viewer may see, newest first. Overdue Refund
 * Requests and Failed Refunds are flagged as needing action.
 */
export function listRefundRequests(viewerId: number, now: Date) {
  const viewer = requireViewer(viewerId);
  const rows = selectRefundRequestRows(
    viewer.isAdmin ? undefined : eq(courses.instructorId, viewer.userId)
  );

  return rows.map((row) => {
    const overdue = isOverdue(row.refundRequest, now);
    return {
      id: row.refundRequest.id,
      learnerName: row.learnerName,
      courseTitle: row.courseTitle,
      amountPaid: row.purchase.amountPaid,
      amountRefunded: row.refundRequest.amountRefunded,
      status: row.refundRequest.status,
      refundStatus: row.refundRequest.refundStatus,
      requestedAt: row.refundRequest.requestedAt,
      raisedByAdmin: row.refundRequest.raisedByUserId !== null,
      isOverdue: overdue,
      needsAction:
        overdue || row.refundRequest.refundStatus === RefundStatus.Failed,
    };
  });
}

// ─── The decision screen ───

/** The refund window, in calendar days from the purchase. */
export const REFUND_WINDOW_DAYS = 14;

// Furthest point reached in each lesson, summed — the same measure the refund
// route uses for the watched-hours limit.
function secondsWatched(userId: number, lessonIds: number[], before?: string) {
  if (lessonIds.length === 0) return 0;
  const furthestPerLesson = db
    .select({
      furthest: sql<number>`max(${videoWatchEvents.positionSeconds})`,
    })
    .from(videoWatchEvents)
    .where(
      and(
        eq(videoWatchEvents.userId, userId),
        inArray(videoWatchEvents.lessonId, lessonIds),
        before ? lt(videoWatchEvents.createdAt, before) : undefined
      )
    )
    .groupBy(videoWatchEvents.lessonId)
    .all();
  return furthestPerLesson.reduce((total, row) => total + row.furthest, 0);
}

/**
 * Everything an Admin needs to decide a Refund Request, or to choose the
 * amount of a Partial Refund. An Instructor of the course sees the same,
 * without being able to decide.
 */
export function getRefundRequestFacts(
  refundRequestId: number,
  viewerId: number,
  now: Date
) {
  const viewer = requireViewer(viewerId);
  const [row] = selectRefundRequestRows(eq(refundRequests.id, refundRequestId));
  if (!row) throw data("Refund Request not found.", { status: 404 });
  if (!viewer.isAdmin && row.instructorId !== viewer.userId) {
    throw data("This Refund Request is on someone else's course.", {
      status: 403,
    });
  }
  const { refundRequest, purchase } = row;

  const courseLessons = db
    .select({ id: lessons.id, durationMinutes: lessons.durationMinutes })
    .from(lessons)
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .where(eq(modules.courseId, row.courseId))
    .all();
  const lessonIds = courseLessons.map((lesson) => lesson.id);

  const completed =
    lessonIds.length === 0
      ? 0
      : db
          .select({ id: lessonProgress.id })
          .from(lessonProgress)
          .where(
            and(
              eq(lessonProgress.userId, row.learnerId),
              inArray(lessonProgress.lessonId, lessonIds),
              eq(lessonProgress.status, LessonProgressStatus.Completed)
            )
          )
          .all().length;

  const secondsBeforeRequest = secondsWatched(
    row.learnerId,
    lessonIds,
    refundRequest.requestedAt
  );
  const secondsNow = secondsWatched(row.learnerId, lessonIds);

  const attempts =
    lessonIds.length === 0
      ? []
      : db
          .select({ quizId: quizAttempts.quizId, passed: quizAttempts.passed })
          .from(quizAttempts)
          .innerJoin(quizzes, eq(quizAttempts.quizId, quizzes.id))
          .where(
            and(
              eq(quizAttempts.userId, row.learnerId),
              inArray(quizzes.lessonId, lessonIds)
            )
          )
          .all();

  const pastRefundRequests = selectRefundRequestRows(
    and(
      eq(purchases.userId, row.learnerId),
      ne(refundRequests.id, refundRequest.id)
    )
  ).map((past) => ({
    id: past.refundRequest.id,
    courseTitle: past.courseTitle,
    requestedAt: past.refundRequest.requestedAt,
    status: past.refundRequest.status,
    refundStatus: past.refundRequest.refundStatus,
    amountRefunded: past.refundRequest.amountRefunded,
    decisionReason: past.refundRequest.decisionReason,
  }));

  return {
    refundRequest,
    canDecide: viewer.isAdmin,
    isOverdue: isOverdue(refundRequest, now),
    learnerName: row.learnerName,
    learnerEmail: row.learnerEmail,
    courseTitle: row.courseTitle,
    amountPaid: purchase.amountPaid,
    purchasedAt: purchase.createdAt,
    refundWindowDays: REFUND_WINDOW_DAYS,
    dayOfWindowWhenRequested: calendarDaysBetween(
      purchase.createdAt,
      new Date(refundRequest.requestedAt)
    ),
    lessons: { completed, total: courseLessons.length },
    watched: {
      secondsBeforeRequest,
      secondsSinceRequest: secondsNow - secondsBeforeRequest,
      courseSeconds: courseLessons.reduce(
        (total, lesson) => total + (lesson.durationMinutes ?? 0) * 60,
        0
      ),
      lessonsWithoutDuration: courseLessons.filter(
        (lesson) => lesson.durationMinutes === null
      ).length,
    },
    quizAttempts: {
      attempts: attempts.length,
      quizzesPassed: new Set(
        attempts.filter((attempt) => attempt.passed).map((a) => a.quizId)
      ).size,
    },
    pastRefundRequests,
  };
}
