import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import { createRuntimeServer } from "../src/server";
import { httpServerSubservicesDescriptor } from "../src/services/http-server";
import { stopperDescriptor } from "../src/services/stopper";
import {
  DataTypeId,
  MessagePurpose,
  decodeYasMessage,
  encodeYasBinary,
} from "../src/yas";

/**
 * Bytes between runtimes: a pass that is bytes arrives on a runtime's socket
 * as a YAS frame, runs the pipeline as a Buffer, and a result that is bytes
 * leaves the same way.
 */

// A frame laid out by hand, the way hkp-rt and hkp-frontend write one.
function handWritten(sender: string, payload: Buffer): Buffer {
  const head = Buffer.alloc(7 + 2 + 2 + 8);
  head.write("yas0017", 0, "latin1");
  head.writeUInt16LE(MessagePurpose.RESULT, 7);
  head.writeUInt16LE(DataTypeId.BinaryData, 9);
  head.writeBigUInt64LE(BigInt(sender.length), 11);
  return Buffer.concat([head, Buffer.from(sender, "latin1"), payload]);
}

describe("YAS frames", () => {
  it("writes BinaryData exactly as the other runtimes do", () => {
    const bytes = Buffer.from([0xff, 0xfb, 0x90, 0x00, 1, 2]);
    expect(encodeYasBinary(bytes, MessagePurpose.RESULT, "abc")).toEqual(
      handWritten("abc", bytes),
    );
  });

  it("reads BinaryData as the bytes after the sender", () => {
    const bytes = Buffer.from([1, 2, 3]);
    expect(decodeYasMessage(handWritten("sender", bytes))).toEqual({
      purpose: MessagePurpose.RESULT,
      dataType: DataTypeId.BinaryData,
      sender: "sender",
      data: bytes,
    });
  });

  it("refuses what is not a frame", () => {
    expect(decodeYasMessage(Buffer.from("{\"type\":\"x\"}"))).toBeNull();
    expect(decodeYasMessage(Buffer.from("yas"))).toBeNull();
    const truncated = handWritten("sender", Buffer.alloc(0)).subarray(0, 22);
    expect(decodeYasMessage(truncated)).toBeNull();
  });

  it("leaves the data of a type it does not read undefined", () => {
    const frame = handWritten("", Buffer.from([0]));
    frame.writeUInt16LE(DataTypeId.FloatRingBuffer, 9);
    expect(decodeYasMessage(frame)?.data).toBeUndefined();
  });
});

const servers: Array<ReturnType<typeof createRuntimeServer>> = [];
const sockets: WebSocket[] = [];
const aborts: AbortController[] = [];

afterEach(async () => {
  aborts.splice(0).forEach((abort) => abort.abort());
  sockets.splice(0).forEach((socket) => socket.terminate());
  while (servers.length) {
    await servers.pop()?.stop();
  }
});

async function runtimeWith(services: Array<Record<string, unknown>>) {
  const server = createRuntimeServer({
    externalHost: "127.0.0.1",
    auth: { mode: "none" },
  });
  servers.push(server);
  await server.start();
  const response = await request(server.httpServer)
    .post("/runtimes")
    .send({ id: "rt", name: "Runtime", services })
    .expect(200);
  return { server, outputUrl: response.body.runtimes[0].outputUrl as string };
}

async function connect(outputUrl: string): Promise<WebSocket> {
  const socket = new WebSocket(outputUrl);
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
  socket.send(JSON.stringify({ type: "readwrite", id: "rt" }));
  return socket;
}

describe("a runtime socket carrying bytes", () => {
  it("answers a pass of bytes with a result of bytes", async () => {
    // No services: the result is what went in.
    const { outputUrl } = await runtimeWith([]);
    const socket = await connect(outputUrl);

    const reply = new Promise<{ raw: Buffer; isBinary: boolean }>((resolve) => {
      socket.on("message", (raw, isBinary) => {
        resolve({ raw: raw as Buffer, isBinary });
      });
    });
    const bytes = Buffer.from([0xff, 0xfb, 0x90, 0x00, 7, 8, 9]);
    socket.send(encodeYasBinary(bytes, MessagePurpose.RESULT));

    const { raw, isBinary } = await reply;
    expect(isBinary).toBe(true);
    const frame = decodeYasMessage(raw);
    expect(frame?.purpose).toBe(MessagePurpose.RESULT);
    expect(frame?.data).toEqual(bytes);
  });

  it("feeds an endpoint's stream in the order the frames arrive", async () => {
    const { server } = await runtimeWith([
      {
        serviceId: httpServerSubservicesDescriptor.serviceId,
        uuid: "radio",
        state: {
          bypass: false,
          stream: { path: "/live.mp3", contentType: "audio/mpeg" },
        },
      },
      { serviceId: stopperDescriptor.serviceId, uuid: "end" },
    ]);
    const { streamUrl } = (
      await request(server.httpServer)
        .get("/runtimes/rt/services/radio")
        .expect(200)
    ).body;

    const abort = new AbortController();
    aborts.push(abort);
    const listener = await fetch(streamUrl, { signal: abort.signal });
    expect(listener.status).toBe(200);
    const reader = listener.body!.getReader();

    const socket = await connect(
      (
        await request(server.httpServer).get("/runtimes").expect(200)
      ).body.runtimes[0].outputUrl,
    );
    // Nothing comes back: the stopper ends each pass inside the runtime.
    const replies: unknown[] = [];
    socket.on("message", (raw) => replies.push(raw));

    const chunks = Array.from({ length: 50 }, (_, i) =>
      Buffer.alloc(100 + (i % 7), i),
    );
    for (const chunk of chunks) {
      socket.send(encodeYasBinary(chunk, MessagePurpose.RESULT));
    }

    const expected = Buffer.concat(chunks);
    let heard = Buffer.alloc(0);
    while (heard.length < expected.length) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      heard = Buffer.concat([heard, Buffer.from(value)]);
    }
    expect(heard).toEqual(expected);
    expect(
      replies.filter((raw) => {
        const frame = decodeYasMessage(raw as Buffer);
        return frame?.data instanceof Buffer;
      }),
    ).toEqual([]);
  });

  it("still takes JSON frames", async () => {
    const { outputUrl } = await runtimeWith([]);
    const socket = await connect(outputUrl);
    const reply = new Promise<unknown>((resolve) => {
      socket.on("message", (raw) => resolve(JSON.parse(raw.toString())));
    });
    socket.send(
      JSON.stringify({ type: "processRuntime", params: { a: 1 }, context: null }),
    );
    expect(await reply).toEqual({ type: "result", data: { a: 1 } });
  });
});
