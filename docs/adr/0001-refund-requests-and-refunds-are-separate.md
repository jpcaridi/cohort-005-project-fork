# Refund Requests and Refunds are separate, and every Refund has a Refund Request

An Admin's decision on a Refund Request (Open, Approved, Declined) and what happens to the money (Pending, Issued, Failed) are tracked separately. The decision is final once made, but sending the money can fail and be retried. Mixing the two would mean a Failed Refund looks like the decision was undone. Every Refund also comes from an Approved Refund Request, even when an Admin agrees a refund with a learner outside the app (for example by email, after the 14-day window has closed). In that case the Admin raises the Refund Request on the learner's behalf, with the learner's reason, and it is approved as it is raised. Every refund then has one audit trail and one place it is reported from, and no screen has to handle a Refund with no request behind it.

## Considered Options

- **One status for both the decision and the money.** Rejected: a Failed Refund would have to sit alongside Approved and Declined, and a retry would look like the decision being reopened.
- **Let Admins create a Refund with no Refund Request.** Rejected: there would be two kinds of Refund, one with a reason and history and one without, and every report and screen would have to handle both.

## Consequences

- Someone adding an "issue a refund" action has to create an approved Refund Request first. That is deliberate, not ceremony.
- A Refund Request raised by an Admin skips the 14-day window and the watched-hours limit. It still can't be raised while another request on the purchase is Open, or for a claimed team seat.
