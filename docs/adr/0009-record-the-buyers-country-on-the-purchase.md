# Record the buyer's country on the purchase, at the moment of sale

A Purchasing-Power Price is only fair in the country it was given for. So every Purchase stores the country it was made from (`purchases.country`), and later checks read it from there: a Purchase made at a Purchasing-Power Price can only be taken in that country (`checkPppAccess`), and a Refund on it gives back what was paid. We could have resolved the country again on every visit instead, but then a Student's price and access would change as they travel, and nobody could say afterwards what a Purchase was sold at.

## Consequences

A Purchase made before this column existed has no country, and there is no way to recover it. A Platform Admin, and the Instructor who owns the course, are exempt from the country check.
