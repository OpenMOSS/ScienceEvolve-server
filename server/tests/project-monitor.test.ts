import { describe, expect, it } from "vitest";
import { monitorOnce, projectSnapshot, transitionNotification } from "../scripts/monitor-projects.mjs";

const project = { id: "prj_one", title: "Research", status: "running", phase: "model:running", eventSeq: 1, artifacts: [] };

describe("project status monitor", () => {
  it("notifies once on interruption, user intervention, completion and recovery", () => {
    const running = projectSnapshot(project);
    const stopped = { ...running, status: "interrupted", phase: "collaboration:repair-required", lastError: "actual failure" };
    expect(transitionNotification(running, stopped)).toBe("stopped");
    expect(transitionNotification(stopped, { ...stopped, eventSeq: 2 })).toBeUndefined();
    expect(transitionNotification(stopped, running)).toBe("resumed");
    expect(transitionNotification({ projectId: running.projectId, observationError: "Connection refused" }, running)).toBe("observation-restored");
    expect(transitionNotification(running, { ...running, status: "retrying", phase: "user-intervention-required" })).toBe("stopped");
    expect(transitionNotification(running, { ...running, status: "completed", phase: "completed" })).toBe("completed");
    expect(transitionNotification(running, { ...running, status: "queued", phase: "collaboration:user-response" })).toBeUndefined();
    expect(transitionNotification(running, { ...running, lastError: "Main awaits a fenced decision", activeActivities: 0 })).toBe("stopped");
    expect(transitionNotification(running, { ...running, lastError: "Historical error", activeActivities: 1 })).toBeUndefined();
  });

  it("reports an unreachable project without hiding the other project's interruption", async () => {
    const snapshot = await monitorOnce({ baseUrl: "http://localhost", projectIds: ["prj_one", "prj_two"], request: async (url: string) => {
      if (url.includes("prj_one")) throw new Error("Connection refused");
      return { ok: true, json: async () => ({ project: { ...project, id: "prj_two", status: "interrupted" } }) };
    } });
    expect(snapshot.notifications.map((item: { kind: string }) => item.kind)).toEqual(["monitor-error", "stopped"]);
    expect(snapshot.allCompleted).toBe(false);
  });

  it("rejects mismatched or incomplete observations instead of reporting success", async () => {
    expect(() => projectSnapshot({ id: "prj_one", status: "running" })).toThrow("missing");
    const snapshot = await monitorOnce({ baseUrl: "http://localhost", projectIds: ["prj_two"], request: async () => ({
      ok: true, json: async () => ({ project })
    }) });
    expect(snapshot.notifications[0].kind).toBe("monitor-error");
    expect(snapshot.allCompleted).toBe(false);
  });
});
