import { describe, expect, it, vi } from "vitest";
import request from "supertest";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/app.js";
import { EventHub } from "../src/event-hub.js";
import { ProjectStorage } from "../src/storage.js";
import type { Orchestrator } from "../src/orchestrator.js";
import type { SkillCatalog } from "../src/skill-catalog.js";
import type { ProjectState } from "../src/types.js";

describe("execution summary API", () => {
  it("checks project and invocation, returns background state, and forwards only explicit retry", async () => {
    const eventHub = new EventHub();
    const storage = new ProjectStorage(path.join(os.tmpdir(), "summary-api-unused"), eventHub);
    const projectId = "prj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    vi.spyOn(storage, "tryLoadState").mockImplementation(async (id) => id === projectId ? { id } as ProjectState : undefined);
    const ensure = vi.fn(async () => ({ invocationId: "inv_saved", status: "queued" as const, sourceHash: "hash", updatedAt: "now" }));
    const dependencies = { storage, eventHub, orchestrator: {} as Orchestrator, skills: {} as SkillCatalog,
      config: { modelSuggestions: [], maxEventHistory: 10 } };
    const app = createApp({ ...dependencies, executionSummaries: { ensure } });
    const endpoint = `/api/projects/${projectId}/execution-summaries/inv_saved`;
    expect((await request(app).post(endpoint).send({ output: "ignored client output" })).body.status).toBe("queued");
    expect(ensure).toHaveBeenLastCalledWith(projectId, "inv_saved", false);
    await request(app).post(endpoint).send({ retry: true }).expect(200);
    expect(ensure).toHaveBeenLastCalledWith(projectId, "inv_saved", true);
    await request(app).post(endpoint.replace("inv_saved", "invalid")).expect(400);
    await request(app).post(endpoint.replace(projectId, "prj_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")).expect(404);
    expect(ensure).toHaveBeenCalledTimes(2);
    await request(createApp(dependencies)).post(endpoint).expect(503);
  });
});
