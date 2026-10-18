import { describe, expect, it } from "vitest";
import path from "node:path";
import type { HarnessAdapter, HarnessDescriptor } from "../src/harness-runtime/contracts.js";
import type { CapabilityContext } from "../src/orchestration-control-mcp.js";
import {
  BUILTIN_HARNESS_DESCRIPTORS,
  HarnessRegistry,
  installedHarnessCandidates,
  resolveHarnessExecutable
} from "../src/harness-runtime/registry.js";
import { harnessExecutableLaunch } from "../src/harness-runtime/adapters/adapter-utils.js";
import {
  HarnessPurposeUnsupportedError,
  HarnessRuntimeError,
  UnknownHarnessError
} from "../src/harness-runtime/errors.js";
import { toolsFor } from "../src/orchestration-control-mcp.js";

const descriptor = (id: string, isDefault = false): HarnessDescriptor => ({
  schemaVersion: 1,
  id,
  label: id,
  adapterVersion: "test",
  nativeProtocol: "responses",
  purposes: ["workflow"],
  executableEnv: `FIXTURE_${id.toUpperCase()}`,
  defaultCommand: id,
  default: isDefault,
  notes: "fixture",
  capabilities: {
    structuredEvents: true,
    toolResults: true,
    durableSession: true,
    permissionPrompts: ["workspace", "compute", "yolo"],
    workspaceInputs: true,
    autoSkills: true,
    officialEvents: true,
    toolEvents: true,
    usageEvents: true,
    readOnlyExplainer: false,
    webSearch: false,
    skills: false,
    mcp: false
  }
});

const adapter = (item: HarnessDescriptor): HarnessAdapter => ({
  descriptor: item,
  resolveExecutable: async () => "/fixture/bin",
  fingerprint: async () => "fixture",
  run: async () => ({ handoff: "fixture" }),
  createSession: (_request, _inputs, generation, durable) => ({
    schemaVersion: 1,
    harnessId: item.id,
    adapterVersion: item.adapterVersion,
    generation,
    nativeId: "fixture-session",
    durable,
    createdAt: "2000-01-01T00:00:00.000Z"
  }),
  validateNativeSession: () => true
});

describe("HarnessRegistry", () => {
  it("requires exactly one default and rejects duplicate IDs", () => {
    expect(() => new HarnessRegistry([descriptor("one")])).toThrow(/exactly one default/);
    expect(() => new HarnessRegistry([descriptor("one", true), descriptor("one")])).toThrow(/Duplicate/);
    expect(() => new HarnessRegistry([{ ...descriptor("one", true), userSelectable: false }]))
      .toThrow(/default and non-selectable/);
  });

  it("resolves adapters and purpose through one catalog", () => {
    const item = descriptor("fixture", true);
    const registry = new HarnessRegistry([item], [adapter(item)]);
    expect(registry.defaultHarnessId()).toBe("fixture");
    expect(registry.adapter("fixture", "workflow").descriptor.id).toBe("fixture");
    expect(() => registry.adapter("fixture", "explainer")).toThrow(HarnessPurposeUnsupportedError);
    expect(() => registry.adapter("missing", "workflow")).toThrow(UnknownHarnessError);
  });

  it.each([null, "text", [], ["image"], ["text", "text"], ["text", "video"]].map(formats => ({ formats })))("rejects invalid declared Explainer formats: %j", ({ formats }) => {
    const item = descriptor("fixture", true);
    item.capabilities.explainerInputFormats = formats as NonNullable<HarnessDescriptor["capabilities"]["explainerInputFormats"]>;
    expect(() => new HarnessRegistry([item])).toThrow(/explainer input formats/);
  });

  it("advertises Explainer for all built-in read-only adapters", () => {
    const byId = Object.fromEntries(
      BUILTIN_HARNESS_DESCRIPTORS.map((item) => [item.id, item])
    );
    expect(byId["claude-code"]?.purposes).toContain("explainer");
    expect(byId["claude-code"]?.capabilities.readOnlyExplainer).toBe(true);
    expect(byId["claude-code"]?.capabilities.explainerInputFormats).toEqual(["text", "image", "pdf"]);
    expect(byId["claude-code"]?.userSelectable).toBe(false);
    expect(byId.codex?.purposes).toContain("explainer");
    expect(byId.codex?.capabilities.readOnlyExplainer).toBe(true);
    expect(byId.codex?.explainerIsolation).toBe("adapter-read-only-tools");
    expect(byId.codex?.capabilities.explainerInputFormats).toEqual(["text"]);
    for (const id of ["pi", "dsh"]) {
      expect(byId[id]?.purposes).toContain("explainer");
      expect(byId[id]?.capabilities.readOnlyExplainer).toBe(true);
      expect(byId[id]?.explainerIsolation).toBe("adapter-read-only-tools");
      expect(byId[id]?.capabilities.explainerInputFormats).toEqual(["text"]);
    }
  });

  it("retains Main control and Web MCP infrastructure without Agent shell proxy metadata", () => {
    const byId = Object.fromEntries(
      BUILTIN_HARNESS_DESCRIPTORS.map((item) => [item.id, item])
    );
    expect(byId.codex?.route).toEqual({ requireMainControlTools: true });
    expect(byId["claude-code"]?.route).toMatchObject({ requireMainControlTools: true });
    expect(byId.dsh?.route).toEqual({ webSearchMcp: true });
    expect(byId.pi?.route).toEqual({ webSearchMcp: true });
  });

  it("advertises Web Search for every non-Claude workflow Harness", () => {
    const byId = Object.fromEntries(
      BUILTIN_HARNESS_DESCRIPTORS.map((item) => [item.id, item])
    );
    for (const id of ["codex", "dsh", "pi"]) {
      expect(byId[id]?.capabilities.webSearch).toBe(true);
    }
  });

  it("compiles the four Harness catalogs from exact permission-scoped runtime schemas", () => {
    const base: CapabilityContext = {
      secret: "catalog-secret",
      projectId: `prj_${"a".repeat(32)}`,
      agent: "main",
      invocationId: "inv_catalog",
      stateVersion: 7,
      kind: "main",
      candidates: ["worker"],
      decisionBy: "main",
      allowUserIntervention: true,
      allowWorkflowReconfiguration: true,
      canComplete: true,
      stagingPath: "/runtime/control-actions.json",
      workspacePath: "/workspace"
    };
    const snapshots: Array<{
      context: CapabilityContext;
      names: string[];
      required: Record<string, string[]>;
    }> = [{
      context: base,
      names: [
        "finish_task",
        "route_to_agent",
        "publish_artifact",
        "select_display",
        "request_user",
        "apply_workflow",
        "complete_project"
      ],
      required: {
        finish_task: ["callId"],
        route_to_agent: ["callId", "target", "assignment"],
        publish_artifact: ["callId", "path", "title", "kind", "description"],
        select_display: ["callId", "primary"],
        request_user: ["callId", "message", "rationale"],
        apply_workflow: ["callId", "path", "rationale"],
        complete_project: ["callId", "rationale"]
      }
    }, {
      context: {
        ...base,
        agent: "leader",
        kind: "worker",
        candidates: [],
        allowUserIntervention: false,
        allowWorkflowReconfiguration: false,
        canComplete: false,
        collaboration: {
          nodeRunId: "nrun_catalog",
          groupRunId: "grun_catalog",
          role: "leader",
          coordinatorEpoch: 4
        }
      },
      names: ["finish_task", "assign_group_tasks", "request_group_integration", "complete_group"],
      required: {
        finish_task: ["callId"],
        assign_group_tasks: ["callId", "groupRunId", "coordinatorEpoch", "tasks"],
        request_group_integration: [
          "callId", "groupRunId", "coordinatorEpoch", "integrationOwnerAgentId"
        ],
        complete_group: ["callId", "groupRunId", "coordinatorEpoch", "output"]
      }
    }];
    const registry = new HarnessRegistry();

    for (const snapshot of snapshots) {
      const runtimeTools = toolsFor(snapshot.context);
      expect(runtimeTools.map((tool) => tool.name)).toEqual(snapshot.names);
      for (const harnessId of ["codex", "claude-code", "pi", "dsh"]) {
        const catalog = registry.nativeToolCatalog(
          harnessId,
          "scienceevolve-orchestration-control",
          runtimeTools
        );
        expect(catalog).toMatchObject({
          schemaVersion: 1,
          harnessId,
          source: "runtime-tools-list",
          naming: "runtime-name-verbatim",
          errorDelivery: "same-native-turn-structured"
        });
        expect(catalog.tools.map((tool) => tool.name)).toEqual(snapshot.names);
        for (const [index, tool] of catalog.tools.entries()) {
          expect(tool.inputSchema).toEqual(runtimeTools[index]!.inputSchema);
          expect(tool.inputSchema.required).toEqual(snapshot.required[tool.name]);
          expect(tool.annotations).toEqual(runtimeTools[index]!.annotations);
        }
      }
    }
  });

  it("rejects incomplete runtime catalogs instead of guessing names or schemas", () => {
    const registry = new HarnessRegistry();
    expect(() => registry.nativeToolCatalog("codex", "fixture", [{
      name: "read_file",
      inputSchema: undefined as unknown as Record<string, unknown>
    }])).toThrow(/omitted.*inputSchema/);
    expect(() => registry.nativeToolCatalog("pi", "fixture", [{
      name: "read_file",
      inputSchema: { type: "object" }
    }, {
      name: "read_file",
      inputSchema: { type: "object" }
    }])).toThrow(/duplicate tool/);
    expect(() => registry.nativeToolCatalog("dsh", "fixture", [{
      name: " read_file",
      inputSchema: { type: "object" }
    }])).toThrow(/unmodified runtime name/);
  });

  it.skipIf(process.platform !== "win32")(
    "resolves bundled Windows npm shims to directly launchable entrypoints",
    async () => {
      const byId = Object.fromEntries(
        BUILTIN_HARNESS_DESCRIPTORS.map((item) => [item.id, item])
      );
      for (const id of ["dsh", "pi", "claude-code"] as const) {
        const item = byId[id]!;
        const shim = installedHarnessCandidates(item)[0]!;
        const executable = await resolveHarnessExecutable(item, shim);
        expect(executable).toBeTruthy();
        expect(executable).not.toContain(`${path.sep}.bin${path.sep}`);
        expect(executable).not.toMatch(/\.(?:cmd|ps1)$/i);
        const launch = harnessExecutableLaunch(executable!, ["--version"]);
        if (/\.[cm]?js$/i.test(executable!)) {
          expect(launch).toEqual({
            command: process.execPath,
            args: [executable, "--version"]
          });
        } else {
          expect(launch).toEqual({ command: executable, args: ["--version"] });
        }
      }
    }
  );

  it("retains an unknown historical id as an explicit unavailable value", () => {
    const item = descriptor("fixture", true);
    const registry = new HarnessRegistry([item]);
    expect(registry.has("removed-harness")).toBe(false);
    expect("removed-harness").toBe("removed-harness");
  });

  it("rejects unsupported descriptor schemas and incomplete baseline capabilities", () => {
    expect(() => new HarnessRegistry([
      { ...descriptor("fixture", true), schemaVersion: 2 as 1 }
    ])).toThrow(/unsupported descriptor schema/);
    expect(() => new HarnessRegistry([{
      ...descriptor("fixture", true),
      capabilities: {
        ...descriptor("fixture").capabilities,
        structuredEvents: false
      }
    }])).toThrow(/lacks required/);
    expect(() => new HarnessRegistry([{
      ...descriptor("fixture", true),
      capabilities: {
        ...descriptor("fixture").capabilities,
        usageEvents: false
      }
    }])).toThrow(/lacks required/);
    expect(() => new HarnessRegistry([{
      ...descriptor("fixture", true),
      capabilities: {
        ...descriptor("fixture").capabilities,
        permissionPrompts: ["workspace", "workspace", "yolo"]
      }
    }])).toThrow(/lacks required/);
    expect(() => new HarnessRegistry([{
      ...descriptor("fixture", true),
      purposes: ["workflow", "workflow"]
    }])).toThrow(/invalid purposes/);
    expect(() => new HarnessRegistry([{
      ...descriptor("fixture", true),
      nativeProtocol: "invalid" as HarnessDescriptor["nativeProtocol"]
    }])).toThrow(/invalid native protocol/);
  });

  it("isolates executable discovery and fingerprint failures per Catalog entry", async () => {
    const healthy = {
      ...descriptor("healthy", true),
      route: { webSearchMcp: true }
    };
    const broken = descriptor("broken");
    const brokenAdapter = {
      ...adapter(broken),
      resolveExecutable: async () => "/private/path/that-must-not-leak",
      fingerprint: async () => { throw new Error("secret discovery detail"); }
    } satisfies HarnessAdapter;
    const registry = new HarnessRegistry(
      [healthy, broken],
      [adapter(healthy), brokenAdapter]
    );

    const catalog = await registry.publicCatalog();
    expect(catalog.find((item) => item.id === "healthy")).toMatchObject({
      available: true,
      executableFingerprint: "fixture"
    });
    const failed = catalog.find((item) => item.id === "broken");
    expect(failed).toMatchObject({
      available: false,
      availabilityReason: "Harness 可用性探测失败"
    });
    for (const entry of catalog) {
      expect(entry).not.toHaveProperty("executableEnv");
      expect(entry).not.toHaveProperty("defaultCommand");
      expect(entry).not.toHaveProperty("route");
      expect(entry).not.toHaveProperty("explainerIsolation");
    }
    expect(JSON.stringify(catalog)).not.toMatch(
      /private\/path|secret discovery|FIXTURE_(?:HEALTHY|BROKEN)|webSearchMcp/
    );
  });

  it("exposes stable safe error metadata independently of the diagnostic cause", () => {
    const cause = new Error("/private/bin failed with token fixture-secret");
    const error = new HarnessRuntimeError(
      "HARNESS_PROCESS_EXITED",
      "Harness process exited unexpectedly",
      { harnessId: "fixture", exitCode: 17, signal: null },
      { source: "process", cause, diagnosticRef: "diag-1" }
    );
    expect(error).toMatchObject({
      code: "HARNESS_PROCESS_EXITED",
      safeMessage: "Harness process exited unexpectedly",
      retryable: true,
      source: "process",
      harnessId: "fixture",
      exitCode: 17,
      signal: null,
      diagnosticRef: "diag-1"
    });
    expect(error.cause).toBe(cause);
    expect(error.safeMessage).not.toMatch(/private|secret/);
  });
});
