# hkp-node

Node.js runtime server for the [Hookup](https://hookitapp.com) platform. Implements the REST and WebSocket API consumed by the Hookup frontend so boards can run services on a Node.js host instead of (or alongside) the native C++ runtime.

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

| Variable | Default | Description |
|---|---|---|
| `PORT` | `8080` | HTTP and WebSocket listen port |
| `HOST` | `0.0.0.0` | Bind address |
| `EXTERNAL_HOST` | `127.0.0.1` | Hostname written into runtime `outputUrl` (use your machine's LAN/public IP when connecting from other devices) |
| `ALLOWED_ORIGINS` | `*` | CORS `Access-Control-Allow-Origin` value |
| `NAME` | `hkp-node` | Server name reported to clients |

Example:

```sh
PORT=3000 EXTERNAL_HOST=192.168.1.10 npx hkp-node
```

---

## Services

The following services are built in and available to any runtime created on this server.

| Service ID | Name |
|---|---|
| `monitor` | Monitor |
| `map` | Map |
| `timer` | Timer |
| `sub-service` | SubService |
| `http-server-subservices` | HttpServerSubservices |
| `peer-server` | PeerServer |
| `imap-email` | IMAP Email |
| `smtp-email` | SMTP Email |
| `telegram-listener` | Telegram Listener |
| `telegram-sender` | Telegram Sender |

---

## API

### Runtimes

| Method | Path | Description |
|---|---|---|
| `GET` | `/runtimes` | List all runtimes and the service registry |
| `POST` | `/runtimes` | Create one or more runtimes |
| `DELETE` | `/runtimes` | Remove all runtimes |
| `GET` | `/runtimes/:runtimeId` | Get a single runtime |
| `DELETE` | `/runtimes/:runtimeId` | Remove a runtime |
| `POST` | `/runtimes/:runtimeId` | Process input for a runtime |
| `POST` | `/runtimes/:runtimeId/rearrange` | Reorder services in a runtime |

### Services

| Method | Path | Description |
|---|---|---|
| `GET` | `/runtimes/:runtimeId/services` | List services in a runtime |
| `POST` | `/runtimes/:runtimeId/services` | Add a service |
| `GET` | `/runtimes/:runtimeId/services/:instanceId` | Get service state |
| `POST` | `/runtimes/:runtimeId/services/:instanceId` | Configure a service |
| `DELETE` | `/runtimes/:runtimeId/services/:instanceId` | Remove a service |
| `GET` | `/runtimes/:runtimeId/services/:instanceId/property/:propertyId` | Get a single service property |

### Inputs

| Method | Path | Description |
|---|---|---|
| `GET` | `/runtimes/:runtimeId/inputs` | List runtime inputs |
| `GET` | `/runtimes/:runtimeId/inputs/:inputId` | Get a single input |

### WebSocket

Connect to `ws://<host>:<port>/<runtimeId>` to receive live notifications and results for a runtime. The connection is tied to the runtime's lifecycle — when the last client disconnects, the runtime is destroyed.

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
