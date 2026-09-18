import { describe, expect, it } from "vitest";

import { MapService } from "../src/services/map";

/**
 * A Map template is code: a key ending in "=" is an expression the runtime
 * compiles and runs. That is fine for something a board author wrote, and not
 * fine for anything that arrived as data.
 */

function sensingMap() {
  return new MapService({
    uuid: "m",
    serviceId: "map",
    state: { sensingMode: true },
  } as never);
}

describe("sensing a template from input", () => {
  it("does not let a field name turn data into code", () => {
    // Sensing builds a template out of input, and input arrives from wherever
    // the board is fed — an unauthenticated mount, an email body, an HTTP
    // response. None of those may decide what the runtime executes.
    const svc = sensingMap();

    svc.process({ "pwned=": "1 + 1" }, () => {});

    expect(svc.getState().template).toEqual({ pwned: "1 + 1" });
    // The value stays the string it arrived as, rather than being evaluated.
    expect(svc.process({}, () => {})).toEqual({ pwned: "1 + 1" });
  });

  it("still senses the ordinary shape of what arrived", () => {
    const svc = sensingMap();

    svc.process({ subject: "Anfrage", from: "anna@example.com" }, () => {});

    expect(svc.getState().template).toEqual({
      subject: "Anfrage",
      from: "anna@example.com",
    });
  });

  it("keeps a field whose name merely looks like a term", () => {
    // The suffix is dropped rather than the field, so an unlucky name still
    // produces the field it was meant to.
    const svc = sensingMap();

    svc.process({ "total=": 42 }, () => {});

    expect(svc.getState().template).toEqual({ total: 42 });
  });
});

describe("a template a board wrote", () => {
  it("still evaluates its expressions", () => {
    // The fix is about where a template comes from, not about what a template
    // may do — configuration is still code.
    const svc = new MapService({
      uuid: "m",
      serviceId: "map",
      state: { mode: "replace", template: { "doubled=": "params.n * 2" } },
    } as never);

    expect(svc.process({ n: 21 }, () => {})).toEqual({ doubled: 42 });
  });
});

/**
 * An address a board mentions rather than dials.
 *
 * A feed's enclosure URL is the case: it points at an endpoint whose address is
 * assigned when the board loads, so the board can only name the service and let
 * the coordinator say where it ended up.
 */
describe("map and a mount reference", () => {
  const mapWith = (state: Record<string, unknown>) => {
    const service = new MapService({
      uuid: "map-1",
      serviceId: "map",
      state,
    } as never);
    return service;
  };

  it("becomes the address once the coordinator hands one over", () => {
    const service = mapWith({
      mode: "replace",
      template: { base: "hkp-mount://library/listen" },
    });

    service.configure({ __hkpMount: "http://host:8080/hosted/abc" });

    expect(service.process({}, () => {})).toEqual({
      base: "http://host:8080/hosted/abc",
    });
  });

  it("covers a reference an expression produced, not only a written one", () => {
    const service = mapWith({
      mode: "replace",
      template: { "base=": "params.target" },
      __hkpMount: "http://host:8080/hosted/abc",
    });

    expect(service.process({ target: "hkp-mount://library/listen" }, () => {})).toEqual({
      base: "http://host:8080/hosted/abc",
    });
  });

  it("leaves a reference alone while nothing has been published", () => {
    // Visibly not an address beats an empty field that looks unfilled.
    const service = mapWith({
      mode: "replace",
      template: { base: "hkp-mount://library/listen" },
    });

    expect(service.process({}, () => {})).toEqual({
      base: "hkp-mount://library/listen",
    });
  });

  it("leaves everything that is not a reference exactly as it was", () => {
    const service = mapWith({
      mode: "replace",
      template: { url: "https://example.test/feed.xml", n: 3 },
      __hkpMount: "http://host:8080/hosted/abc",
    });

    expect(service.process({}, () => {})).toEqual({
      url: "https://example.test/feed.xml",
      n: 3,
    });
  });
});
