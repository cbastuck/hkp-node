# hkp-node

Node.js port of the Hookup realtime runtime API.

## Current scope

- Implements the REST routes consumed by the frontend realtime runtime API.
- Exposes a websocket endpoint per runtime at `ws://host:port/<runtimeId>`.
- Includes a minimal in-memory service registry with `hookup.to/service/monitor`.
- Keeps runtime and service state in memory only.

## Run

```bash
npm install
npm run dev
```

Environment variables:

- `PORT`: HTTP and websocket port. Default `8080`.
- `HOST`: Bind address. Default `0.0.0.0`.
- `EXTERNAL_HOST`: Hostname written into runtime `outputUrl`. Default `127.0.0.1`.
- `ALLOWED_ORIGINS`: CORS origin value. Default `*`.

## Supported API

- `GET /runtimes`
- `POST /runtimes`
- `DELETE /runtimes`
- `GET /runtimes/:runtimeId`
- `DELETE /runtimes/:runtimeId`
- `POST /runtimes/:runtimeId`
- `POST /runtimes/:runtimeId/rearrange`
- `GET /runtimes/:runtimeId/services`
- `POST /runtimes/:runtimeId/services`
- `GET /runtimes/:runtimeId/services/:instanceId`
- `POST /runtimes/:runtimeId/services/:instanceId`
- `DELETE /runtimes/:runtimeId/services/:instanceId`
- `GET /runtimes/:runtimeId/services/:instanceId/property/:propertyId`
- `GET /runtimes/:runtimeId/inputs`
- `GET /runtimes/:runtimeId/inputs/:inputId`

## Notes

- The initial Node port intentionally does not migrate the C++ service catalog.
- The monitor service is included as a thin compatibility target so the frontend can create a realtime service, configure it, and receive live notifications.