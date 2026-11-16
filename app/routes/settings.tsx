import { useRef, useEffect, useState } from "react";
import { useFetcher } from "react-router";
import { toast } from "sonner";
import { z } from "zod";
import type { Route } from "./+types/settings";
import { getCurrentUserId } from "~/lib/session";
import { parseFormData } from "~/lib/validation";
import { Card, CardContent, CardHeader } from "~/components/ui/card";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Textarea } from "~/components/ui/textarea";
import { Switch } from "~/components/ui/switch";
import { UserRole, RefundStatus, users } from "~/db/schema";
import { AlertTriangle } from "lucide-react";
import { data, isRouteErrorResponse, Link } from "react-router";
import { db } from "~/db";
import { eq } from "drizzle-orm";
import { formatPrice } from "~/lib/utils";
import { listRefundRequestsForBuyer } from "~/lib/refunds.server";
import { getNotifier } from "~/lib/notifier.server";
import { syncUser } from "~/lib/user-sync.server";
import {
  getNotificationSettings,
  saveNotificationSetting,
} from "~/lib/notification-settings.server";
import type { NotificationCategory } from "~/lib/notifier.server";

const NOTIFICATION_CATEGORIES = [
  "refund_request_updates",
  "open_refund_requests",
  "seat_claims",
  "enrollments",
  "discussion_questions",
  "discussion_replies",
] as const satisfies readonly NotificationCategory[];

const settingsSchema = z.discriminatedUnion("intent", [
  z.object({
    intent: z.literal("profile"),
    name: z.string().trim().min(1, "Name cannot be empty."),
    bio: z.string().trim().optional(),
  }),
  z.object({
    intent: z.literal("notification-preference"),
    category: z.enum(NOTIFICATION_CATEGORIES),
    enabled: z.enum(["true", "false"]).transform((v) => v === "true"),
  }),
]);

export function meta() {
  return [
    { title: "Settings — Cadence" },
    { name: "description", content: "Edit your profile details" },
  ];
}

export async function loader({ request }: Route.LoaderArgs) {
  const currentUserId = await getCurrentUserId(request);

  if (!currentUserId) {
    throw data("Select a user from the DevUI panel to edit your details.", {
      status: 401,
    });
  }

  const currentUser = db
    .select()
    .from(users)
    .where(eq(users.id, currentUserId))
    .get();

  if (!currentUser) {
    throw data("User not found.", { status: 404 });
  }

  const refundRequests = listRefundRequestsForBuyer(db, currentUserId);
  const notificationSettings = await getNotificationSettings(
    db,
    await getNotifier(),
    currentUserId
  );

  return {
    user: {
      id: currentUser.id,
      name: currentUser.name,
      email: currentUser.email,
      bio: currentUser.bio,
      role: currentUser.role,
    },
    refundRequests,
    notificationSettings,
  };
}

export async function action({ request }: Route.ActionArgs) {
  const currentUserId = await getCurrentUserId(request);

  if (!currentUserId) {
    throw data("You must be logged in.", { status: 401 });
  }

  const currentUser = db
    .select()
    .from(users)
    .where(eq(users.id, currentUserId))
    .get();
  if (!currentUser) {
    throw data("User not found.", { status: 404 });
  }

  const formData = await request.formData();
  const parsed = parseFormData(formData, settingsSchema);

  if (!parsed.success) {
    return data({ errors: parsed.errors }, { status: 400 });
  }

  if (parsed.data.intent === "notification-preference") {
    const { category, enabled } = parsed.data;
    const result = await saveNotificationSetting(
      db,
      await getNotifier(),
      currentUser.id,
      category,
      enabled
    );
    if (!result.ok) {
      if (result.status === 403) throw data(result.error, { status: 403 });
      return data({ preferenceError: result.error }, { status: result.status });
    }
    return { preferenceSaved: true };
  }

  const { name, bio } = parsed.data;

  const updatedUser = db
    .update(users)
    .set({ name, email: currentUser.email, bio: bio || null })
    .where(eq(users.id, currentUser.id))
    .returning()
    .get();
  if (updatedUser && updatedUser.name !== currentUser.name) {
    await syncUser(await getNotifier(), updatedUser);
  }
  return { success: true };
}

export default function Settings({ loaderData }: Route.ComponentProps) {
  const { user, refundRequests, notificationSettings } = loaderData;
  const openCount = refundRequests.filter(
    (refundRequest) => refundRequest.status === RefundStatus.Open
  ).length;
  const fetcher = useFetcher();
  const nameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.success) {
      toast.success("Profile updated successfully.");
    }
    if (fetcher.state === "idle" && fetcher.data?.errors) {
      const firstError = Object.values(fetcher.data.errors)[0] as string | undefined;
      if (firstError) toast.error(firstError);
    }
  }, [fetcher.state, fetcher.data]);

  return (
    <div className="mx-auto max-w-7xl p-6 lg:p-8">
      {/* Breadcrumb */}
      <nav className="mb-6 text-sm text-muted-foreground">
        <Link to="/" className="hover:text-foreground">
          Home
        </Link>
        <span className="mx-2">/</span>
        <span className="text-foreground">Settings</span>
      </nav>

      <div className="mb-8">
        <h1 className="text-3xl font-bold">Settings</h1>
        <p className="mt-1 text-muted-foreground">
          Update your profile details
        </p>
      </div>

      <Card className="max-w-md">
        <CardHeader>
          <h2 className="text-lg font-semibold">Profile</h2>
        </CardHeader>
        <CardContent>
          <fetcher.Form method="post" className="space-y-4">
            <input type="hidden" name="intent" value="profile" />
            <div className="space-y-2">
              <Label htmlFor="name">Name</Label>
              <Input
                ref={nameInputRef}
                id="name"
                name="name"
                type="text"
                defaultValue={user.name}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                value={user.email}
                disabled
                className="text-muted-foreground"
              />
              <p className="text-xs text-muted-foreground">
                Email cannot be changed.
              </p>
            </div>
            {user.role === UserRole.Instructor && (
              <div className="space-y-2">
                <Label htmlFor="bio">Bio</Label>
                <Textarea
                  id="bio"
                  name="bio"
                  rows={4}
                  defaultValue={user.bio ?? ""}
                  placeholder="Tell students about yourself..."
                />
                <p className="text-xs text-muted-foreground">
                  Your bio is shown on your course pages.
                </p>
              </div>
            )}
            <Button
              type="submit"
              disabled={fetcher.state !== "idle"}
            >
              {fetcher.state !== "idle" ? "Saving..." : "Save Changes"}
            </Button>
          </fetcher.Form>
        </CardContent>
      </Card>

      <Card id="notifications" className="mt-8 max-w-md scroll-mt-6">
        <CardHeader>
          <h2 className="text-lg font-semibold">Notifications</h2>
          <p className="text-sm text-muted-foreground">
            Choose what reaches your notification feed.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          {notificationSettings.map((setting) => (
            <NotificationSwitch
              key={setting.category}
              category={setting.category}
              enabled={setting.enabled}
            />
          ))}
        </CardContent>
      </Card>

      {refundRequests.length > 0 && (
        <Card className="mt-8 max-w-md">
          <CardHeader>
            <h2 className="text-lg font-semibold">Refund Requests</h2>
            {openCount > 0 && (
              <p className="text-sm text-muted-foreground">
                {openCount === 1
                  ? "One refund request is waiting on us."
                  : `${openCount} refund requests are waiting on us.`}
              </p>
            )}
          </CardHeader>
          <CardContent className="space-y-4">
            {refundRequests.map((refundRequest) => (
              <div key={refundRequest.id} className="rounded-md border p-3">
                <div className="flex items-start justify-between gap-3">
                  <Link
                    to={`/courses/${refundRequest.courseSlug}`}
                    className="font-medium hover:underline"
                  >
                    {refundRequest.courseTitle}
                  </Link>
                  <RefundStatusBadge status={refundRequest.status} />
                </div>
                <p className="mt-1 text-sm text-muted-foreground">
                  {formatPrice(refundRequest.amountPaid)} · raised{" "}
                  {new Date(refundRequest.requestedAt).toLocaleDateString()}
                  {refundRequest.resolvedAt && (
                    <>
                      {" "}
                      · decided{" "}
                      {new Date(refundRequest.resolvedAt).toLocaleDateString()}
                    </>
                  )}
                </p>
                <p className="mt-2 text-sm">{refundRequest.reason}</p>
                {refundRequest.decisionNote && (
                  <p className="mt-2 rounded-md bg-muted p-2 text-sm">
                    <span className="font-medium">Our note: </span>
                    {refundRequest.decisionNote}
                  </p>
                )}
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

const NOTIFICATION_COPY: Record<
  NotificationCategory,
  { label: string; description: string }
> = {
  refund_request_updates: {
    label: "Refund Request updates",
    description: "When a refund request you raised is received or decided.",
  },
  open_refund_requests: {
    label: "Open Refund Requests",
    description: "When a buyer raises a refund request for review.",
  },
  seat_claims: {
    label: "Seat claims",
    description: "When a student claims a seat on your team licence.",
  },
  enrollments: {
    label: "Enrollments",
    description: "When a student enrolls on a course you teach.",
  },
  discussion_questions: {
    label: "Discussion Questions",
    description: "When someone asks a question on one of your lessons.",
  },
  discussion_replies: {
    label: "Discussion Replies",
    description: "When someone replies to your comment.",
  },
};

/** One preference switch. Saves on flip, optimistically; reverts on failure. */
function NotificationSwitch({
  category,
  enabled,
}: {
  category: NotificationCategory;
  enabled: boolean;
}) {
  const fetcher = useFetcher<typeof action>();
  const [checked, setChecked] = useState(enabled);
  const id = `notification-${category}`;
  const copy = NOTIFICATION_COPY[category];

  const stored = useRef(enabled);

  // Follow the stored value when the loader revalidates.
  useEffect(() => {
    stored.current = enabled;
    setChecked(enabled);
  }, [enabled]);

  useEffect(() => {
    if (
      fetcher.state === "idle" &&
      fetcher.data &&
      "preferenceError" in fetcher.data
    ) {
      toast.error(fetcher.data.preferenceError);
      setChecked(stored.current);
    }
  }, [fetcher.state, fetcher.data]);

  return (
    <div className="flex items-start justify-between gap-4">
      <div className="space-y-1">
        <Label htmlFor={id}>{copy.label}</Label>
        <p className="text-xs text-muted-foreground">{copy.description}</p>
      </div>
      <Switch
        id={id}
        checked={checked}
        onCheckedChange={(next) => {
          setChecked(next);
          fetcher.submit(
            {
              intent: "notification-preference",
              category,
              enabled: String(next),
            },
            { method: "post" }
          );
        }}
      />
    </div>
  );
}

const REFUND_STATUS_BADGES: Record<
  RefundStatus,
  { label: string; className: string }
> = {
  [RefundStatus.Open]: {
    label: "Open",
    className:
      "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
  },
  [RefundStatus.Approved]: {
    label: "Approved",
    className:
      "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
  },
  [RefundStatus.Declined]: {
    label: "Declined",
    className: "bg-muted text-muted-foreground",
  },
};

function RefundStatusBadge({ status }: { status: RefundStatus }) {
  const badge = REFUND_STATUS_BADGES[status];
  return (
    <span
      className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium ${badge.className}`}
    >
      {badge.label}
    </span>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let title = "Something went wrong";
  let message = "An unexpected error occurred.";

  if (isRouteErrorResponse(error)) {
    if (error.status === 401) {
      title = "Sign in required";
      message =
        typeof error.data === "string"
          ? error.data
          : "Please select a user from the DevUI panel.";
    } else if (error.status === 404) {
      title = "User not found";
      message =
        typeof error.data === "string" ? error.data : "User not found.";
    } else {
      title = `Error ${error.status}`;
      message =
        typeof error.data === "string" ? error.data : error.statusText;
    }
  }

  return (
    <div className="flex min-h-[50vh] items-center justify-center p-6">
      <div className="text-center">
        <AlertTriangle className="mx-auto mb-4 size-12 text-muted-foreground" />
        <h1 className="mb-2 text-2xl font-bold">{title}</h1>
        <p className="mb-6 text-muted-foreground">{message}</p>
        <div className="flex items-center justify-center gap-3">
          <Link to="/">
            <Button>Go Home</Button>
          </Link>
        </div>
      </div>
    </div>
  );
}
