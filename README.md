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
| `ALLOWED_ORIGINS`            | `*`         | Comma-separated list of allowed origins for CORS **and** the WebSocket Origin check. Leave as `*` only for local development.                                                           |
| `AUTH0_DOMAIN`               | —           | Auth0 tenant domain. **Required** (with `AUTH0_AUDIENCE`) to start.                                                                                                                     |
| `AUTH0_AUDIENCE`             | —           | Auth0 API audience the access token must target. **Required** to start.                                                                                                                 |
| `ALLOW_NO_AUTH`              | —           | Set to `true` to run **without authentication**. Only honoured for a local source checkout; the published npm package ignores it. Local development only.                               |
| `HKP_RUNTIME_URL_ALLOWLIST`  | —           | Comma-separated `host` or `host:port` list. When set, the coordinator may only dial runtimes whose host is listed (strict allowlist; recommended for shared/exposed coordinators).      |
| `HKP_ALLOW_PRIVATE_RUNTIMES` | —           | Set to `true` to let the coordinator dial loopback/private (RFC1918/ULA) runtime URLs. Needed for local or self-hosted internal runtimes. Link-local/metadata stays blocked regardless. |
| `NAME`                       | `hkp-node`  | Server name reported to clients                                                                                                                                                         |

### Authentication

The server **fails closed** on a public bind: it refuses to start unless `AUTH0_DOMAIN` and
`AUTH0_AUDIENCE` are set. Every HTTP route and WebSocket upgrade then requires a valid Auth0
bearer token. Because browsers can't set headers on a WebSocket handshake, the token is passed
as an `?access_token=` query parameter on the WS URL.

A single instance serves a **single tenant** — any valid token may access any runtime on the
server. Run one instance per user; do not share an instance between users.

**Coordinator → runtime (delegated session tokens).** The coordinator reaches runtimes as a
machine client over long-lived connections, so it can't use a user JWT (those expire and the
user may be offline). Instead, while the user is creating/modifying a board the coordinator
provisions runtimes **with the user's JWT**, then exchanges it via `POST
/runtimes/:id/session-token` for an opaque, per-runtime **session token** that resolves back to
that user. The coordinator presents this token (in the `Authorization` header) on its result
WebSocket and teardown calls. Tokens are in-memory only and bound to the runtime's lifetime: if a
runtime restarts, the coordinator must re-provision, which needs a live user JWT — so boards
don't self-heal across a runtime restart while the user is offline (persisting these bindings is
future work). There is no shared static service secret.

**SSRF guard.** A board config is untrusted input (boards can be shared/imported), and it tells
the coordinator which `runtime.url` to dial from inside its network. The coordinator validates
every such URL (resolving the host and checking all addresses): link-local / cloud-metadata
(`169.254.169.254`) and the unspecified address are always blocked, and loopback/private ranges
are blocked unless allowed via `HKP_ALLOW_PRIVATE_RUNTIMES` or `HKP_RUNTIME_URL_ALLOWLIST`. For
local/self-hosted runtimes (including the single-box setup), set `HKP_ALLOW_PRIVATE_RUNTIMES=true`.

**Loopback bind = no auth required.** When `HOST` is a loopback address (`127.0.0.1`, `::1`,
`localhost`), the server is reachable only from the local machine, so the loopback bind is
itself the access-control boundary and no Auth0 config is needed. This is how a local runtime
runs inside the native Meander app. On any other bind you must either configure Auth0 or — from
a source checkout only — set `ALLOW_NO_AUTH=true`.

Example:

```sh
# Production (public bind → Auth0 required)
AUTH0_DOMAIN=your.eu.auth0.com AUTH0_AUDIENCE=your-api ALLOWED_ORIGINS=https://app.example npx hkp-node

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

---

## Services

The following services are built in and available to any runtime created on this server.

| Service ID                | Name                  |
| ------------------------- | --------------------- |
| `monitor`                 | Monitor               |
| `map`                     | Map                   |
| `timer`                   | Timer                 |
| `sub-service`             | SubService            |
| `http-server-subservices` | HttpServerSubservices |
| `peer-server`             | PeerServer            |
| `imap-email`              | IMAP Email            |
| `smtp-email`              | SMTP Email            |
| `telegram-listener`       | Telegram Listener     |
| `telegram-sender`         | Telegram Sender       |

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
