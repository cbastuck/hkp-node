/**
 * How large one message between a coordinator and what is connected to it may
 * be.
 *
 * Two limits, one derived from the other:
 *
 * - **The frame limit** is what a coordinator lets through: a value larger than
 *   it is dropped and logged as `frame-dropped`, and the connection stays — a
 *   board that lost a runtime over one large value would be wrong about what
 *   happened. `HKP_COORDINATOR_MAX_FRAME_BYTES` raises or lowers it; it is never
 *   off, because a socket that accepts anything buffers anything before a
 *   handler can look at it.
 * - **The socket ceiling** is what the WebSocket library itself accepts, on
 *   every coordinator connection — a runtime server joining, a browser
 *   attaching, and this server's own link out to a coordinator. It sits above
 *   the frame limit by a margin, so the library only refuses what the frame
 *   limit would have dropped anyway, plus the room an introduction needs: a
 *   runtime server's hello carries its registry and is not held to the frame
 *   limit. Past the ceiling the library closes the connection, which is the
 *   one answer left for a message nobody should have sent.
 *
 * The same numbers are in hkp-python (`coordinator_links.py`) and hkp-rt
 * (`link_socket.cpp`), which connect to a coordinator the way this server's
 * links do.
 */

/** As large as an asset may be on hkp-rt: room for a sample or a recording. */
export const DEFAULT_MAX_FRAME_BYTES = 64 * 1024 * 1024;

/** What an introduction may need beyond a value. */
const SOCKET_HEADROOM_BYTES = 16 * 1024 * 1024;

/** The frame limit an operator's setting names; unset or 0 is the default. */
export function frameLimitFrom(value: number | undefined): number {
  return value && value > 0 ? value : DEFAULT_MAX_FRAME_BYTES;
}

/** What the WebSocket library accepts, for a frame limit. */
export function socketCeiling(frameLimit: number = DEFAULT_MAX_FRAME_BYTES): number {
  return frameLimitFrom(frameLimit) + SOCKET_HEADROOM_BYTES;
}
