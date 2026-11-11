import { data, isRouteErrorResponse, Link } from "react-router";
import type { Route } from "./+types/refund-requests";
import { getCurrentUserId } from "~/lib/session";
import { listRefundRequests } from "~/lib/refund-requests.server";
import { Card, CardContent } from "~/components/ui/card";
import { Button } from "~/components/ui/button";
import { RefundStatusBadges } from "~/components/refund-status-badge";
import { formatPrice } from "~/lib/utils";
import { UserRole } from "~/db/schema";
import { db } from "~/db";
import { users } from "~/db/schema";
import { eq } from "drizzle-orm";
import { AlertTriangle, Plus, Receipt } from "lucide-react";

export function meta() {
  return [{ title: "Refund Requests — Cadence" }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const currentUserId = await getCurrentUserId(request);
  if (!currentUserId) {
    throw data("Select a user from the DevUI panel.", { status: 401 });
  }

  const viewer = db
    .select({ role: users.role })
    .from(users)
    .where(eq(users.id, currentUserId))
    .get();

  const rows = listRefundRequests(currentUserId, new Date());

  return {
    isAdmin: viewer?.role === UserRole.Admin,
    needsAction: rows.filter((row) => row.needsAction),
    others: rows.filter((row) => !row.needsAction),
  };
}

type Row = Awaited<ReturnType<typeof loader>>["others"][number];

function RefundRequestTable({ rows }: { rows: Row[] }) {
  return (
    <Card>
      <CardContent className="p-0">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/50 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">
                <th className="px-4 py-3">Learner</th>
                <th className="px-4 py-3">Course</th>
                <th className="px-4 py-3">Paid</th>
                <th className="px-4 py-3">Raised</th>
                <th className="px-4 py-3">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={row.id}
                  className="border-b border-border last:border-0 hover:bg-muted/30"
                >
                  <td className="px-4 py-3">
                    <Link
                      to={`/refund-requests/${row.id}`}
                      className="font-medium hover:underline"
                    >
                      {row.learnerName}
                    </Link>
                  </td>
                  <td className="px-4 py-3">{row.courseTitle}</td>
                  <td className="px-4 py-3">{formatPrice(row.amountPaid)}</td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {new Date(row.requestedAt).toLocaleDateString()}
                    {row.raisedByAdmin && " · by an Admin"}
                  </td>
                  <td className="px-4 py-3">
                    <RefundStatusBadges
                      status={row.status}
                      refundStatus={row.refundStatus}
                      isOverdue={row.isOverdue}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}

export default function RefundRequests({ loaderData }: Route.ComponentProps) {
  const { isAdmin, needsAction, others } = loaderData;

  return (
    <div className="mx-auto max-w-5xl p-6 lg:p-8">
      <div className="mb-8 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold">Refund Requests</h1>
          <p className="mt-1 text-muted-foreground">
            {isAdmin
              ? "Decide Refund Requests and track their Refunds."
              : "Refund Requests on your courses. Only an Admin can decide them."}
          </p>
        </div>
        {isAdmin && (
          <Link to="/refund-requests/new">
            <Button size="sm">
              <Plus className="mr-1.5 size-3.5" />
              Raise a refund
            </Button>
          </Link>
        )}
      </div>

      {needsAction.length === 0 && others.length === 0 && (
        <Card>
          <CardContent className="py-8 text-center">
            <Receipt className="mx-auto mb-3 size-8 text-muted-foreground/50" />
            <p className="text-muted-foreground">No Refund Requests yet.</p>
          </CardContent>
        </Card>
      )}

      {needsAction.length > 0 && (
        <section className="mb-8">
          <h2 className="mb-3 text-lg font-semibold">Needs action</h2>
          <p className="mb-3 text-sm text-muted-foreground">
            Open Refund Requests waiting more than 3 days, and Refunds that
            failed to send.
          </p>
          <RefundRequestTable rows={needsAction} />
        </section>
      )}

      {others.length > 0 && (
        <section>
          <h2 className="mb-3 text-lg font-semibold">All other requests</h2>
          <RefundRequestTable rows={others} />
        </section>
      )}
    </div>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let title = "Something went wrong";
  let message = "An unexpected error occurred while loading Refund Requests.";

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
        <Link to="/">
          <Button>Go Home</Button>
        </Link>
      </div>
    </div>
  );
}
