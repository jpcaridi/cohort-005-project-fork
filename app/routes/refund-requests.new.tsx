import { Form, redirect, useActionData, useNavigation } from "react-router";
import { data, isRouteErrorResponse, Link } from "react-router";
import { z } from "zod";
import { desc, eq } from "drizzle-orm";
import type { Route } from "./+types/refund-requests.new";
import { getCurrentUserId } from "~/lib/session";
import { badRequestMessage, parseFormData } from "~/lib/validation";
import { db } from "~/db";
import { courses, purchases, UserRole, users } from "~/db/schema";
import {
  canRaiseRefundRequest,
  isClaimedTeamSeat,
  logRefundEmail,
  raiseRefundRequestForLearner,
} from "~/lib/refund-requests.server";
import { Card, CardContent, CardHeader } from "~/components/ui/card";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Textarea } from "~/components/ui/textarea";
import { formatPrice } from "~/lib/utils";
import { AlertTriangle, ArrowLeft } from "lucide-react";

const actionSchema = z.object({
  purchaseId: z.coerce.number().int().positive("Choose a purchase."),
  learnerReason: z
    .string()
    .trim()
    .min(1, "Enter the learner's reason for the refund."),
  // Blank means the full amount paid.
  amount: z
    .string()
    .trim()
    .optional()
    .transform((value) => (value ? Math.round(Number(value) * 100) : null))
    .refine((cents) => cents === null || Number.isFinite(cents), {
      message: "Enter an amount in dollars.",
    }),
  reason: z.string().max(1000).optional().default(""),
});

export function meta() {
  return [{ title: "Raise a refund — Cadence" }];
}

async function requireAdminId(request: Request) {
  const currentUserId = await getCurrentUserId(request);
  if (!currentUserId) {
    throw data("Select a user from the DevUI panel.", { status: 401 });
  }
  const user = db
    .select({ role: users.role })
    .from(users)
    .where(eq(users.id, currentUserId))
    .get();
  if (user?.role !== UserRole.Admin) {
    throw data("Only an Admin can raise a refund.", { status: 403 });
  }
  return currentUserId;
}

// Purchases an Admin could refund: no Open or Approved Refund Request, and not
// a claimed team seat.
function getRefundablePurchases() {
  return db
    .select({
      id: purchases.id,
      amountPaid: purchases.amountPaid,
      createdAt: purchases.createdAt,
      learnerName: users.name,
      learnerEmail: users.email,
      courseTitle: courses.title,
    })
    .from(purchases)
    .innerJoin(users, eq(purchases.userId, users.id))
    .innerJoin(courses, eq(purchases.courseId, courses.id))
    .orderBy(desc(purchases.createdAt))
    .all()
    .filter(
      (purchase) =>
        purchase.amountPaid > 0 &&
        canRaiseRefundRequest(purchase.id) &&
        !isClaimedTeamSeat(purchase.id)
    );
}

export async function loader({ request }: Route.LoaderArgs) {
  await requireAdminId(request);
  return { purchases: getRefundablePurchases() };
}

export async function action({ request }: Route.ActionArgs) {
  const adminId = await requireAdminId(request);
  const parsed = parseFormData(await request.formData(), actionSchema);
  if (!parsed.success) {
    return data({ errors: parsed.errors }, { status: 400 });
  }

  const purchase = db
    .select({ amountPaid: purchases.amountPaid })
    .from(purchases)
    .where(eq(purchases.id, parsed.data.purchaseId))
    .get();
  if (!purchase) throw data("Purchase not found.", { status: 404 });

  try {
    const { refundRequest, email } = raiseRefundRequestForLearner(
      parsed.data.purchaseId,
      adminId,
      parsed.data.learnerReason,
      parsed.data.amount ?? purchase.amountPaid,
      parsed.data.reason,
      new Date()
    );
    logRefundEmail(email);
    return redirect(`/refund-requests/${refundRequest.id}`);
  } catch (error) {
    const message = badRequestMessage(error);
    if (message) return data({ errors: { form: message } }, { status: 400 });
    throw error;
  }
}

export default function RaiseRefund({ loaderData }: Route.ComponentProps) {
  const { purchases } = loaderData;
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const errors: Record<string, string> = actionData?.errors ?? {};

  return (
    <div className="mx-auto max-w-2xl space-y-6 p-6 lg:p-8">
      <Link
        to="/refund-requests"
        className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="mr-1 size-4" />
        All Refund Requests
      </Link>

      <Card>
        <CardHeader>
          <h1 className="text-2xl font-bold">Raise a refund</h1>
          <p className="text-sm text-muted-foreground">
            For a refund agreed with the learner outside the app. It is
            approved as it is raised, ignoring the 14-day window and the
            watched-hours limit. The learner loses access straight away.
          </p>
        </CardHeader>
        <CardContent>
          <Form method="post" className="space-y-5">
            <div className="space-y-2">
              <Label htmlFor="purchaseId">Purchase</Label>
              <select
                id="purchaseId"
                name="purchaseId"
                required
                defaultValue=""
                className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
              >
                <option value="" disabled>
                  Choose a learner's purchase…
                </option>
                {purchases.map((purchase) => (
                  <option key={purchase.id} value={purchase.id}>
                    {purchase.learnerName} ({purchase.learnerEmail}) —{" "}
                    {purchase.courseTitle} — {formatPrice(purchase.amountPaid)}{" "}
                    on {new Date(purchase.createdAt).toLocaleDateString()}
                  </option>
                ))}
              </select>
              {errors.purchaseId && (
                <p className="text-sm text-destructive">{errors.purchaseId}</p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="learnerReason">The learner's reason</Label>
              <Textarea id="learnerReason" name="learnerReason" rows={3} />
              {errors.learnerReason && (
                <p className="text-sm text-destructive">
                  {errors.learnerReason}
                </p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="amount">Refund amount ($)</Label>
              <Input
                id="amount"
                name="amount"
                type="number"
                step="0.01"
                min="0.01"
                placeholder="Leave blank for the full amount paid"
              />
              {errors.amount && (
                <p className="text-sm text-destructive">{errors.amount}</p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="reason">Reason (needed for a Partial Refund)</Label>
              <Textarea id="reason" name="reason" rows={2} />
            </div>

            {errors.form && (
              <p className="text-sm text-destructive">{errors.form}</p>
            )}

            <Button type="submit" disabled={navigation.state !== "idle"}>
              Raise and approve
            </Button>
          </Form>
        </CardContent>
      </Card>
    </div>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let title = "Something went wrong";
  let message = "An unexpected error occurred.";

  if (isRouteErrorResponse(error)) {
    title = error.status === 403 ? "Access denied" : `Error ${error.status}`;
    message = typeof error.data === "string" ? error.data : error.statusText;
  }

  return (
    <div className="flex min-h-[50vh] items-center justify-center p-6">
      <div className="text-center">
        <AlertTriangle className="mx-auto mb-4 size-12 text-muted-foreground" />
        <h1 className="mb-2 text-2xl font-bold">{title}</h1>
        <p className="mb-6 text-muted-foreground">{message}</p>
        <Link to="/refund-requests">
          <Button>Back to Refund Requests</Button>
        </Link>
      </div>
    </div>
  );
}
