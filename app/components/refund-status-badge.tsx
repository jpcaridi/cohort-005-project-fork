import { RefundRequestStatus, RefundStatus } from "~/db/schema";
import { cn } from "~/lib/utils";

const TONES = {
  amber:
    "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
  red: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
  green:
    "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
  blue: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
  muted: "bg-muted text-muted-foreground",
} as const;

function Pill({
  tone,
  children,
}: {
  tone: keyof typeof TONES;
  children: React.ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-full px-2.5 py-0.5 text-xs font-medium",
        TONES[tone]
      )}
    >
      {children}
    </span>
  );
}

/** The decision on a Refund Request, and the state of its Refund if approved. */
export function RefundStatusBadges({
  status,
  refundStatus,
  isOverdue,
}: {
  status: RefundRequestStatus;
  refundStatus: RefundStatus | null;
  isOverdue: boolean;
}) {
  return (
    <span className="inline-flex flex-wrap gap-1.5">
      {status === RefundRequestStatus.Open && <Pill tone="amber">Open</Pill>}
      {isOverdue && <Pill tone="red">Overdue</Pill>}
      {status === RefundRequestStatus.Declined && (
        <Pill tone="muted">Declined</Pill>
      )}
      {status === RefundRequestStatus.Approved && (
        <Pill tone="blue">Approved</Pill>
      )}
      {refundStatus === RefundStatus.Pending && (
        <Pill tone="amber">Refund pending</Pill>
      )}
      {refundStatus === RefundStatus.Issued && (
        <Pill tone="green">Refund issued</Pill>
      )}
      {refundStatus === RefundStatus.Failed && (
        <Pill tone="red">Refund failed</Pill>
      )}
    </span>
  );
}
