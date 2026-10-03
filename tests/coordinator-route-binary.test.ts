import { afterEach, describe, expect, it } from "vitest";

// The runtimes in these tests are on loopback, which the SSRF guard blocks by
// default. Set before anything reads the policy (it is cached on first read).
process.env.HKP_ALLOW_PRIVATE_RUNTIMES = "true";

import { BoardSession } from "../src/coordinator/session";
import { MessagePurpose, decodeYasMessage, encodeYasBinary } from "../src/yas";
import { StubRuntime, startStubRuntime } from "./stubRuntime";

/**
 * A result handed from one runtime to the next by the coordinator keeps its
 * form: bytes arrive as bytes, JSON as JSON.
 */
describe("coordinator routing between runtimes", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length) {
      await cleanups.pop()?.();
    }
  });

  async function chain(): Promise<[StubRuntime, StubRuntime]> {
    const first = await startStubRuntime("rt-first");
    const second = await startStubRuntime("rt-second");
    cleanups.push(first.close, second.close);

    const session = new BoardSession("board-1", "user-1", {
      boardName: "board-1",
      runtimes: [
        { id: "rt-first", name: "First", type: "rest", url: first.url },
        { id: "rt-second", name: "Second", type: "rest", url: second.url },
      ],
      services: { "rt-first": [], "rt-second": [] },
    });
    cleanups.push(async () => session.destroy());
    await session.start();
    return [first, second];
  }

  async function arrived(runtime: StubRuntime, count: number): Promise<void> {
    const deadline = Date.now() + 5000;
    while (runtime.received.length < count) {
      if (Date.now() > deadline) {
        throw new Error(`only ${runtime.received.length} frames arrived`);
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  it("hands bytes on as a binary frame", async () => {
    const [first, second] = await chain();
    const bytes = Buffer.from([0xff, 0xfb, 0x90, 0x00, 1, 2, 3]);

    first.emit(encodeYasBinary(bytes, MessagePurpose.RESULT));
    await arrived(second, 1);

    const [{ raw, isBinary }] = second.received;
    expect(isBinary).toBe(true);
    const frame = decodeYasMessage(raw);
    expect(frame?.purpose).not.toBe(MessagePurpose.NOTIFICATION);
    expect(frame?.data).toEqual(bytes);
  });

  it("keeps the order of the results it hands on", async () => {
    const [first, second] = await chain();
    const chunks = Array.from({ length: 20 }, (_, i) => Buffer.alloc(8, i));

    for (const chunk of chunks) {
      first.emit(encodeYasBinary(chunk, MessagePurpose.RESULT));
    }
    await arrived(second, chunks.length);

    expect(second.received.map(({ raw }) => decodeYasMessage(raw)?.data)).toEqual(
      chunks,
    );
  });

  it("still hands JSON on as JSON", async () => {
    const [first, second] = await chain();

    first.emit(JSON.stringify({ type: "result", data: { a: 1 } }));
    await arrived(second, 1);

    const [{ raw, isBinary }] = second.received;
    expect(isBinary).toBe(false);
    expect(JSON.parse(raw.toString())).toEqual({
      type: "processRuntime",
      params: { a: 1 },
    });
  });
});
