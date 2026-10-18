import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  facadeForMembers,
  projectConfig,
  projectNotification,
  readFacadeAccess,
} from "../src/coordinator/facadeAccess";
import { CloudBoardConfig } from "../src/coordinator/types";

/**
 * The live radio as its members are shown it.
 *
 * The player's address is a mount: anybody holding it can listen, and the
 * board's only way of keeping it to the people it is shared with is not to
 * tell anybody else. So what is pinned here is what a member is sent — the
 * address, how many are listening, whether the station is up — and that
 * nothing of the station's controls, the uplink's credential or the ingest
 * endpoint is in it.
 *
 * Read out of the board rather than repeated here — a copy would pass while the
 * board was broken.
 */

const BOARD = path.join(__dirname, "../../boards/live-radio-members-demo-board.json");
const board = JSON.parse(fs.readFileSync(BOARD, "utf8")) as CloudBoardConfig;

const PLAYER = "https://relay.example/hosted/0123456789abcdef0123456789abcdef";
const INGEST = "wss://relay.example/hosted/fedcba9876543210fedcba9876543210";

/** What each service would report while on air. */
function reported(runtimeId: string, uuid: string): unknown {
  const configured = (board.services[runtimeId] ?? []).find((svc) => svc.uuid === uuid)?.state;
  const live: Record<string, Record<string, unknown>> = {
    radio: { __hkpMount: PLAYER, streamUrl: `${PLAYER}/live.mp3`, listeners: 3 },
    ingest: { __hkpMount: INGEST, connections: [{ remoteAddress: "203.0.113.7" }] },
    push: { __hkpMount: INGEST, status: "connected", error: "" },
    mic: { error: "" },
  };
  return { ...(configured as object), ...live[uuid] };
}

describe("the live radio's members", () => {
  const access = readFacadeAccess(board.facade);

  it("are shown the player, and not the station", () => {
    const shown = facadeForMembers(board.facade) as {
      panels: Array<{ id: string }>;
      notices?: unknown[];
    };
    expect(shown.panels.map((panel) => panel.id)).toEqual(["listen"]);
    // The microphone's errors are the owner's to hear about.
    expect(shown.notices).toEqual([]);
  });

  it("can ask nothing of it", () => {
    // Going on air is a configure, which a member is refused anyway; with the
    // station left out they are not even offered it.
    expect([...access.processTargets]).toEqual([]);
    expect(access.named.has("mic")).toBe(false);
    expect(access.named.has("ingest")).toBe(false);
  });

  it("read the address, the count and whether the uplink is up — nothing else", () => {
    expect(Object.fromEntries([...access.sources].map(([uuid, paths]) => [uuid, [...paths].sort()])))
      .toEqual({
        radio: ["__hkpMount", "listeners", "streamUrl"],
        push: ["status"],
      });

    const config = projectConfig(board, access, reported);
    expect(config.services).toEqual({
      home: [
        {
          uuid: "push",
          serviceId: "websocket-writer",
          serviceName: "To the relay",
          state: { status: "connected" },
        },
      ],
      relay: [
        {
          uuid: "radio",
          serviceId: "http-server-subservices",
          serviceName: "Relay",
          state: { __hkpMount: PLAYER, streamUrl: `${PLAYER}/live.mp3`, listeners: 3 },
        },
      ],
    });

    const wire = JSON.stringify(config);
    expect(wire).not.toContain(INGEST);
    expect(wire).not.toContain("radio-ingest");
    expect(wire).not.toContain("Authorization");
    expect(wire).not.toContain("203.0.113.7");
    expect(wire).not.toContain("Go on air");
  });

  it("hear the uplink's state but not its errors", () => {
    expect(
      projectNotification(access, "push", { status: "reconnecting", error: "refused: 401" }),
    ).toEqual({ status: "reconnecting" });
    expect(projectNotification(access, "push", { error: "refused: 401" })).toBeUndefined();
    expect(projectNotification(access, "mic", { error: "no device" })).toBeUndefined();
  });
});

describe("a facade kept partly for its owner", () => {
  const facade = {
    layout: "columns",
    panels: [
      { id: "use", layout: { type: "text", placeholder: "for everybody" } },
      { id: "setup", visibleTo: "owner", layout: { type: "text", placeholder: "owner" } },
      {
        id: "mixed",
        layout: {
          direction: "column",
          items: [
            { type: "text", placeholder: "kept" },
            { type: "text", placeholder: "dropped", visibleTo: "owner" },
            {
              direction: "row",
              visibleTo: "owner",
              items: [{ type: "button", label: "dropped too" }],
            },
          ],
        },
      },
    ],
    tabs: [
      { id: "use", title: "Use", panels: ["use", "mixed"] },
      { id: "setup", title: "Set up", panels: ["setup"] },
      { id: "admin", title: "Admin", panels: ["use"], visibleTo: "owner" },
    ],
    defaultTab: "setup",
  };

  it("leaves a member what is everybody's, at any depth", () => {
    const shown = facadeForMembers(facade) as typeof facade;
    expect(shown.panels.map((panel) => panel.id)).toEqual(["use", "mixed"]);
    expect(JSON.stringify(shown)).not.toContain("dropped");
    expect(JSON.stringify(shown)).not.toContain("owner");
  });

  it("drops a tab left with none of its panels, and a default naming it", () => {
    const shown = facadeForMembers(facade) as typeof facade;
    expect(shown.tabs).toEqual([{ id: "use", title: "Use", panels: ["use", "mixed"] }]);
    expect("defaultTab" in shown).toBe(false);
  });

  it("leaves out a panel only an owner's tab names, rather than putting it above the tabs", () => {
    // A panel no tab names is on screen whichever tab is chosen: dropping the
    // tab and keeping the panel would show a member more, not less.
    const shown = facadeForMembers({
      layout: "columns",
      panels: [
        { id: "vote", layout: { type: "text" } },
        { id: "meeting", layout: { type: "text" } },
        { id: "status", layout: { type: "text" } },
      ],
      tabs: [
        { id: "answer", title: "Vote", panels: ["vote"] },
        { id: "organise", title: "Organise", panels: ["meeting"], visibleTo: "owner" },
      ],
      defaultTab: "answer",
    }) as { panels: Array<{ id: string }>; tabs: unknown[]; defaultTab?: string };
    expect(shown.panels.map((panel) => panel.id)).toEqual(["vote", "status"]);
    expect(shown.tabs).toEqual([{ id: "answer", title: "Vote", panels: ["vote"] }]);
    expect(shown.defaultTab).toBe("answer");
  });

  it("keeps a facade that keeps nothing for its owner as it was", () => {
    expect(facadeForMembers(board.facade)).not.toEqual(board.facade);
    const plain = { layout: "single", panels: [{ id: "a", layout: { type: "text" } }] };
    expect(facadeForMembers(plain)).toEqual(plain);
    expect(facadeForMembers(undefined)).toBeUndefined();
  });
});
