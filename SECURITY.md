# Security

## Reporting a vulnerability

Report it **privately**, through GitHub: the repository's **Security** tab →
**Report a vulnerability**
(<https://github.com/joshidikshant/loopback/security/advisories/new>). That opens
a draft GitHub Security Advisory visible only to you and the maintainer, and it
is the only private channel — there is no security mailing address to write to.

Please do not open a public issue for something exploitable. If the Security tab
shows no report button, open an issue that says *only* that you have a security
report and nothing else, and it will be moved to a private advisory.

Loopback is solo-maintained. Expect one human on their own schedule, not a
triage rota or an SLA.

## Supported versions

| Version | Supported |
|---|---|
| the latest version published to npm | yes |
| anything older | no — upgrade |

There is no backport branch and no LTS line. A fix lands on `main`, CI has to be
green on that exact commit before it can be published (see
[CONTRIBUTING.md](CONTRIBUTING.md#publishing)), and it ships as a new release.
`npm view loopback-mcp-server version` is the authority on what "latest" is.

## The security model

Loopback is a local development tool. The whole model follows from one thing
that is easy to get wrong: **the trust boundary is not "localhost"** — a
loopback port is reachable from every page open in your browser.

**Bound to `127.0.0.1:7077` by default**, and there is no token on a loopback
bind: it would protect nothing the OS does not already protect, and every local
MCP client, script and browser tab would have to carry it (`src/index.ts`).

**Trusted origins are pinned at startup from the bind config**, never derived
from the request's `Host` header (`trustedOrigins()` in `src/http.ts`). `Host`
is attacker-influenced: a domain that resolves to 127.0.0.1 (DNS rebinding)
arrives with `Host` *and* `Origin` both set to that domain, so a "does Origin
equal my own Host" test passes for a site that is not us.

**Everything that reads full context or changes state requires a trusted
origin** and answers 403 otherwise (`requireTrustedOrigin()` in `src/http.ts`):
the triage writes `POST /queue/:id/comment` and `POST /queue/:id/status`, full
item reads, blob reads, attachment deletes, and `POST /mcp` — which exposes
every tool, so leaving it open would let any page in the operator's browser read
every project's queue and silently resolve items. Local tooling that sends no
`Origin` (curl, MCP clients) still works.

**Cross-origin reads get the pin projection only** (`pinProjection()` in
`src/http.ts`, applied to every untrusted-origin read of `GET /feedback`): id,
project, route, title, type, severity, status, assignee, selector, PR link,
timestamps. `extra` — captured response bodies, which routinely contain auth
headers — is never served cross-origin.

**A non-loopback bind is opt-in and requires a bearer token.** `--host` /
`LOOPBACK_HOST` widening the bind makes the server generate a token, or take
`LOOPBACK_TOKEN`, and print a `?token=…` URL (`src/index.ts`). The token is
accepted once from the query string, moved into an `HttpOnly; SameSite=Lax`
cookie and stripped from the URL by a redirect, so it does not persist in
history or referrers. Tools send `Authorization: Bearer <token>`. Comparison is
constant-time over a SHA-256 digest, so neither the value nor its length leaks
through timing (`safeEqual()` in `src/http.ts`).

**Four things stay open on a token bind, deliberately** (`requireAuth()` in
`src/http.ts`): `POST /ingest` and `GET /widget.js`, because the widget runs on
a phone against an arbitrary host page and has nowhere to keep a secret;
`GET /feedback?view=pins`, a strict projection of what is already drawn on the
screen; and `GET /health`. Everything else answers 401. `scripts/e2e.mjs`
asserts that split in both directions, and `npm run canary` proves the assertion
fails when the check is disabled.

**Intake is rate limited**: 60 requests per minute per IP on `POST /ingest`,
429 past that, active only when a token is — i.e. on a non-loopback bind
(`ingestLimited()` in `src/http.ts`). Append-only intake means a LAN caller can
file noise; the limit means they cannot fill the disk.

**Item URLs render as links only when they are `http(s)`** — `safeHref()` in
`dashboard/src/lib/api.ts` resolves the URL and reads its protocol; `data:`,
`vbscript:` and `file:` render as plain text.

## Out of scope

**Unauthenticated local feedback is the product.** On a loopback bind, anything
that can reach the port can file an item. That is the design — the widget runs
on whatever origin your dev app serves from and has no credential to present.

**Deployed public sites are not a supported surface.** Chrome 142+ Local Network
Access blocks a public page from reaching `127.0.0.1`, so the widget is a
build-time tool, not production feedback capture
([docs/05-surface-compatibility.md](docs/05-surface-compatibility.md)). Use the
Sentry/PostHog rails for production signal. A report that the widget cannot
reach the hub from a deployed site is a compatibility note, not a vulnerability.

**A token on a LAN bind is a shared secret on a trusted network, not real
auth.** It exists so device testing is not wide open. Exposing Loopback beyond a
LAN without a token-gated reverse proxy in front is a deployment choice, and the
server warns loudly about it at startup.

**What the queue stores is sensitive by nature.** Pins carry console tails and
up to 2KB of failed response bodies, which routinely include auth headers, and
they live in `~/.loopback/loopback.db` and `~/.loopback/blobs/` on the
operator's own machine. Treat that database as secret material — that is exactly
why `extra` never crosses an origin.
