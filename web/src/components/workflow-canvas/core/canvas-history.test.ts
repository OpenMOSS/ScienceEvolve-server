import { describe, expect, it } from "vitest";
import { CanvasHistory, pushCanvasHistory } from "./canvas-history";
import { DEFAULT_AGENT_ORCHESTRATION, DEFAULT_AGENTS } from "../../../lib";

describe("canvas history", () => {
  it("stores immutable bounded snapshots", () => {
    const history = new CanvasHistory(2);
    history.push({ orchestration: DEFAULT_AGENT_ORCHESTRATION, agents: DEFAULT_AGENTS });
    history.push({ orchestration: DEFAULT_AGENT_ORCHESTRATION, agents: DEFAULT_AGENTS });
    history.push({ orchestration: DEFAULT_AGENT_ORCHESTRATION, agents: DEFAULT_AGENTS });
    expect(history.length).toBe(2);
    expect(history.pop()).toBeDefined();
    expect(history.canUndo).toBe(true);
    expect(history.pop()).toBeDefined();
    expect(history.pop()).toBeUndefined();
  });

  it("supports a reducer-friendly immutable helper", () => {
    const next = pushCanvasHistory([], { orchestration: DEFAULT_AGENT_ORCHESTRATION, agents: DEFAULT_AGENTS });
    expect(next).toHaveLength(1);
    expect(next[0]).not.toBe(DEFAULT_AGENT_ORCHESTRATION);
  });
});
