# An unknown country gets full price; no page waits on a geolocation lookup

Purchasing-Power Prices depend on the buyer's country. `resolveCountry` reads it from the `CF-IPCountry` header Cloudflare adds, and when that header is missing it returns no country and the buyer pays full price. We do not look the address up anywhere else, so no page waits on a network call to learn the country.

## Considered Options

- **Look up the first `X-Forwarded-For` address on ip-api.com.** Rejected: the course list, the purchase page and every lesson page for a Purchase made at a Purchasing-Power Price would wait on a network call. The free endpoint is plain HTTP and limited to 45 requests a minute, so under load the lookup fails and the buyer gets full price anyway.
- **Bundle a MaxMind GeoLite2 database.** Rejected: it needs a licence key, a download of tens of megabytes, and an update every month.
- **Charge full price when the country is unknown.** Chosen.

## Consequences

A Student whose request does not come through Cloudflare is charged full price, even in a country that would get a Purchasing-Power Price. That overcharges the very Students Purchasing-Power Prices are for, and we accept it in exchange for pages that never wait on a lookup.
