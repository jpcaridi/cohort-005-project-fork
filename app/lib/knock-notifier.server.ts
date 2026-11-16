import Knock from "@knocklabs/node";
import type {
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
  refund_requested: "refund-requested",
  refund_approved: "refund-approved",
  refund_declined: "refund-declined",
  open_refund_request: "open-refund-request",
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

export function knockNotifier(secretKey: string): Notifier {
  const knock = new Knock({ apiKey: secretKey });

  return {
    async notify(notification: Notification) {
      await knock.workflows.trigger(
        WORKFLOW_KEY[notification.kind],
        {
          recipients: notification.recipients.map(knockUser),
          // No actor means Cadence itself sent it (the "C" avatar).
          actor: notification.actor ? knockUser(notification.actor) : undefined,
          // Flat values only, so Knock can filter messages by trigger data.
          data: { kind: notification.kind, ...notification.data },
        },
        { idempotencyKey: notification.idempotencyKey }
      );
    },
  };
}
