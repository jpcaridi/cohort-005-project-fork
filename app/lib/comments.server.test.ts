import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";
import { UserRole } from "~/db/schema";
import { createComment, deleteComment, updateComment } from "./comments.server";
import {
  createFakeNotifier,
  type FakeNotifier,
  type Notifier,
} from "./notifier.server";

type TestDb = ReturnType<typeof createTestDb>;

const NOW = new Date(2026, 9, 6, 12, 0, 0);
const LATER = new Date(2026, 9, 7, 9, 30, 0);

let db: TestDb;
let base: ReturnType<typeof seedBaseData>;
let lesson: typeof schema.lessons.$inferSelect;
let otherLesson: typeof schema.lessons.$inferSelect;
let student: typeof schema.users.$inferSelect;
let platformAdmin: typeof schema.users.$inferSelect;
let notifier: FakeNotifier;

beforeEach(() => {
  db = createTestDb();
  notifier = createFakeNotifier();
  base = seedBaseData(db);
  student = base.user;
  platformAdmin = db
    .insert(schema.users)
    .values({ name: "Pat Admin", email: "pat@example.com", role: UserRole.Admin })
    .returning()
    .get();

  const module = db
    .insert(schema.modules)
    .values({ courseId: base.course.id, title: "Basics", position: 1 })
    .returning()
    .get();
  lesson = db
    .insert(schema.lessons)
    .values({ moduleId: module.id, title: "Hello", position: 1 })
    .returning()
    .get();
  otherLesson = db
    .insert(schema.lessons)
    .values({ moduleId: module.id, title: "Goodbye", position: 2 })
    .returning()
    .get();
});

const failing: Notifier = {
  ...createFakeNotifier(),
  async notify() {
    throw new Error("Knock is down");
  },
  async archiveByComment() {
    throw new Error("Knock is down");
  },
};

function ask(authorId: number, body = "How does this work?") {
  return createComment(db, notifier, authorId, lesson.id, null, body, NOW);
}

describe("createComment", () => {
  it("makes a Student's top-level comment a Discussion Question, naming the course's Instructor", async () => {
    const created = await ask(student.id, "  How does this work?  ");

    expect(created).toMatchObject({
      kind: "discussion_question",
      comment: {
        userId: student.id,
        lessonId: lesson.id,
        parentId: null,
        body: "How does this work?",
        createdAt: NOW.toISOString(),
      },
      questionAuthorId: student.id,
      course: { id: base.course.id, instructorId: base.instructor.id },
      lesson: { id: lesson.id, title: "Hello" },
    });
  });

  it("makes a Platform Admin's top-level comment a Discussion Question", async () => {
    expect((await ask(platformAdmin.id)).kind).toBe("discussion_question");
  });

  it("doesn't make the Instructor's own top-level comment a Discussion Question", async () => {
    expect((await ask(base.instructor.id)).kind).toBe("instructor_comment");
  });

  it("makes an answer a Discussion Reply, naming the question's author", async () => {
    const question = (await ask(student.id)).comment;

    const created = await createComment(
      db,
      notifier,
      base.instructor.id,
      lesson.id,
      question.id,
      "Like this.",
      NOW
    );

    expect(created).toMatchObject({
      kind: "discussion_reply",
      comment: { parentId: question.id, userId: base.instructor.id },
      questionAuthorId: student.id,
      course: { instructorId: base.instructor.id },
    });
  });

  it("refuses an empty comment", async () => {
    await expect(ask(student.id, "   ")).rejects.toThrow("Comment cannot be empty");
  });

  it("refuses a comment that is too long", async () => {
    await expect(ask(student.id, "x".repeat(5001))).rejects.toThrow(
      "Comment must be 5000 characters or fewer"
    );
  });

  it("refuses a lesson that doesn't exist", async () => {
    await expect(
      createComment(db, notifier, student.id, 9999, null, "Hi", NOW)
    ).rejects.toThrow("Lesson not found");
  });

  it("refuses a reply to a reply", async () => {
    const question = (await ask(student.id)).comment;
    const reply = (await createComment(
      db,
      notifier,
      base.instructor.id,
      lesson.id,
      question.id,
      "Like this.",
      NOW
    )).comment;

    await expect(
      createComment(db, notifier, student.id, lesson.id, reply.id, "Thanks", NOW)
    ).rejects.toThrow("Replies can only be one level deep");
  });

  it("refuses a reply to a comment on a different lesson", async () => {
    const question = (await ask(student.id)).comment;

    await expect(
      createComment(db, notifier, student.id, otherLesson.id, question.id, "Hm", NOW)
    ).rejects.toThrow("Parent comment belongs to a different lesson");
  });

  it("refuses a reply to a comment that doesn't exist", async () => {
    await expect(
      createComment(db, notifier, student.id, lesson.id, 9999, "Hm", NOW)
    ).rejects.toThrow("Parent comment not found");
  });
});

function reply(authorId: number, questionId: number, body = "Like this.") {
  return createComment(db, notifier, authorId, lesson.id, questionId, body, NOW);
}

function replyNotifications() {
  return notifier.notifications.filter((n) => n.kind === "discussion_reply");
}

describe("Discussion Reply Notifications", () => {
  it("tells the Discussion Question's author when someone else replies", async () => {
    const question = (await ask(student.id)).comment;

    const answer = (await reply(base.instructor.id, question.id, "Like this.")).comment;

    expect(replyNotifications()).toEqual([
      {
        kind: "discussion_reply",
        recipients: [
          {
            id: student.id,
            name: "Test User",
            email: "test@example.com",
            avatarUrl: null,
          },
        ],
        actor: {
          id: base.instructor.id,
          name: "Test Instructor",
          email: "instructor@example.com",
          avatarUrl: null,
        },
        idempotencyKey: `comment:${answer.id}`,
        data: {
          commentId: answer.id,
          courseTitle: base.course.title,
          lessonTitle: "Hello",
          snippet: "Like this.",
          url: `/courses/${base.course.slug}/lessons/${lesson.id}#comment-${answer.id}`,
        },
      },
    ]);
  });

  it("tells nobody when the author replies in their own thread", async () => {
    const question = (await ask(student.id)).comment;

    await reply(student.id, question.id, "Never mind, got it.");

    expect(replyNotifications()).toEqual([]);
  });

  it("tells the Instructor when someone replies to the Instructor's own top-level comment", async () => {
    const note = (await ask(base.instructor.id, "Read chapter 2 first.")).comment;

    await reply(student.id, note.id, "Will do!");

    expect(replyNotifications()).toMatchObject([
      {
        kind: "discussion_reply",
        recipients: [{ id: base.instructor.id }],
        actor: { id: student.id },
      },
    ]);
  });

  it("tells nobody about a reply under a deleted comment", async () => {
    const question = (await ask(student.id)).comment;
    await deleteComment(db, notifier, question.id, student.id, false, NOW);

    const answer = await reply(base.instructor.id, question.id, "Here's how.");

    expect(answer.kind).toBe("discussion_reply");
    expect(notifier.notifications).toMatchObject([
      { kind: "discussion_question" },
    ]);
  });

  it("sends no Reply Notification for a top-level comment", async () => {
    await ask(student.id);
    await ask(base.instructor.id);

    expect(replyNotifications()).toEqual([]);
  });

  it("quotes only the start of a long reply", async () => {
    const question = (await ask(student.id)).comment;

    await reply(platformAdmin.id, question.id, `Start\n\n${"word ".repeat(100)}`);

    const [sent] = replyNotifications();
    expect(sent.data.snippet).toMatch(/^Start word word /);
    expect(sent.data.snippet.length).toBeLessThanOrEqual(140);
    expect(sent.data.snippet.endsWith("…")).toBe(true);
  });

  it("still posts the reply, and logs, when the Notifier fails", async () => {
    const question = (await ask(student.id)).comment;
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

    const created = await createComment(
      db,
      failing,
      base.instructor.id,
      lesson.id,
      question.id,
      "Like this.",
      NOW
    );

    expect(created.comment).toMatchObject({
      parentId: question.id,
      body: "Like this.",
    });
    expect(errorLog).toHaveBeenCalledWith(
      expect.stringContaining(`comment:${created.comment.id}`),
      expect.any(Error)
    );
    errorLog.mockRestore();
  });
});

describe("Discussion Question Notifications", () => {
  it("tells the course's Instructor when a Student asks a Discussion Question", async () => {
    const question = (await ask(student.id, "How does this work?")).comment;

    expect(notifier.notifications).toEqual([
      {
        kind: "discussion_question",
        recipients: [
          {
            id: base.instructor.id,
            name: "Test Instructor",
            email: "instructor@example.com",
            avatarUrl: null,
          },
        ],
        actor: {
          id: student.id,
          name: "Test User",
          email: "test@example.com",
          avatarUrl: null,
        },
        idempotencyKey: `comment:${question.id}`,
        data: {
          commentId: question.id,
          courseTitle: base.course.title,
          lessonTitle: "Hello",
          snippet: "How does this work?",
          url: `/courses/${base.course.slug}/lessons/${lesson.id}#comment-${question.id}`,
        },
      },
    ]);
  });

  it("tells the course's Instructor when a Platform Admin asks", async () => {
    await ask(platformAdmin.id);

    expect(notifier.notifications).toMatchObject([
      {
        kind: "discussion_question",
        recipients: [{ id: base.instructor.id }],
        actor: { id: platformAdmin.id },
      },
    ]);
  });

  it("tells nobody about the Instructor's own top-level comment", async () => {
    await ask(base.instructor.id, "Read chapter 2 first.");

    expect(notifier.notifications).toEqual([]);
  });

  it("still posts the question, and logs, when the Notifier fails", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

    const created = await createComment(
      db,
      failing,
      student.id,
      lesson.id,
      null,
      "How does this work?",
      NOW
    );

    expect(created.comment).toMatchObject({ body: "How does this work?" });
    expect(errorLog).toHaveBeenCalledWith(
      expect.stringContaining(`comment:${created.comment.id}`),
      expect.any(Error)
    );
    errorLog.mockRestore();
  });
});

describe("updateComment", () => {
  it("changes the author's own comment and marks it edited", async () => {
    const question = (await ask(student.id)).comment;

    const updated = updateComment(db, question.id, student.id, " Better ", LATER);

    expect(updated).toMatchObject({
      body: "Better",
      editedAt: LATER.toISOString(),
    });
  });

  it("refuses someone else's comment", async () => {
    const question = (await ask(student.id)).comment;

    expect(() =>
      updateComment(db, question.id, base.instructor.id, "Mine now", LATER)
    ).toThrow("You can only edit your own comments");
  });
});

function remove(
  commentId: number,
  userId: number,
  isStaff = false,
  now = LATER
) {
  return deleteComment(db, notifier, commentId, userId, isStaff, now);
}

describe("Notifications of deleted comments", () => {
  it("archives a deleted Discussion Question's Notification", async () => {
    const question = (await ask(student.id)).comment;

    await remove(question.id, student.id);

    expect(notifier.archivedCommentIds).toEqual([question.id]);
  });

  it("archives a deleted Discussion Reply's Notification", async () => {
    const question = (await ask(student.id)).comment;
    const answer = (await reply(base.instructor.id, question.id)).comment;

    await remove(answer.id, base.instructor.id);

    expect(notifier.archivedCommentIds).toEqual([answer.id]);
  });

  it("leaves the Reply Notifications under a deleted Discussion Question", async () => {
    const question = (await ask(student.id)).comment;
    await reply(base.instructor.id, question.id);

    await remove(question.id, base.instructor.id, true);

    expect(notifier.archivedCommentIds).toEqual([question.id]);
  });

  it("archives nothing more when a comment is deleted again", async () => {
    const question = (await ask(student.id)).comment;
    await remove(question.id, student.id, false, NOW);

    await remove(question.id, student.id);

    expect(notifier.archivedCommentIds).toEqual([question.id]);
  });

  it("archives nothing when the deletion is refused", async () => {
    const question = (await ask(student.id)).comment;

    await expect(remove(question.id, platformAdmin.id)).rejects.toThrow();

    expect(notifier.archivedCommentIds).toEqual([]);
  });

  it("still deletes the comment, and logs, when archiving fails", async () => {
    const question = (await ask(student.id)).comment;
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

    const deleted = await deleteComment(
      db,
      failing,
      question.id,
      student.id,
      false,
      LATER
    );

    expect(deleted.deletedAt).toBe(LATER.toISOString());
    expect(errorLog).toHaveBeenCalledWith(
      expect.stringContaining(`comment:${question.id}`),
      expect.any(Error)
    );
    errorLog.mockRestore();
  });
});

describe("deleteComment", () => {
  it("soft-deletes the author's own comment", async () => {
    const question = (await ask(student.id)).comment;

    const deleted = await remove(question.id, student.id);

    expect(deleted).toMatchObject({
      id: question.id,
      body: "How does this work?",
      deletedAt: LATER.toISOString(),
    });
  });

  it("lets staff delete someone else's comment", async () => {
    const question = (await ask(student.id)).comment;

    const deleted = await remove(question.id, platformAdmin.id, true);

    expect(deleted.deletedAt).toBe(LATER.toISOString());
  });

  it("refuses someone else's comment when not staff", async () => {
    const question = (await ask(student.id)).comment;
    const other = db
      .insert(schema.users)
      .values({ name: "Sam", email: "sam@example.com", role: UserRole.Student })
      .returning()
      .get();

    await expect(remove(question.id, other.id)).rejects.toThrow(
      "You can only delete your own comments"
    );
  });

  it("keeps the first deletion time when deleted twice", async () => {
    const question = (await ask(student.id)).comment;
    await remove(question.id, student.id, false, NOW);

    const again = await remove(question.id, student.id);

    expect(again.deletedAt).toBe(NOW.toISOString());
  });

  it("refuses to edit a deleted comment", async () => {
    const question = (await ask(student.id)).comment;
    await remove(question.id, student.id, false, NOW);

    expect(() =>
      updateComment(db, question.id, student.id, "Back", LATER)
    ).toThrow("Comment has been deleted");
  });
});
