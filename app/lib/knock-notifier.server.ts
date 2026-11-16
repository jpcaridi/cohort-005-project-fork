import Knock, { signUserToken } from "@knocklabs/node";
import { knockFeedConfig } from "~/lib/notifier.server";
import type {
  KnockFeedConfig,
  Notification,
  NotificationKind,
  Notifier,
  Person,
} from "~/lib/notifier.server";

// ─── Knock adapter ───
// The only code that talks to Knock. It maps Cadence's Notifications onto
// Knock workflows; each workflow carries its Knock category (see
// `.knock/workflows/`, pushed with the Knock CLI). Knock user id = Cadence
// user id. Row text is written by Cadence from `data`, not Knock templates.

const WORKFLOW_KEY: Record<NotificationKind, string> = {
  discussion_reply: "discussion-reply",
};

export function knockUserId(cadenceUserId: number): string {
  return String(cadenceUserId);
}

function knockUser(person: Person) {
  return {
    id: knockUserId(person.id),
    name: person.name,
    email: person.email,
    avatar: person.avatarUrl,
  };
}

/** How long a signed Feed token lasts. Each layout load signs a fresh one. */
const USER_TOKEN_TTL_SECONDS = 60 * 60;

export function knockNotifier(
  secretKey: string,
  options: { feed?: KnockFeedConfig | null } = {}
): Notifier {
  const knock = new Knock({ apiKey: secretKey });
  const feed = options.feed === undefined ? knockFeedConfig() : options.feed;

  return {
    async notify(notification: Notification) {
      await knock.workflows.trigger(
        WORKFLOW_KEY[notification.kind],
        {
          recipients: notification.recipients.map(knockUser),
          actor: knockUser(notification.actor),
          // Flat values only, so Knock can filter messages by trigger data.
          data: { kind: notification.kind, ...notification.data },
        },
        { idempotencyKey: notification.idempotencyKey }
      );
    },

    async signUserToken(userId: number) {
      if (!feed) return null;
      const id = knockUserId(userId);
      return {
        userId: id,
        // RS256, `sub` = the Knock user id, with an expiry.
        userToken: await signUserToken(id, {
          signingKey: feed.signingKey,
          expiresInSeconds: USER_TOKEN_TTL_SECONDS,
        }),
        publicApiKey: feed.publicApiKey,
        feedChannelId: feed.feedChannelId,
      };
    },
  };
}
