// PROTOTYPE — throwaway spike for "Does Knock hold up against Cadence?" (issue #32).
// Lives on the prototype/knock-fit branch only. Never merge.
import Knock, { signUserToken } from "@knocklabs/node";

// `react-router dev` (Vite) does not put non-VITE_ .env values on process.env.
if (!process.env.KNOCK_API_KEY) {
  try {
    process.loadEnvFile(".env");
  } catch {
    // fall through to the explicit check below
  }
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`PROTOTYPE: ${name} is missing from .env`);
  return value;
}

export const knockConfig = {
  publicApiKey: requireEnv("KNOCK_PUBLIC_API_KEY"),
  feedChannelId: requireEnv("KNOCK_FEED_CHANNEL_ID"),
};

const knock = new Knock({ apiKey: requireEnv("KNOCK_API_KEY") });

// Workflow keys that must exist (and be committed) in the Knock dashboard.
export const WORKFLOWS = {
  discussionReply: "discussion-reply",
  newEnrollment: "new-enrollment",
} as const;

export type CadenceUser = { id: number; name: string; email: string };

export const knockUserId = (user: Pick<CadenceUser, "id">) => String(user.id);

/** Check 1: sign an RS256 user token for whichever user the DevUI selected. */
export function signTokenFor(user: CadenceUser) {
  return signUserToken(knockUserId(user), {
    signingKey: requireEnv("KNOCK_SIGNING_KEY"),
    expiresInSeconds: 60 * 60,
  });
}

/** Keep the Knock recipient in sync with the Cadence user (identify). */
export function identify(user: CadenceUser) {
  return knock.users.update(knockUserId(user), {
    name: user.name,
    email: user.email,
  });
}

/** Check 2: Discussion Reply → question author, triggered from the server. */
export async function triggerDiscussionReply(
  questionAuthor: CadenceUser,
  replier: CadenceUser
) {
  await identify(replier);
  return knock.workflows.trigger(WORKFLOWS.discussionReply, {
    recipients: [knockUserId(questionAuthor)],
    actor: knockUserId(replier),
    data: {
      course_title: "Prototype Course",
      lesson_title: "Prototype Lesson",
      question_excerpt: "How does the prototype work?",
      reply_excerpt: `${replier.name} replied at ${new Date().toLocaleTimeString()}`,
      url: "/prototype/knock",
    },
  });
}

/** Check 4: new Enrollment → Instructor, which should be off unless opted in. */
export async function triggerNewEnrollment(
  instructor: CadenceUser,
  student: CadenceUser
) {
  await identify(student);
  return knock.workflows.trigger(WORKFLOWS.newEnrollment, {
    recipients: [knockUserId(instructor)],
    actor: knockUserId(student),
    data: {
      course_title: "Prototype Course",
      student_name: student.name,
      url: "/prototype/knock",
    },
  });
}

/** Wipe the user's own preference set so they fall back to the defaults. */
export function resetPreferences(user: CadenceUser) {
  return knock.users.unsetPreferences(knockUserId(user), "default");
}
