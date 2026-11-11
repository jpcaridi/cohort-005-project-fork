import { useFetcher } from "react-router";
import { data, isRouteErrorResponse, Link } from "react-router";
import { z } from "zod";
import type { Route } from "./+types/refund-requests.$refundRequestId";
import { getCurrentUserId } from "~/lib/session";
import {
  badRequestMessage,
  parseFormData,
  parseParams,
} from "~/lib/validation";
import {
  approveRefundRequest,
  declineRefundRequest,
  getRefundRequestFacts,
  logRefundEmail,
  markRefundFailed,
  markRefundIssued,
  type RefundEmail,
} from "~/lib/refund-requests.server";
import { RefundRequestStatus, RefundStatus } from "~/db/schema";
import { Card, CardContent, CardHeader } from "~/components/ui/card";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Textarea } from "~/components/ui/textarea";
import { RefundStatusBadges } from "~/components/refund-status-badge";
import { formatPrice } from "~/lib/utils";
import { AlertTriangle, ArrowLeft } from "lucide-react";

const paramsSchema = z.object({
  refundRequestId: z.coerce.number().int().positive(),
});

const dollarsToCents = z.coerce
  .number({ invalid_type_error: "Enter an amount in dollars." })
  .transform((dollars) => Math.round(dollars * 100));

const actionSchema = z.discriminatedUnion("intent", [
  z.object({
    intent: z.literal("approve"),
    amount: dollarsToCents,
    reason: z.string().max(1000).optional().default(""),
  }),
  z.object({
    intent: z.literal("decline"),
    reason: z.string().trim().min(1, "Say why the Refund Request is declined."),
  }),
  z.object({ intent: z.literal("issued") }),
  z.object({
    intent: z.literal("failed"),
    reason: z.string().max(1000).optional().default(""),
  }),
]);

export function meta() {
  return [{ title: "Refund Request — Cadence" }];
}

async function requireSignedIn(request: Request) {
  const currentUserId = await getCurrentUserId(request);
  if (!currentUserId) {
    throw data("Select a user from the DevUI panel.", { status: 401 });
  }
  return currentUserId;
}

export async function loader({ params, request }: Route.LoaderArgs) {
  const currentUserId = await requireSignedIn(request);
  const { refundRequestId } = parseParams(params, paramsSchema);
  return getRefundRequestFacts(refundRequestId, currentUserId, new Date());
}

export async function action({ params, request }: Route.ActionArgs) {
  const currentUserId = await requireSignedIn(request);
  const { refundRequestId } = parseParams(params, paramsSchema);
  const parsed = parseFormData(await request.formData(), actionSchema);

  if (!parsed.success) {
    return data({ errors: parsed.errors }, { status: 400 });
  }

  const now = new Date();
  let email: RefundEmail;
  try {
    const input = parsed.data;
    switch (input.intent) {
      case "approve":
        ({ email } = approveRefundRequest(
          refundRequestId,
          currentUserId,
          input.amount,
          input.reason,
          now
        ));
        break;
      case "decline":
        ({ email } = declineRefundRequest(
          refundRequestId,
          currentUserId,
          input.reason,
          now
        ));
        break;
      case "issued":
        ({ email } = markRefundIssued(refundRequestId, currentUserId, now));
        break;
      case "failed":
        ({ email } = markRefundFailed(
          refundRequestId,
          currentUserId,
          input.reason,
          now
        ));
        break;
    }
  } catch (error) {
    // A rule's refusal, such as a Partial Refund with no reason, is shown
    // next to the form rather than on the error page.
    const message = badRequestMessage(error);
    if (message) return data({ errors: { form: message } }, { status: 400 });
    throw error;
  }

  logRefundEmail(email);
  return { errors: {} as Record<string, string> };
}

function hours(seconds: number) {
  return (seconds / 3600).toFixed(1);
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </dt>
      <dd className="mt-1 text-sm">{children}</dd>
    </div>
  );
}

function FormError({ errors }: { errors: Record<string, string> | undefined }) {
  const messages = Object.values(errors ?? {});
  if (messages.length === 0) return null;
  return <p className="text-sm text-destructive">{messages.join(" ")}</p>;
}

function DecidePanel({ amountPaid }: { amountPaid: number }) {
  const approve = useFetcher<typeof action>();
  const decline = useFetcher<typeof action>();

  return (
    <div className="grid gap-6 md:grid-cols-2">
      <Card>
        <CardHeader>
          <h2 className="text-lg font-semibold">Approve</h2>
          <p className="text-sm text-muted-foreground">
            The learner loses access to the course straight away.
          </p>
        </CardHeader>
        <CardContent>
          <approve.Form method="post" className="space-y-4">
            <input type="hidden" name="intent" value="approve" />
            <div className="space-y-2">
              <Label htmlFor="amount">Refund amount ($)</Label>
              <Input
                id="amount"
                name="amount"
                type="number"
                step="0.01"
                min="0.01"
                max={(amountPaid / 100).toFixed(2)}
                defaultValue={(amountPaid / 100).toFixed(2)}
              />
              <p className="text-xs text-muted-foreground">
                Up to {formatPrice(amountPaid)}, the amount paid.
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="approve-reason">
                Reason (needed for a Partial Refund)
              </Label>
              <Textarea id="approve-reason" name="reason" rows={3} />
            </div>
            <FormError errors={approve.data?.errors} />
            <Button type="submit" disabled={approve.state !== "idle"}>
              Approve
            </Button>
          </approve.Form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <h2 className="text-lg font-semibold">Decline</h2>
          <p className="text-sm text-muted-foreground">
            The reason is emailed to the learner. They keep access.
          </p>
        </CardHeader>
        <CardContent>
          <decline.Form method="post" className="space-y-4">
            <input type="hidden" name="intent" value="decline" />
            <div className="space-y-2">
              <Label htmlFor="decline-reason">Reason</Label>
              <Textarea id="decline-reason" name="reason" rows={3} required />
            </div>
            <FormError errors={decline.data?.errors} />
            <Button
              type="submit"
              variant="outline"
              disabled={decline.state !== "idle"}
            >
              Decline
            </Button>
          </decline.Form>
        </CardContent>
      </Card>
    </div>
  );
}

function RefundPanel({ refundStatus }: { refundStatus: RefundStatus }) {
  const issued = useFetcher<typeof action>();
  const failed = useFetcher<typeof action>();

  return (
    <Card>
      <CardHeader>
        <h2 className="text-lg font-semibold">
          {refundStatus === RefundStatus.Failed
            ? "Retry the Refund"
            : "Send the Refund"}
        </h2>
        <p className="text-sm text-muted-foreground">
          Mark it Issued once the money has been sent, or Failed if it
          couldn't be. A Failed Refund can be retried.
        </p>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 md:flex-row md:items-end">
        <issued.Form method="post">
          <input type="hidden" name="intent" value="issued" />
          <Button type="submit" disabled={issued.state !== "idle"}>
            Mark Issued
          </Button>
        </issued.Form>
        <failed.Form method="post" className="flex flex-1 flex-col gap-2 md:flex-row md:items-end">
          <input type="hidden" name="intent" value="failed" />
          <div className="flex-1 space-y-2">
            <Label htmlFor="failure-reason">Why it failed (optional)</Label>
            <Input id="failure-reason" name="reason" />
          </div>
          <Button
            type="submit"
            variant="outline"
            disabled={failed.state !== "idle"}
          >
            Mark Failed
          </Button>
        </failed.Form>
      </CardContent>
      <CardContent>
        <FormError errors={issued.data?.errors ?? failed.data?.errors} />
      </CardContent>
    </Card>
  );
}

export default function RefundRequestPage({
  loaderData,
}: Route.ComponentProps) {
  const facts = loaderData;
  const { refundRequest } = facts;
  const isOpen = refundRequest.status === RefundRequestStatus.Open;
  const refundUnsent =
    refundRequest.refundStatus === RefundStatus.Pending ||
    refundRequest.refundStatus === RefundStatus.Failed;

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6 lg:p-8">
      <Link
        to="/refund-requests"
        className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="mr-1 size-4" />
        All Refund Requests
      </Link>

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold">{facts.learnerName}</h1>
          <p className="mt-1 text-muted-foreground">
            {facts.courseTitle} · {facts.learnerEmail}
          </p>
        </div>
        <RefundStatusBadges
          status={refundRequest.status}
          refundStatus={refundRequest.refundStatus}
          isOverdue={facts.isOverdue}
        />
      </div>

      <Card>
        <CardHeader>
          <h2 className="text-lg font-semibold">The learner's reason</h2>
          <p className="text-sm text-muted-foreground">
            Raised {new Date(refundRequest.requestedAt).toLocaleDateString()}
            {refundRequest.raisedByUserId !== null &&
              " by an Admin on the learner's behalf"}
          </p>
        </CardHeader>
        <CardContent>
          <p className="whitespace-pre-wrap">{refundRequest.reason}</p>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-6">
          <dl className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            <Fact label="Paid">
              {formatPrice(facts.amountPaid)} on{" "}
              {new Date(facts.purchasedAt).toLocaleDateString()}
            </Fact>
            <Fact label="Refund window">
              Asked on day {facts.dayOfWindowWhenRequested} of{" "}
              {facts.refundWindowDays}
            </Fact>
            <Fact label="Lessons completed">
              {facts.lessons.completed} of {facts.lessons.total} lessons
            </Fact>
            <Fact label="Hours watched">
              {hours(
                facts.watched.secondsBeforeRequest +
                  facts.watched.secondsSinceRequest
              )}{" "}
              of {hours(facts.watched.courseSeconds)} hours
              <span className="block text-xs text-muted-foreground">
                {hours(facts.watched.secondsBeforeRequest)} before the request,{" "}
                {hours(facts.watched.secondsSinceRequest)} since
              </span>
              {facts.watched.lessonsWithoutDuration > 0 && (
                <span className="block text-xs text-muted-foreground">
                  {facts.watched.lessonsWithoutDuration}{" "}
                  {facts.watched.lessonsWithoutDuration === 1
                    ? "lesson has"
                    : "lessons have"}{" "}
                  no Duration
                </span>
              )}
            </Fact>
            <Fact label="Quiz attempts">
              {facts.quizAttempts.attempts}{" "}
              {facts.quizAttempts.attempts === 1 ? "attempt" : "attempts"},{" "}
              {facts.quizAttempts.quizzesPassed} passed
            </Fact>
          </dl>
        </CardContent>
      </Card>

      {!isOpen && (
        <Card>
          <CardHeader>
            <h2 className="text-lg font-semibold">Decision</h2>
          </CardHeader>
          <CardContent className="space-y-1 text-sm">
            <p>
              {refundRequest.status === RefundRequestStatus.Approved
                ? `Approved a refund of ${formatPrice(refundRequest.amountRefunded)}`
                : "Declined"}
              {refundRequest.resolvedAt &&
                ` on ${new Date(refundRequest.resolvedAt).toLocaleDateString()}`}
              .
            </p>
            {refundRequest.decisionReason && (
              <p className="text-muted-foreground">
                Reason: {refundRequest.decisionReason}
              </p>
            )}
            {refundRequest.refundFailureReason && (
              <p className="text-muted-foreground">
                Why the Refund failed: {refundRequest.refundFailureReason}
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {facts.canDecide && isOpen && <DecidePanel amountPaid={facts.amountPaid} />}
      {facts.canDecide && refundUnsent && refundRequest.refundStatus && (
        <RefundPanel refundStatus={refundRequest.refundStatus} />
      )}
      {!facts.canDecide && isOpen && (
        <p className="text-sm text-muted-foreground">
          Only an Admin can decide this Refund Request.
        </p>
      )}

      <Card>
        <CardHeader>
          <h2 className="text-lg font-semibold">Past Refund Requests</h2>
        </CardHeader>
        <CardContent>
          {facts.pastRefundRequests.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              None. This is the learner's first.
            </p>
          ) : (
            <ul className="space-y-3">
              {facts.pastRefundRequests.map((past) => (
                <li
                  key={past.id}
                  className="flex flex-wrap items-center justify-between gap-2 text-sm"
                >
                  <Link
                    to={`/refund-requests/${past.id}`}
                    className="hover:underline"
                  >
                    {past.courseTitle} ·{" "}
                    {new Date(past.requestedAt).toLocaleDateString()}
                    {past.decisionReason && ` — ${past.decisionReason}`}
                  </Link>
                  <RefundStatusBadges
                    status={past.status}
                    refundStatus={past.refundStatus}
                    isOverdue={false}
                  />
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let title = "Something went wrong";
  let message = "An unexpected error occurred while loading this Refund Request.";

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
