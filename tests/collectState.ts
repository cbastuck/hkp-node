import WebSocket from "ws";

export type SeenNotification = { instanceId: string; payload: any };

/**
 * Everything the runtime socket carried while `run` ran, flow notifications
 * included. Use it to count deliveries — one channel too many shows up here as
 * duplicates, one too few as nothing at all.
 *
 * A pipeline runs to completion before the call that drove it returns, so the
 * drain after `run` only has to cover the trip to the socket.
 */
export async function collectNotifications(
  wsUrl: string,
  run: () => Promise<void>,
  drainMs = 150,
): Promise<SeenNotification[]> {
  const socket = new WebSocket(wsUrl);
  const seen: SeenNotification[] = [];

  socket.on("message", (raw) => {
    const message = JSON.parse(raw.toString());
    if (message.type !== "notification") {
      return;
    }
    try {
      seen.push({
        instanceId: message.instanceId,
        payload: JSON.parse(message.value),
      });
    } catch {
      /* not JSON: not something these tests assert on */
    }
  });

  await new Promise((resolve, reject) => {
    socket.on("open", resolve);
    socket.on("error", reject);
  });

  await run();
  await new Promise((resolve) => setTimeout(resolve, drainMs));
  socket.close();

  return seen;
}

/** How often `instanceId` reported the given flow state. */
export function flowCount(
  seen: SeenNotification[],
  instanceId: string,
  state: string,
): number {
  return seen.filter(
    (entry) =>
      entry.instanceId === instanceId &&
      entry.payload?.__internal?.state === state,
  ).length;
}

/**
 * Collects a service's reported state off the runtime socket — the channel an
 * attached board watches — until `done` is satisfied. Flow (`__internal`)
 * notifications are skipped: those report the pipeline running, not what a
 * service has to say about itself.
 */
export function collectState(
  wsUrl: string,
  instanceId: string,
  done: (seen: any[]) => boolean,
  onOpen: () => void | Promise<void>,
  timeoutMs = 5000,
): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl);
    const seen: any[] = [];
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error(`timed out; saw ${JSON.stringify(seen)}`));
    }, timeoutMs);

    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      if (
        message.type !== "notification" ||
        message.instanceId !== instanceId
      ) {
        return;
      }
      let payload: any;
      try {
        payload = JSON.parse(message.value);
      } catch {
        return;
      }
      if (payload?.__internal) {
        return;
      }
      seen.push(payload);
      if (done(seen)) {
        clearTimeout(timer);
        socket.close();
        resolve(seen);
      }
    });

    socket.on("open", () => {
      void onOpen();
    });
    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}
