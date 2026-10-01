# hkp-node

Node.js runtime server for the [Readymade](https://hookitapp.com) platform. Implements the REST and WebSocket API consumed by the Readymade application so boards can run services on a Node.js host instead of (or alongside) the native C++ runtime.

- **Website:** [hookitapp.com](https://hookitapp.com)
- **Documentation:** [hookitapp.com/documentation](https://hookitapp.com/documentation)
- **Source:** [codeberg.org/cbastuck/hkp-node](https://codeberg.org/cbastuck/hkp-node)
- **Security:** [SECURITY.md](SECURITY.md)

---

## Quick start

No installation required:

```sh
npx hkp-node
```

Or install globally:

```sh
npm install -g hkp-node
hkp-node
```

Or run from source:

```sh
npm install
npm run dev
```

The server starts on port `8080` by default and prints the address on startup.

---

## Configuration

All options are passed as environment variables.

| Variable                     | Default     | Description                                                                                                                                                                             |
| ---------------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PORT`                       | `8080`      | HTTP and WebSocket listen port                                                                                                                                                          |
| `HOST`                       | `0.0.0.0`   | Bind address                                                                                                                                                                            |
| `EXTERNAL_HOST`              | `127.0.0.1` | Hostname written into runtime `outputUrl` (use your machine's LAN/public IP when connecting from other devices)                                                                         |
| `ALLOWED_ORIGINS`            | `*`         | Comma-separated list of allowed origins for CORS **and** the WebSocket Origin check. Leave as `*` only for local development. A native app's webview is its own origin — the Readymade apps send `hkp://app` (iOS), `saucer://embedded` (packaged desktop) and `https://appassets.androidplatform.net` (Android). |
| `AUTH0_DOMAIN`               | —           | Auth0 tenant domain. **Required** (with `AUTH0_AUDIENCE`) to start.                                                                                                                     |
| `AUTH0_AUDIENCE`             | —           | Accepted `aud` values, comma-separated — the Auth0 client id of each application whose users this runtime serves (the frontend sends its id_token). **Required** to start.               |
| `ALLOWED_EMAILS`             | —           | Comma-separated email allowlist. When set, only tokens with a **verified** `email` claim on the list are accepted; requires Auth0 config (refuses to start without it).                 |
| `ALLOW_NO_AUTH`              | —           | Set to `true` to run **without authentication**. Only honoured for a local source checkout; the published npm package ignores it. Local development only.                               |
| `NAME`                       | `hkp-node`  | Server name reported to clients                                                                                                                                                         |
| `HKP_MAX_RUNTIMES_PER_USER`  | —           | Maximum runtimes one tenant may hold. Unset or `0` means unlimited. Reconnecting to a runtime that already exists is never refused.                                                      |
| `HKP_MAX_SERVICES_PER_RUNTIME` | —         | Maximum services per runtime. Unset or `0` means unlimited.                                                                                                                             |
| `HKP_MIN_TIMER_INTERVAL_MS`  | —           | Lower bound on the Timer service's periodic interval; shorter periods are clamped to it. Unset or `0` means no floor.                                                                    |
| `HKP_MAX_INLINE_ASSET_BYTES` | `8388608`   | Largest content one asset may carry inline as `text` or `base64` (8 MB); larger content is named by URL.                                                                                 |
| `HKP_MAX_ASSET_REQUEST_BODY_BYTES` | `33554432` | Largest body of a request that carries asset descriptors — creating a runtime, pushing assets, deploying a board (32 MB) — accepted only from an authenticated caller. It bounds how much inline content one runtime, or one deployed board, may be handed at once, counted as it travels (base64, JSON-escaped). Left unset it is never less than one asset at the inline limit needs. |
| `HKP_MAX_REQUEST_BODY_BYTES` | `26214400`  | Largest request body accepted on a service endpoint (25 MB). Oversized requests get `413`. Set `0` to disable — unwise, since these endpoints take no token.                             |
| `HKP_COORDINATOR_LINKS_FILE` | `~/.hkp/node/coordinator-links.json` | Where this server keeps the tickets it connects to coordinators with, so a deployed board's runtimes are re-established after a restart. Set to the empty string to keep them in memory only. Written `0600`: a ticket is a bearer credential for one runtime of one board. |
| `HKP_COORDINATOR_DATA_DIR`   | `~/.hkp/coordinator/boards` | Where the coordinator keeps the boards it has been given, one JSON file each, so they survive a restart. Set to the empty string to keep them in memory only. Files hold the board's config — which can carry service credentials — and are written `0600` under `0700` directories. One directory belongs to one coordinator: two processes sharing it will both restore every board and fight over the same runtimes. |

### Authentication

The server **fails closed** on a public bind: it refuses to start unless `AUTH0_DOMAIN` and
`AUTH0_AUDIENCE` are set. Every HTTP route and WebSocket upgrade then requires a valid Auth0
bearer token. Because browsers can't set headers on a WebSocket handshake, the token is passed
as an `?access_token=` query parameter on the WS URL.

**Multi-tenancy.** Runtimes are namespaced by the authenticated user, taken from the token's
`sub` claim — the same identifier the coordinator uses as its `userId`. Every route resolves
runtime ids inside the caller's own namespace, so one instance can serve many users:

- `GET /runtimes` lists only your runtimes; `DELETE /runtimes` clears only yours.
- A runtime id owned by another user answers **404**, not 403 — ids cannot be probed.
- Two users may hold the same runtime id at once. This is the normal case, since boards ship
  stable, human-readable ids (`node`, `chat-node`), and each user gets their own runtime.

Routes are unchanged: identity comes from the `Authorization` header, never from the path.

When authentication is disabled (a loopback bind, or `ALLOW_NO_AUTH=true` from a checkout),
every request collapses into a single `anonymous` tenant — identical to the pre-tenancy
behaviour, which is what local development wants.

Note that a user signing in through two different identity providers (say Google and
email/password) receives two Auth0 `sub`s, and therefore two separate namespaces. Consolidating
those is an Auth0-side concern and is not handled here.

### Service endpoints (mounts)

Services that must be reachable from outside — `http-server-subservices`, `peer-server` — do
not bind a port. The runtime assigns each one an opaque path on this same server and publishes
the resulting address in the service's state, as `__hkpMount`:

```
http://<EXTERNAL_HOST>:<PORT>/hosted/<mountId>
```

The `__hkp` prefix marks a reserved property: its meaning is defined outside the service
holding it, so that generic board machinery can read and rewrite it. A board pointing a
client at one of these endpoints puts a `hkp-mount://<runtimeId>/<serviceUuid>` reference in
the same field on the consuming service, since the address is not knowable at design time.

Resolving that reference is the **coordinator's** job, not a runtime's: a runtime sees its
own services and nothing else, while a reference names a service on another runtime, possibly
on another machine. For a cloud board this coordinator is `src/coordinator/` — a `BoardSession`
collects the addresses its runtimes published, then configures each consumer with the plain
address. It does so after every runtime is provisioned (references pointing at a runtime
provisioned later cannot resolve before then) and again whenever a service publishes an
address later, e.g. on being unbypassed.

The board itself keeps its references; only what is handed to a running service is resolved.
A reference is what survives being saved and reopened elsewhere, an address is only true of
one run. Services on browser runtimes are not configured from here — the bridge carries
processing only — so those resolve in the browser, which coordinates its own board state.

Ports are a single machine-wide namespace, so on a shared host a service asking for a specific
port is a land grab: the second claimant fails and whoever wins receives traffic the other
expected. An assigned id avoids that, and because runtime ids are only unique per tenant they
could not have appeared in a globally-routable path anyway.

These endpoints are deliberately **unauthenticated** — they exist to be called by outside
parties (webhooks, uploads, PeerJS clients) that hold no token — so the unguessable `mountId`
is what gates access. It carries no user identifier. A mount is released when its service is
bypassed or its runtime goes away.

The address is not knowable at board-design time, so a board reads it from the service's state
rather than hard-coding it. `port` and `path` are still accepted on these services and ignored,
so existing boards load; they simply no longer control anything.

#### What a request looks like to the pipeline

`http-server-subservices` hands each request to its pipeline as **MixedData** — JSON metadata
plus the raw body — matching the shape hkp-rt's body-carrying HTTP service already produces:

```jsonc
{
  "meta": {
    "method": "POST",
    "path": "/upload",              // path below the mount, not the mount prefix
    "query": { "a": "1" },
    "contentType": "application/json",  // present when the request carried one
    "filename": "notes.txt"             // from content-disposition, when present
  },
  "body": { "hello": "world" }          // decoded, when the type allows it
}
```

The body arrives in **exactly one** form, never both — carrying the raw bytes next to a
decoded value would only restate it at twice the size:

| Content type                        | Field    | Value                |
| ----------------------------------- | -------- | -------------------- |
| `application/json`, `*+json`        | `body`   | parsed JSON value    |
| `application/x-www-form-urlencoded` | `body`   | parsed fields object |
| `text/*`                            | `body`   | string               |
| anything else                       | `binary` | raw bytes            |
| no request body (e.g. GET)          | —        | neither field        |

So a JSON webhook is reachable as `params.body.hello`, while an upload stays raw for a
filesystem service to write.

Charset parameters are ignored when matching. Malformed input falls back to `binary` rather
than failing the request: the endpoint is public and takes whatever it is given, so the raw
bytes remain available to inspect.

Because JS has no JSON form for a byte array, a Monitor renders `binary` as
`{"0":123,"1":34,…}` — that is the display, not the data; services in the pipeline receive a
real `Uint8Array`.

**This replaced the previous flat `{ path, method }`.** A pipeline that matched on `params.path`
now needs `params.meta.path`. No board shipped in `boards` used this service on
hkp-node, so nothing in-tree broke, but your own boards may need the same edit.

Note hkp-rt's `http-server-subservices` still emits the flat shape — the two runtimes are
temporarily out of step until that side is updated.

**Runtime server → coordinator (tickets).** A coordinator never dials a runtime server. When a
board is deployed, the person's client asks the coordinator for a **ticket** per remote runtime
(`POST /coordinator/users/:sub/boards/:board/tickets`) and tells each runtime server to connect
with it (`POST /coordinator-links`, over the same session it creates runtimes with). The runtime
server then opens a WebSocket to the coordinator's `/coordinator/join`, presenting the ticket as
a bearer token, and the coordinator builds, configures and drives that runtime over the
connection that came in.

- A ticket speaks for **one runtime of one board of one person**. The connection can do nothing
  else, and acts on the runtime server as the user who introduced it.
- The coordinator keeps only a hash; the runtime server keeps the ticket
  (`HKP_COORDINATOR_LINKS_FILE`) and reconnects with it after a restart or a dropped connection,
  with nobody present. The coordinator then rebuilds the runtime from the board's config.
- Deploying again replaces a runtime's ticket; deleting the board, or deploying it without that
  runtime, revokes it. A runtime server whose ticket is no longer held drops the link and the
  runtime it was for.
- Because nothing is dialled on a board's say-so, there is no address allowlist to maintain and no
  SSRF surface on this path: `HKP_RUNTIME_URL_ALLOWLIST` and `HKP_ALLOW_PRIVATE_RUNTIMES` no longer
  exist. A runtime server on a laptop behind NAT, or on loopback, joins like any other — the only
  thing that has to be reachable is the coordinator.

`POST /runtimes/:id/session-token` still exists on the runtime server but the coordinator no
longer uses it.

**Loopback bind = no auth required.** When `HOST` is a loopback address (`127.0.0.1`, `::1`,
`localhost`), the server is reachable only from the local machine, so the loopback bind is
itself the access-control boundary and no Auth0 config is needed. This is how a local runtime
runs inside the native Readymade app. On any other bind you must either configure Auth0 or — from
a source checkout only — set `ALLOW_NO_AUTH=true`.

Example:

```sh
# Production (public bind → Auth0 required)
# AUTH0_AUDIENCE lists every client id whose users this runtime serves: the website's
# SPA application and the native apps' one are necessarily separate Auth0 applications.
AUTH0_DOMAIN=hookitapp.eu.auth0.com AUTH0_AUDIENCE=x4iF0MBYfd25oLdJbATNe03dCDUtBs74,gpk8IFPKfaOTQUzpDRO7vBajOnB72rkM ALLOWED_ORIGINS=https://node.readymadeit.com npx hkp-node

# Same, but restricted to specific users (verified email claim must be on the list)
AUTH0_DOMAIN=your.eu.auth0.com AUTH0_AUDIENCE=your-api ALLOWED_ORIGINS=https://app.example \
  ALLOWED_EMAILS=alice@example.com,bob@example.com npx hkp-node

# Local only (loopback bind → no auth needed)
HOST=127.0.0.1 npx hkp-node

# No auth on a non-loopback bind (from a checkout only)
ALLOW_NO_AUTH=true npm run dev
```

### Deployment & network exposure

The Docker image runs as the unprivileged `node` user and binds `HOST=0.0.0.0` — this is
required so that a published port actually reaches the process; binding `127.0.0.1` _inside_
a container would make it unreachable from `-p` forwarding. Control where the server is
reachable at the **host** level instead:

```sh
docker run -p 8080:8080            …   # reachable from anywhere
docker run -p 127.0.0.1:8080:8080  …   # reachable only from the host (loopback)
docker run                         …   # no published port: not reachable off-container
```

Override the in-container bind only when you have a specific reason (e.g. fronting it with a
reverse proxy in the same network namespace): `docker run -e HOST=127.0.0.1 …`.

All configuration from the table above is passed the same way, with `-e` flags. Note that the
container binds `0.0.0.0` — a non-loopback bind — so Auth0 config is **required** for it to start:

```sh
docker run -p 8080:8080 \
  -e AUTH0_DOMAIN=your.eu.auth0.com \
  -e AUTH0_AUDIENCE=your-api \
  -e ALLOWED_ORIGINS=https://app.example \
  -e ALLOWED_EMAILS=alice@example.com,bob@example.com \
  cbastuck/hkp-node:latest
```

Or keep the settings in a file and use `--env-file`:

```sh
# hkp-node.env
AUTH0_DOMAIN=your.eu.auth0.com
AUTH0_AUDIENCE=your-api
ALLOWED_ORIGINS=https://app.example
ALLOWED_EMAILS=alice@example.com,bob@example.com
```

```sh
docker run -p 8080:8080 --env-file hkp-node.env cbastuck/hkp-node:latest
```

---

## Services

Built in and available to any runtime created on this server. Each service's own
page in `docs/content/services/` is the detail; this is the roster.

| Service ID | Name | What it does |
| --- | --- | --- |
| `communication-dispatcher` | Communication Dispatcher | Decides what happens next about an ongoing conversation |
| `conversations` | Conversations | Threads of mail, their state, and the work produced along the way |
| `document-extract` | Document Extract | Turns a document into text a model can read |
| `hold` | Hold | Keeps the latest value one side produced and replays it to the other |
| `http-client` | HTTP Client | Issues HTTP requests and emits the response |
| `http-server-subservices` | HttpServerSubservices | Serves an endpoint, running an inner pipeline per request |
| `imap-email` | IMAP Email | Pushes each new incoming email into the pipeline |
| `injector` | Injector | Injects a configured static value into the pipeline |
| `iterator` | Iterator | Runs a nested pipeline once per item |
| `join` | Join | Splits off work and returns the answer beside the current value |
| `map` | Map | Transforms data with a declarative template |
| `monitor` | Monitor | Logs the current value and passes it through unchanged |
| `peer-server` | PeerServer | Serves an endpoint for peers to connect to |
| `queue` | Queue | How one board says something to another |
| `smtp-email` | SMTP Email | Sends mail, addressed by config or by the current value |
| `sql` | SQL | A board's own SQL database |
| `stopper` | Stopper | Stops the pipeline unconditionally |
| `store` | Store | What a board remembers between runs — keyed and durable |
| `sub-service` | SubService | Embeds an inner pipeline of services |
| `telegram-listener` | Telegram Listener | Pushes each incoming Telegram message into the pipeline |
| `telegram-sender` | Telegram Sender | Sends a Telegram message |
| `text-generation` | Text Generation | Generates text with a local or hosted language model |
| `timer` | Timer | Emits periodic or one-shot ticks |


---

## API

### Runtimes

| Method   | Path                             | Description                                |
| -------- | -------------------------------- | ------------------------------------------ |
| `GET`    | `/runtimes`                      | List all runtimes and the service registry |
| `POST`   | `/runtimes`                      | Create one or more runtimes                |
| `DELETE` | `/runtimes`                      | Remove all runtimes                        |
| `GET`    | `/runtimes/:runtimeId`           | Get a single runtime                       |
| `DELETE` | `/runtimes/:runtimeId`           | Remove a runtime                           |
| `POST`   | `/runtimes/:runtimeId`           | Process input for a runtime                |
| `POST`   | `/runtimes/:runtimeId/rearrange` | Reorder services in a runtime              |

### Services

| Method   | Path                                                             | Description                   |
| -------- | ---------------------------------------------------------------- | ----------------------------- |
| `GET`    | `/runtimes/:runtimeId/services`                                  | List services in a runtime    |
| `POST`   | `/runtimes/:runtimeId/services`                                  | Add a service                 |
| `GET`    | `/runtimes/:runtimeId/services/:instanceId`                      | Get service state             |
| `POST`   | `/runtimes/:runtimeId/services/:instanceId`                      | Configure a service           |
| `DELETE` | `/runtimes/:runtimeId/services/:instanceId`                      | Remove a service              |
| `GET`    | `/runtimes/:runtimeId/services/:instanceId/property/:propertyId` | Get a single service property |

### Inputs

| Method | Path                                   | Description         |
| ------ | -------------------------------------- | ------------------- |
| `GET`  | `/runtimes/:runtimeId/inputs`          | List runtime inputs |
| `GET`  | `/runtimes/:runtimeId/inputs/:inputId` | Get a single input  |

### WebSocket

Connect to `ws://<host>:<port>/<runtimeId>?access_token=<jwt>` to receive live notifications and results for a runtime. The upgrade is authenticated (token + Origin) exactly like the HTTP routes. The connection is tied to the runtime's lifecycle — when the last client disconnects, the runtime is destroyed.

---

## How to publish a release

1. **Make sure you're logged in / on the right registry**

   ```sh
   npm whoami          # confirms you're authenticated
   ```

   If not: `npm login`.

2. **Clean tree + tests green**

   ```sh
   git status          # nothing uncommitted you don't want shipped
   npm test
   ```

3. **Bump the version** (this also creates a git tag by default)

   ```sh
   npm version patch   # 1.0.5 → 1.0.6   (use minor/major as appropriate)
   ```

4. **Publish** — `prepublishOnly` rebuilds `dist/` automatically, and `files` limits the tarball to `dist/src`:

   ```sh
   npm run publish:npm
   ```

   Optionally dry-run first to see exactly what ships:

   ```sh
   npm publish --dry-run
   ```

5. **Push the version commit + tag**

   ```sh
   git push && git push --tags
   ```

---

## Legal

### Copyright

Copyright © 2026 cbastuck. All rights reserved.

### License

This software is licensed under the **GNU Affero General Public License v3.0 only (AGPL-3.0-only)**. See [LICENSE](LICENSE) for the full text.

Key obligations under AGPL-3.0:

- You may use, study, copy, and modify this software freely.
- If you distribute a modified version — or operate a modified version as a **network service** accessible to others — you must make your complete modified source code available under the same license (AGPL-3.0).
- This copyleft obligation applies even when the software is only accessed remotely (e.g. as an API server), not just when binaries are distributed. This is the core distinction between AGPL and GPL.

If you require a commercial license that does not carry these obligations, contact [mail@cbastuck.de](mailto:mail@cbastuck.de).

### Disclaimer

> This tool is modular and may be used in a variety of contexts. The author does not endorse and is not responsible for any misuse of the software, including but not limited to illegal, harmful, or unauthorized activities. Users are solely responsible for ensuring that their use of this software complies with all applicable laws and regulations in their jurisdiction.

Full disclaimer: [hookitapp.com/disclaimer](https://hookitapp.com/disclaimer)

### Terms of Use

This software is provided primarily for demonstration and development purposes. It is **not designed or guaranteed for production, safety-critical, or high-risk environments**. Third-party components are subject to their respective licenses.

Full terms: [hookitapp.com/terms](https://hookitapp.com/terms)

### Privacy

This software runs entirely on your own infrastructure. No data is sent to the author. If you use services that process personal data (e.g. IMAP email, Telegram), you are the data controller and are responsible for applicable data protection law compliance.

Privacy policy for the Hookup website: [hookitapp.com/privacy](https://hookitapp.com/privacy)

### No Warranty

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES, OR OTHER LIABILITY ARISING FROM, OUT OF, OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE. See LICENSE sections 15–16 for the complete disclaimer of warranty and limitation of liability.
