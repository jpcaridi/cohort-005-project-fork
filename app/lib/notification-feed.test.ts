import { describe, it, expect } from "vitest";
import {
  badgeLabel,
  describeNotification,
  timeAgo,
} from "~/lib/notification-feed";

describe("badgeLabel", () => {
  it("shows no badge when nothing is unseen", () => {
    expect(badgeLabel(0)).toBeNull();
  });

  it("shows the unseen count up to nine", () => {
    expect(badgeLabel(1)).toBe("1");
    expect(badgeLabel(9)).toBe("9");
  });

  it("caps the badge at 9+", () => {
    expect(badgeLabel(10)).toBe("9+");
    expect(badgeLabel(250)).toBe("9+");
  });
});

describe("timeAgo", () => {
  const now = new Date("2026-11-16T12:00:00Z");

  it("says how long ago a Notification arrived", () => {
    expect(timeAgo("2026-11-16T11:59:30Z", now)).toBe("just now");
    expect(timeAgo("2026-11-16T11:55:00Z", now)).toBe("5m");
    expect(timeAgo("2026-11-16T09:00:00Z", now)).toBe("3h");
    expect(timeAgo("2026-11-14T12:00:00Z", now)).toBe("2d");
  });
});

describe("describeNotification", () => {
  const reply = {
    kind: "discussion_reply",
    commentId: 42,
    courseTitle: "TypeScript Fundamentals",
    lessonTitle: "Narrowing",
    snippet: "Use a discriminated union here.",
    url: "/courses/ts/lessons/7#comment-42",
  };

  it("says who replied, on which lesson, with the snippet", () => {
    const row = describeNotification(reply, "Sarah Chen");
    expect(row.title).toBe("Sarah Chen replied to your comment on Narrowing");
    expect(row.snippet).toBe("“Use a discriminated union here.”");
    expect(row.icon).toBe("discussion");
  });

  it("links a Discussion Reply to the exact comment", () => {
    expect(describeNotification(reply, "Sarah Chen").href).toBe(
      "/courses/ts/lessons/7#comment-42"
    );
  });

  it("goes nowhere when the link isn't a Cadence path", () => {
    expect(
      describeNotification({ ...reply, url: "https://evil.example" }, "Sarah")
        .href
    ).toBeNull();
    expect(
      describeNotification({ ...reply, url: "//evil.example" }, "Sarah").href
    ).toBeNull();
  });

  it("says who asked a Discussion Question, linking to it", () => {
    const row = describeNotification(
      { ...reply, kind: "discussion_question", snippet: "Why not `in`?" },
      "Emma Wilson"
    );
    expect(row.title).toBe("Emma Wilson asked a question on Narrowing");
    expect(row.snippet).toBe("“Why not `in`?”");
    expect(row.icon).toBe("discussion");
    expect(row.href).toBe("/courses/ts/lessons/7#comment-42");
  });

  it("confirms a Refund Request with nowhere to go", () => {
    const row = describeNotification(
      {
        kind: "refund_requested",
        refundRequestId: 3,
        courseTitle: "TypeScript Fundamentals",
        amount: 14900,
        url: null,
      },
      null
    );
    expect(row.title).toBe(
      "We've received your $149.00 Refund Request for TypeScript Fundamentals"
    );
    expect(row.snippet).toBe("A Platform Admin will review it.");
    expect(row.icon).toBe("refund");
    expect(row.href).toBeNull();
  });

  it("tells a Platform Admin who asked for how much, and why", () => {
    const row = describeNotification(
      {
        kind: "open_refund_request",
        refundRequestId: 3,
        courseTitle: "TypeScript Fundamentals",
        amount: 14900,
        reason: "Bought the wrong course.",
        url: "/admin/refunds",
      },
      "Emma Wilson"
    );
    expect(row.title).toBe(
      "Emma Wilson requested a $149.00 refund for TypeScript Fundamentals"
    );
    expect(row.snippet).toBe("“Bought the wrong course.”");
    expect(row.icon).toBe("refund");
    expect(row.href).toBe("/admin/refunds");
  });

  const decided = {
    refundRequestId: 3,
    purchaseId: 8,
    courseTitle: "TypeScript Fundamentals",
    amount: 14900,
    url: "/settings",
  };

  it("tells the buyer their Refund Request was approved, with any note", () => {
    const withNote = describeNotification(
      {
        ...decided,
        kind: "refund_approved",
        decisionNote: "Sorry to see you go.",
      },
      "Alex Rivera"
    );
    expect(withNote.title).toBe(
      "Your $149.00 Refund Request for TypeScript Fundamentals was approved"
    );
    expect(withNote.snippet).toBe("“Sorry to see you go.”");
    expect(withNote.href).toBe("/settings");
    const withoutNote = describeNotification(
      { ...decided, kind: "refund_approved", decisionNote: null },
      "Alex Rivera"
    );
    expect(withoutNote.snippet).toBeNull();
  });

  it("tells the buyer their Refund Request was declined, and that they can ask again", () => {
    const row = describeNotification(
      {
        ...decided,
        kind: "refund_declined",
        decisionNote: "Over half watched.",
      },
      "Alex Rivera"
    );
    expect(row.title).toBe(
      "Your $149.00 Refund Request for TypeScript Fundamentals was declined"
    );
    expect(row.snippet).toBe("“Over half watched.” You can ask again.");
    expect(row.icon).toBe("refund");
  });

  it("tells a Team Admin who claimed a Seat and how many are left", () => {
    const row = describeNotification(
      {
        kind: "seat_claimed",
        seatId: 4,
        courseTitle: "TypeScript Fundamentals",
        seatsLeft: 1,
        url: "/team",
      },
      "James Park"
    );
    expect(row.title).toBe(
      "James Park claimed a Seat for TypeScript Fundamentals"
    );
    expect(row.snippet).toBe("1 Seat left");
    expect(row.icon).toBe("team");
    expect(row.href).toBe("/team");
    const many = describeNotification(
      {
        kind: "seat_claimed",
        seatId: 4,
        courseTitle: "TypeScript Fundamentals",
        seatsLeft: 3,
        url: "/team",
      },
      "James Park"
    );
    expect(many.snippet).toBe("3 Seats left");
  });

  it("tells an Instructor who enrolled", () => {
    const row = describeNotification(
      {
        kind: "enrollment",
        enrollmentId: 9,
        courseTitle: "TypeScript Fundamentals",
        url: "/instructor/1/students",
      },
      "James Park"
    );
    expect(row.title).toBe("James Park enrolled in TypeScript Fundamentals");
    expect(row.snippet).toBeNull();
    expect(row.icon).toBe("enrollment");
    expect(row.href).toBe("/instructor/1/students");
  });

  it("still renders a row for data it doesn't recognise", () => {
    const row = describeNotification({ kind: "from_the_future" }, null);
    expect(row.title).toBe("New notification");
    expect(row.snippet).toBeNull();
    expect(row.href).toBeNull();
  });
});
