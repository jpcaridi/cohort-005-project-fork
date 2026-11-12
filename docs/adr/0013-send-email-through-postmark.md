# Send transactional email through Postmark, and write to `.outbox/` without a token

Cadence sends its emails, such as Refund Request confirmations and decisions, through Postmark's HTTP API whenever `POSTMARK_SERVER_TOKEN` is set. Without a token, in local development and tests, `sendEmail` writes each message to `.outbox/` as a JSON file instead, so it can be read without anything being sent.

## Considered Options

- **Run our own SMTP server.** Rejected: we would have to run SPF, DKIM and a sender reputation ourselves.
- **Write emails to the server log until we pick a provider.** Rejected: no Student ever received the email, so promises like "we will email you again when it is done" could not be kept.
