import { afterEach, describe, expect, it } from "vitest";

import {
  DocumentExtractService,
  setXbergModule,
  XBERG_INSTALL_HINT,
} from "../src/services/document-extract";
import { RuntimeHost } from "../src/types";
import { SecretVault } from "../src/secrets";

/**
 * What comes out of a document, and what a board can branch on.
 *
 * The extraction library is stood in for rather than installed: it is a
 * deliberately optional dependency of ~150 MB per platform, and what can be
 * wrong here is what this service asks it for and what it makes of the answer —
 * both of which are visible against a stand-in. What the library does with a
 * real PDF is its own test suite's business.
 */

type Asked = { input: any; config: any };

function stubXberg(document: unknown, errors?: unknown[]) {
  const asked: Asked[] = [];
  setXbergModule({
    extract: async (input: any, config: any) => {
      asked.push({ input, config });
      return {
        results: document ? [document as any] : [],
        errors: errors as any,
      };
    },
  });
  return asked;
}

afterEach(() => {
  setXbergModule(null);
});

function hostSpy() {
  const pushed: unknown[] = [];
  const host: RuntimeHost = {
    processFrom: async (_uuid, data) => {
      pushed.push(data);
      return data;
    },
    notify: () => {},
    currentContext: () => null,
    secrets: () => new SecretVault(),
    log: () => {},
    forwardLog: () => {},
    logSettings: () => ({ logging: false, logData: false, logLevel: "info" as const }),
    scope: () => ({ owner: "tester", boardName: "Board" }),
    emitResult: () => {},
  };
  return { host, pushed };
}

function serviceWith(state: Record<string, unknown>) {
  const { host, pushed } = hostSpy();
  const service = new DocumentExtractService({
    uuid: "extract-1",
    serviceId: "document-extract",
    state,
  } as any);
  service.setHost(host);
  const notifications: unknown[] = [];
  return {
    service,
    pushed,
    notifications,
    notify: (payload: unknown) => notifications.push(payload),
  };
}

async function settled(sink: unknown[]): Promise<any> {
  const deadline = Date.now() + 2000;
  while (sink.length === 0) {
    if (Date.now() > deadline) {
      throw new Error("nothing arrived");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return sink[0];
}

/** Runs a pass expected to pass nothing on, and confirms nothing did. */
async function quietPass(
  t: ReturnType<typeof serviceWith>,
  input: unknown,
): Promise<void> {
  t.service.process(input, t.notify);
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(t.pushed).toEqual([]);
}

function errorText(notifications: unknown[]): string {
  const found = notifications.find(
    (n: any) => typeof n?.error === "string",
  ) as any;
  return found?.error ?? "";
}

describe("document-extract input", () => {
  it("reads what http-client brought back", async () => {
    // {meta, binary} is the shape http-client and http-server-subservices
    // produce, so a fetched document pipes straight in.
    const asked = stubXberg({ content: "the text", mimeType: "application/pdf" });
    const t = serviceWith({});

    t.service.process(
      {
        meta: { contentType: "application/pdf", filename: "offer.pdf" },
        binary: new Uint8Array([1, 2, 3]),
      },
      t.notify,
    );
    await settled(t.pushed);

    expect(asked[0].input.kind).toBe("bytes");
    expect(asked[0].input.mimeType).toBe("application/pdf");
    expect(asked[0].input.filename).toBe("offer.pdf");
  });

  it("works out what it was given when nobody said", async () => {
    // A PDF arriving as bare bytes still has to reach the right extractor.
    const asked = stubXberg({ content: "x" });
    const t = serviceWith({});

    t.service.process(
      new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]),
      t.notify,
    );
    await settled(t.pushed);

    expect(asked[0].input.mimeType).toBe("application/pdf");
  });

  it("refuses input that carries no document", async () => {
    const t = serviceWith({});

    expect(t.service.process({ unrelated: true }, t.notify)).toBeNull();
    expect(errorText(t.notifications)).toContain("bytes");
  });

  it("says an empty document is empty rather than extracting nothing", async () => {
    const t = serviceWith({});

    t.service.process(
      { meta: { contentType: "application/pdf" }, binary: new Uint8Array() },
      t.notify,
    );

    expect(errorText(t.notifications)).toContain("empty");
    expect(t.pushed).toEqual([]);
  });
});

describe("document-extract OCR", () => {
  it("reads scanned pages by default, because the engine is local", async () => {
    // Leaving OCR off would hand back an empty document rather than save
    // anything: there is no per-page charge for reading one here.
    const asked = stubXberg({ content: "read from the scan" });
    const t = serviceWith({});

    t.service.process(new Uint8Array([1, 2, 3]), t.notify);
    await settled(t.pushed);

    expect(asked[0].config.disableOcr).toBeUndefined();
    expect(asked[0].config.ocr).toMatchObject({ enabled: true });
    // Not forced: a PDF that already has a text layer is not re-read.
    expect(asked[0].config.forceOcr).toBeUndefined();
  });

  it("reads only the text layer when the board says off", async () => {
    const asked = stubXberg({ content: "text layer" });
    const t = serviceWith({ ocr: "off" });

    t.service.process(new Uint8Array([1, 2, 3]), t.notify);
    await settled(t.pushed);

    expect(asked[0].config.disableOcr).toBe(true);
  });

  it("re-reads pages that already have text when told to force it", async () => {
    // What a bad text layer needs — a scan wrapped in a PDF by an office suite
    // has one, and it is worthless.
    const asked = stubXberg({ content: "read properly this time" });
    const t = serviceWith({ ocr: "force" });

    t.service.process(new Uint8Array([1, 2, 3]), t.notify);
    await settled(t.pushed);

    expect(asked[0].config.forceOcr).toBe(true);
    expect(asked[0].config.disableOcr).toBeUndefined();
  });

  it("does not run OCR on a board that said false", async () => {
    // Ignoring an unexpected type here would run OCR on a board that asked for
    // the opposite, so a boolean is read rather than dropped.
    const asked = stubXberg({ content: "text layer" });
    const t = serviceWith({ ocr: false });

    t.service.process(new Uint8Array([1, 2, 3]), t.notify);
    await settled(t.pushed);

    expect(asked[0].config.disableOcr).toBe(true);
  });

  it("passes on the engine and languages the board picked", async () => {
    const asked = stubXberg({ content: "gelesen" });
    const t = serviceWith({
      ocrBackend: "paddleocr",
      ocrLanguage: "deu, eng",
    });

    t.service.process(new Uint8Array([1, 2, 3]), t.notify);
    await settled(t.pushed);

    expect(asked[0].config.ocr).toMatchObject({
      enabled: true,
      backend: "paddleocr",
      language: ["deu", "eng"],
    });
  });

  it("leaves the choice of engine to the library when nobody picked one", async () => {
    // Its judgement is better informed than a default of ours: it can see the
    // document, and it knows which engines this build has.
    const asked = stubXberg({ content: "text" });
    const t = serviceWith({});

    t.service.process(new Uint8Array([1, 2, 3]), t.notify);
    await settled(t.pushed);

    expect(asked[0].config.ocr.backend).toBeUndefined();
    expect(asked[0].config.ocr.language).toBeUndefined();
  });
});

describe("document-extract yield", () => {
  it("calls a document sparse when little came back from it", async () => {
    // Pages, and almost no text, after whatever was tried to read them. This is
    // the branch the paid vision tier hangs off.
    stubXberg({
      content: "  Page 1  ",
      counts: { pages: 12 },
      mimeType: "application/pdf",
    });
    const t = serviceWith({});

    t.service.process(new Uint8Array([1, 2, 3]), t.notify);
    const result = await settled(t.pushed);

    expect(result.pages).toBe(12);
    expect(result.charsPerPage).toBeLessThan(10);
    expect(result.sparse).toBe(true);
  });

  it("calls a real text layer good enough", async () => {
    stubXberg({
      content: "x".repeat(4000),
      counts: { pages: 2 },
      mimeType: "application/pdf",
    });
    const t = serviceWith({});

    t.service.process(new Uint8Array([1, 2, 3]), t.notify);
    const result = await settled(t.pushed);

    expect(result.charsPerPage).toBe(2000);
    expect(result.sparse).toBe(false);
  });

  it("believes the backend's own coverage over counting characters", async () => {
    // Density can only infer which pages had text; the backend knows. A
    // document dense on two pages of twenty is still mostly a scan.
    stubXberg({
      content: "x".repeat(5000),
      counts: { pages: 20 },
      extractionConfidence: { textCoverage: 0.1, combined: 0.3 },
    });
    const t = serviceWith({});

    t.service.process(new Uint8Array([1, 2, 3]), t.notify);
    const result = await settled(t.pushed);

    expect(result.charsPerPage).toBe(250);
    // Dense enough by character count, and still sparse.
    expect(result.sparse).toBe(true);
    expect(result.textCoverage).toBe(0.1);
    expect(result.confidence).toBe(0.3);
  });

  it("does not read a page-less document as an empty one", async () => {
    // Dividing by a page count of zero is how a plain text file becomes NaN.
    stubXberg({ content: "x".repeat(500), counts: { pages: 0 } });
    const t = serviceWith({});

    t.service.process(new Uint8Array([1, 2, 3]), t.notify);
    const result = await settled(t.pushed);

    expect(result.charsPerPage).toBe(500);
    expect(result.sparse).toBe(false);
  });

  it("takes the threshold the board set", async () => {
    stubXberg({ content: "x".repeat(300), counts: { pages: 1 } });
    const t = serviceWith({ minCharsPerPage: 1000 });

    t.service.process(new Uint8Array([1, 2, 3]), t.notify);
    const result = await settled(t.pushed);

    expect(result.sparse).toBe(true);
  });
});

describe("document-extract output", () => {
  it("says when it handed over less than it read", async () => {
    // A truncated document that looked complete would be summarised as though
    // the rest did not exist.
    stubXberg({ content: "x".repeat(5000) });
    const t = serviceWith({ maxChars: 100 });

    t.service.process(new Uint8Array([1, 2, 3]), t.notify);
    const result = await settled(t.pushed);

    expect(result.text).toHaveLength(100);
    expect(result.chars).toBe(5000);
    expect(result.truncated).toBe(true);
  });

  it("leaves out what the board did not ask for", async () => {
    stubXberg({
      content: "text",
      metadata: { author: "someone" },
      tables: [{ rows: [] }],
    });
    const t = serviceWith({});

    t.service.process(new Uint8Array([1, 2, 3]), t.notify);
    const result = await settled(t.pushed);

    expect(result.metadata).toBeUndefined();
    expect(result.tables).toBeUndefined();
  });

  it("hands over tables and metadata when it did", async () => {
    stubXberg({
      content: "text",
      metadata: { author: "someone" },
      tables: [{ rows: [] }],
    });
    const t = serviceWith({ metadata: true, tables: true });

    t.service.process(new Uint8Array([1, 2, 3]), t.notify);
    const result = await settled(t.pushed);

    expect(result.metadata).toEqual({ author: "someone" });
    expect(result.tables).toHaveLength(1);
  });

  it("reports how the text was produced", async () => {
    stubXberg({ content: "text", extractionMethod: "ocr" });
    const t = serviceWith({});

    t.service.process(new Uint8Array([1, 2, 3]), t.notify);
    const result = await settled(t.pushed);

    expect(result.method).toBe("ocr");
  });
});

describe("document-extract failure", () => {
  it("passes nothing on when the document could not be read", async () => {
    // A board continuing here would summarise an empty string as though the
    // document had said nothing.
    stubXberg(null, [{ message: "encrypted, no password given" }]);
    const t = serviceWith({});

    await quietPass(t, new Uint8Array([1, 2, 3]));
    expect(errorText(t.notifications)).toContain("encrypted");
  });

  it("says how to install what it needs", async () => {
    // Nothing registered: the optional dependency is not there.
    setXbergModule(null);
    const t = serviceWith({});

    await quietPass(t, new Uint8Array([1, 2, 3]));
    expect(errorText(t.notifications)).toContain("@xberg-io/xberg");
    expect(XBERG_INSTALL_HINT).toContain("npm install");
  });
});

describe("document-extract builtin backend", () => {
  it("reads text without any dependency at all", async () => {
    const t = serviceWith({ backend: "builtin" });

    t.service.process(
      { meta: { contentType: "text/plain; charset=utf-8" }, body: "hello" },
      t.notify,
    );
    const result = await settled(t.pushed);

    expect(result.text).toBe("hello");
    expect(result.backend).toBe("builtin");
  });

  it("takes the text out of a web page", async () => {
    const t = serviceWith({ backend: "builtin" });

    t.service.process(
      {
        meta: { contentType: "text/html" },
        body:
          "<html><head><style>p{color:red}</style></head>" +
          "<body><h1>Adlon</h1><p>25 rooms &amp; breakfast</p>" +
          "<script>track()</script></body></html>",
        binary: undefined,
      },
      t.notify,
    );
    const result = await settled(t.pushed);

    expect(result.text).toContain("Adlon");
    expect(result.text).toContain("25 rooms & breakfast");
    // What these hold is markup or code, not the document's text.
    expect(result.text).not.toContain("color:red");
    expect(result.text).not.toContain("track()");
  });

  it("refuses what it cannot read rather than returning nonsense", async () => {
    // Decoding a PDF as UTF-8 would look like a successful extraction of
    // gibberish, which is worse than saying no.
    const t = serviceWith({ backend: "builtin" });

    await quietPass(t, {
      meta: { contentType: "application/pdf" },
      binary: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
    });

    expect(errorText(t.notifications)).toContain("@xberg-io/xberg");
  });
});
