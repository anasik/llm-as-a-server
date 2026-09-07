# LLM as a Server

A website whose entire application layer is a language model.

There is no router, no controller, no resource, no template, no stylesheet and
no domain model in the deterministic code. A small trusted kernel running on a
Cloudflare Pages Function carries requests, stores an opaque document, isolates
sessions, validates generic safety properties and holds the API key. Everything
a visitor perceives as *the website* — which concepts exist, what a path means,
what a page says, how it looks, which status code comes back — is decided by a
language model, one inference per request, served by whichever of three
providers is currently healthy.

A visitor cannot tell they are not on an ordinary server. There is no shell, no
banner, no console, no debug panel and no client JavaScript. The response to
`GET /` is a complete HTML document the model wrote, served with the status code
the model chose. `curl` sees exactly what a browser sees.

## The hypothesis

Treat the model as a pure state transition:

```
(constitution, current_state, HTTP_request) -> (HTTP_response, next_state)
```

Every provider here is stateless: each inference carries the whole prompt, and
nothing about a visitor survives on any provider's side. That is a feature —
and it is also what makes failover between providers safe, since a request
served by the second provider is identical in every respect except who computed
it. It forces the entire
application state to be explicit, inspectable and owned by the runtime, so the
claim "the model is the application layer" is testable rather than rhetorical.
If the model were stateful, you could never tell how much of the site's
behaviour came from hidden provider-side memory.

## What Cloudflare knows, and what it refuses to know

| Deterministic kernel provides | Kernel deliberately does not know |
| --- | --- |
| HTTP transport, one catch-all function | what any path means |
| An opaque JSON document per session | what is inside that document |
| Optimistic-concurrency persistence in D1 | which concepts, pages or resources exist |
| Session isolation and unguessable namespaces | who a visitor is, beyond a random cookie |
| Schema, size, header and status validation | whether a page is *correct* |
| HTML sanitization | what a page says or how it should look |
| Secret management | anything about the site's editorial content |

The D1 schema is the clearest evidence. It has three tables — `sessions`,
`runtime_throttle`, `runtime_counters` — and not one column describing an
application concept. The site's entire domain model lives inside `state_json`,
which the kernel parses only to prove it is JSON under 64 KiB.

**The claim is not "there is no compute except the LLM."** The deterministic
layer really does provide persistence, transport, isolation, generic capability
execution, validation and secret management. The claim is narrower and testable:
*no conventional application server owns the website's semantics.*

## Why there is no client

An earlier version of this experiment had a shell page, a client-side router, a
fake address bar, an HTTP console and a diagnostics panel. All of it was
deleted, because all of it was the runtime taking back part of the website.

Now `functions/[[path]].ts` answers every request on every path, and the model's
document *is* the response. The browser's own address bar is the address bar.
Links are links. Forms are forms. The site works with JavaScript disabled,
because there is none.

Telemetry did not disappear — it moved out of band into `x-las-*` response
headers, visible in devtools or `curl -I`, and invisible on the page:

```
x-las-inferences: 1
x-las-tokens: prompt=3752 completion=388 cached=3584
x-las-state: v3->4 426B->426B
x-las-persisted: ok
x-las-filesystem: untouched
x-las-sanitizer: elements=0 attributes=0
```

## The model owns the design

The model returns a complete document, `<style>` block included. There is no
stylesheet on disk to fall back on, so the design is genuinely its decision, and
design drift between requests is a real, visible experimental result rather than
something a stylesheet papers over.

Allowing model-authored CSS means the response CSP permits inline styles:

```
default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline';
form-action 'self'; base-uri 'none'; frame-ancestors 'none'
```

Scripting remains impossible: no `script-src` is granted at all, and the
sanitizer removes `<script>`, event-handler attributes, `<iframe>`, `<object>`,
`<svg>`, `<link>`, `<base>` and every URL pointing at another origin. CSS is
sanitized too — `@import`, `expression()`, `behavior:`, `-moz-binding` and
remote `url()` references are stripped, so a stylesheet cannot phone home.

## Providers and failover

One inference client, three providers, chosen by measurement rather than
reputation. Each was tested against the *real* output contract — the full schema
and the actual constitution — because a model that passes a toy schema can still
fail this one:

| Provider | Contract compliance | Budget | Role |
| --- | --- | --- | --- |
| Groq `openai/gpt-oss-120b` | reliable, best pages | 8k tokens/min, 1000 req/day | primary |
| Gemini `gemini-3.1-flash-lite` | reliable | much higher throughput | failover |
| OpenRouter `openrouter/free` | **1 of 8 runs passed** | 20 req/min, 50/day free | last resort |

OpenRouter's free pool mostly fails the contract outright: it burns all 8,000
completion tokens without closing the JSON, or emits `next_state` as an object
rather than the serialized string the schema requires. It is kept last, and a
guard refuses any non-free model id so a paid model can never be selected by
accident.

The router tries providers in order and fails over on rate limits, timeouts and
upstream errors, recording a cooldown in the existing generic
`runtime_counters` table so an exhausted provider is skipped rather than retried.
`x-las-provider` reports who answered and how many were tried.

Two findings worth recording, both of which only appeared under load:

- **Groq queues instead of refusing.** Once its token budget is spent it holds
  the request rather than returning 429, so the original 45-second timeout meant
  a burst stalled instead of routing around the exhausted provider. The timeout
  is now 20 seconds, and failover costs ~2s.
- **Some OpenAI-compatible surfaces keep only one system message.** Gemini
  silently dropped the constitution and answered from the schema alone —
  producing valid JSON describing a site it knew nothing about. The prompt is
  now a single merged system message, which is byte-stable and so costs nothing
  in prompt caching. Everything Gemini returned before that fix was rejected by
  the validation boundary, which is the boundary doing its job.

## Why not tool calling

Two separate rejections.

**Domain-specific tools were rejected on principle.** Giving the model
`create_note`/`update_note` would move the domain model back into deterministic
code and reduce the model to an intent classifier picking among prewritten
handlers. The experiment would then be a natural-language front end over a
conventional CRUD API — exactly the thing it exists to avoid. The model does not
call functions to change the site; it *returns the site's next state*.

**Groq tool calling was rejected for the filesystem on mechanics.** Groq cannot
combine Structured Outputs with tool use. Since the strict output schema is the
enforcement boundary for every response, the filesystem is expressed inside that
same schema instead, as a discriminated union in the model's own output.

## The output contract

The provider's strict mode imposes two constraints that shaped the design
(verified against the live API, September 2026):

- the root schema must be an `object`; `anyOf`/`oneOf`/`enum` at the root are
  rejected — so the discriminated union is a flat object with a `kind`
  discriminator and nullable branches;
- every object must set `additionalProperties: false` and mark all properties
  required, which makes free-form JSON inexpressible — so `next_state` is a
  **string** containing serialized JSON. That is also the most opaque
  representation available: the kernel only checks that it parses and fits.

```jsonc
{
  "kind": "final",
  "response": { "status": 200, "headers": [{ "name": "content-type", "value": "text/html; charset=utf-8" }], "body": "<!doctype html>…" },
  "next_state": "{\"concepts\":{…}}",
  "filesystem_mutations": [],
  "filesystem_request": null
}
```

## The exceptional filesystem

A private per-session R2 namespace exists. **The ordinary request path never
touches it, and that is enforced rather than requested.**

- The ordinary transition path is handed `OrdinaryEnv = Omit<KernelEnv, "VFS_BUCKET">`.
  It has no bucket reference at all.
- `src/kernel/vfs.ts` is the only module that calls R2, and it refuses to run
  without a `FilesystemAccess` capability token.
- That token is branded with a module-private `unique symbol` in `validate.ts`
  and can only be minted after a concrete `necessity` statement and a
  well-formed generic operation set have been validated.
- Every storage call is counted, and the tests wrap the binding itself to assert
  the count is **zero** across full GET/POST/PUT/PATCH/DELETE sequences.

Groq never touches R2. It emits intent, and the kernel executes it:

```jsonc
{
  "kind": "filesystem_request",
  "necessity": "The visitor asked to read back a CSV export they created earlier.",
  "operations": [{ "op": "read", "path": "/exports/concepts.csv", "limit": null, "max_bytes": 8192 }]
}
```

The kernel runs at most 4 bounded read-only operations (`list`, `stat`, `read`)
inside that session's namespace, then makes **exactly one** second inference
containing only the bounded results. That turn must return `kind: "final"`; a
second filesystem request is rejected outright and the whole request fails. A
`final` transition may carry up to 4 `write`/`delete` mutations, each with its
own necessity statement.

The model receives **no** file listing, manifest, metadata or contents by
default. **R2 is not model memory.** Groq sees nothing about storage unless it
explicitly asks and the kernel performs the exceptional second inference.

### Honest limit on "necessity"

The kernel validates that a necessity statement is present, non-trivial and
bounded. **It cannot judge whether the stated necessity is true.** A model that
writes a plausible sentence can reach storage it did not need. What the kernel
guarantees is narrower: nothing reaches storage silently, every access carries an
auditable justification, and the operations are bounded and namespaced. Semantic
necessity is enforced by the constitution and observable in telemetry, not
proven by the runtime.

### Safety of stored bytes

Stored content is inert. Active types (`text/html`, `text/css`, `application/pdf`, …)
may be stored, but downloads are always served as `application/octet-stream`
with `Content-Disposition: attachment`, `X-Content-Type-Options: nosniff` and
`Content-Security-Policy: default-src 'none'; sandbox`. Nothing stored is ever
executed, imported, evaluated or rendered into a page.

## Consistency limitation: there are no atomic D1+R2 transactions

A `final` transition can change both the opaque state and stored objects. These
are two services and **there is no cross-service transaction.** The kernel does
not pretend otherwise:

1. Mutations are applied first, recording whether each path already existed.
2. The version-checked state write follows.
3. If the state write conflicts or fails, newly created objects are deleted
   (compensation), and the response reports `x-las-filesystem` as `compensated`.
4. Overwrites and deletes **cannot** be undone. They are reported as `partial`.

The failure ordering is chosen so the surviving inconsistency is the harmless
one: objects nothing refers to, rather than state referring to objects that do
not exist. Every response says which persistence step succeeded.

## Trust boundary

Model output is untrusted input. It is validated for schema and union validity,
JSON serializability, size caps (96 KiB body, 64 KiB state, 64 KiB per file),
status range 200–599, a small response-header allowlist, prohibited headers,
redirect coherence, path normalization, session namespace, operation counts,
quotas and encodings, then sanitized. **If any check fails, nothing is
persisted** — no state write, no file mutation, and the visitor gets a plain
`502` rather than the model's page.

Cookies, `authorization` headers and platform headers are never forwarded to the
model. When the runtime itself fails it serves a deliberately plain error page
that names no provider, no model and no experiment.

Application-level logins the model invents are **theatre** and must never be
presented as real security. Session isolation, by contrast, is deterministic and
mandatory: the R2 namespace is `SHA-256(secret salt ‖ session id)`, derived only
inside the kernel and never sent to the model or the client.

## Layout

```
SERVER.md                     the constitution — the only place semantics live
src/kernel/
  handle.ts                   orchestration: session, inference, validate, persist, serve
  sanitize.ts                 HTMLRewriter allowlist for model-authored documents
  validate.ts                 the generic validation boundary + capability token
  vfs.ts                      the only module that touches R2
  vfspath.ts                  pure path/MIME/encoding rules
  state.ts                    D1: opaque document, version check, throttling
  groq.ts                     provider transport and cache-friendly message order
  schema.ts                   the strict JSON schema
  normalize.ts                request normalization and header allowlist
functions/[[path]].ts         every request, every method, one handler
functions/__harness/          health, reset, diagnostics, attachment download
public/                       no assets — the site has none
migrations/                   three generic runtime tables
```

## Running locally

```bash
npm install
npm test          # 61 tests — kernel on real local D1/R2, sanitizer, static audit
npm run smoke     # serving surface, CSP, harness — costs no tokens
npm run dev       # http://127.0.0.1:8788
npm run live      # drives the real model through the local server
```

`npm run dev` and `npm run live` need `.dev.vars` (git-ignored):

```
GROQ_API_KEY=…
VFS_NAMESPACE_SALT=…            # any 32-byte hex string
```

Browse to `http://127.0.0.1:8788`, then type any path you like. Reset your
session at `/__harness/reset`.

## Deploying

```bash
wrangler d1 create llm_as_a_server_state          # put the id in wrangler.toml
wrangler d1 migrations apply llm_as_a_server_state --remote
wrangler r2 bucket create llm-as-a-server-vfs     # private; bound server-side only
wrangler pages project create llm-as-a-server
wrangler pages secret put GROQ_API_KEY --project-name llm-as-a-server
wrangler pages secret put VFS_NAMESPACE_SALT --project-name llm-as-a-server
wrangler pages deploy
```

The key lives only as an encrypted Cloudflare secret. It is never in source
control, static JavaScript, generated HTML, logs or committed Wrangler vars.

## Observed results

From `npm run live` against the real provider (local runtime):

| Request | Response | Inferences | State | Filesystem |
| --- | --- | --- | --- | --- |
| `GET /` | 200, complete styled document | 1 | 4 B → 334 B | untouched |
| `GET /a/path/nobody/has/ever/requested` | genuine 404 page | 1 | unchanged | untouched |
| `POST /concepts` (form) | 201 + `Location: /concepts/kettle` | 1 | 334 B → 426 B | untouched |
| `GET /concepts` | 200, lists the created concept | 1 | unchanged | untouched |
| `PATCH /concepts/kettle` | 200 | 1 | 426 B → 431 B | untouched |
| `DELETE /concepts/kettle` | 204, empty body | 1 | 431 B → 334 B | untouched |
| `POST /exports` (explicit file request) | 200 with a download link | 1 | unchanged | **applied: 3 calls, 183 B written** |
| `GET /__harness/attachment?path=…` | 200 `text/csv` attachment, nosniff | 0 | unchanged | read |
| fresh session `GET /concepts` | 200, empty index | 1 | 4 B → 287 B | untouched |

The model chose the status codes, the `Location` header, the CSV contents and
every byte of markup and CSS. Prompt caching engaged (up to 3,584 cached prompt
tokens); latency was 0.9–1.5 s per request. Nine consecutive ordinary requests
made **zero** storage calls, and the sanitizer stripped nothing, because the
model stayed inside the allowlist unprompted.

### Availability under load

Eight requests fired with no pacing at all, against a single Groq key that
allows roughly two per minute:

```
#   status  provider              ms     tokens
0   200     groq attempts=1       1753   prompt=3632 completion=593
1   200     gemini attempts=2     3156   prompt=3368 completion=342
2   404     gemini attempts=1     2770   prompt=3368 completion=268
…
served by:  groq 1   gemini 7   runtime errors 0
```

Groq served the first request, exhausted its token budget, and every subsequent
request was served by Gemini instead — with zero runtime errors. The 404s are
status codes the model chose for paths that do not exist, which is the site
working, not failing. Without failover the same burst produced six errors, three
of them after a 45-second stall.

## Tests

61 tests across two environments: the kernel and sanitizer against real local D1
and R2 bindings in workerd, and a static audit of the source. They cover the
invariants that would falsify the experiment:

- **no application semantics in deterministic code** — the audit greps for
  domain identifiers, hard-coded semantic paths, method dispatch and
  application tables in the schema, and fails if any appear;
- **no static assets, no client script, no runtime stylesheet** — the audit
  fails if `public/` ever gains a served file;
- **exactly one runtime-authored HTML document**, the plain error page, which
  must not name the provider, the model or the experiment;
- **zero storage calls** on ordinary GET/POST/PUT/PATCH/DELETE sequences,
  measured by wrapping the binding itself;
- **no filesystem data in the first prompt** — the per-request payload is
  asserted to contain only the state document and the request;
- invalid model output, oversized state, stale concurrent writes, cross-session
  access, traversal, quota and MIME violations all reject **without** touching
  state or files;
- stored active content is never executed or served as active content;
- persistence failures are surfaced honestly and never masquerade as success.

## What would support or falsify the idea

**Supporting evidence:** coherent state across long sessions; arbitrary paths
handled sensibly; correct HTTP semantics chosen without deterministic help;
storage staying untouched at the ordinary-path rate of zero; prompt caching
keeping cost tolerable.

**Falsifying evidence:** state drift or silent loss of visitor-created concepts;
the model needing route hints smuggled into the runtime; routine unnecessary
filesystem access despite the constitution; validation failures frequent enough
to require the kernel to "fix up" output (which would mean the kernel had
acquired semantics); latency or token cost that only a conventional server
could fix.

Failure modes already observed, and worth recording:

- **Identity drift.** Across one session the site called itself "ModelSite",
  "Model-Driven Site" and "Technical Publication". The constitution asks the
  model to record and honour its identity in state; a 20B model often does not.
  This is the clearest weakness the architecture exposes, and it is exactly the
  kind of thing a stylesheet or a template would have hidden.
- **Advertising a file it never wrote.** The model once linked a download for a
  file it had not created. Addressed by an explicit constitution rule, because
  it is a semantic bug and semantics live there, not in the kernel.
- **Occasional empty responses** where a page was warranted.

All three are model-quality problems visible *through* the architecture, which
is what the telemetry is for.

## Limitations

- Local tests run against workerd/miniflare, not production D1 and R2.
- Necessity enforcement is auditable, not semantically verifiable (above).
- No atomic D1+R2 transaction (above).
- Free-tier token throughput is the binding practical constraint, and at ~1 s
  per request this is slower than any real server.
- Simulated application-level authentication is not security.
