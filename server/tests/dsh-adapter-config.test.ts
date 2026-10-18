import { describe, expect, it } from "vitest";
import path from "node:path";
import {
  dshMcpPatch,
  dshSessionArtifactPath
} from "../src/harness-runtime/adapters/dsh-adapter.js";
import { gatewayModelContextWindow } from "../src/harness-runtime/adapters/adapter-utils.js";

const rows = [{
  name: "fixture",
  namespace: "fixture",
  transport: "streamable-http" as const,
  url: "https://mcp.example.test/rpc"
}];

describe("DSH Adapter configuration", () => {
  it("uses the selected gateway model context window and defaults legacy snapshots to 256K", () => {
    const request = {
      agent: "Writer",
      project: {
        agents: {
          Writer: {
            gatewaySnapshot: {
              modelContextWindows: { "model-a": 1_000_000 }
            }
          }
        }
      }
    } as never;
    expect(gatewayModelContextWindow(request, "model-a")).toBe(1_000_000);
    expect(gatewayModelContextWindow(request, "legacy-model")).toBe(256 * 1024);
  });

  it("matches the SDK JSONL persistence layout and escapes session IDs injectively", () => {
    expect(dshSessionArtifactPath(
      path.join(path.sep, "runtime", "dsh-home"),
      path.join(path.sep, "project space", "shared"),
      "../session~id"
    )).toBe(path.join(
      path.sep,
      "runtime",
      "dsh-home",
      "sessions",
      "--project~0020space-shared--",
      "..~002Fsession~007Eid",
      "session.jsonl.zstd"
    ));
  });

  it("uses the invocation-scoped MCP row instead of DSH's separately credentialed web provider", () => {
    const enabled = dshMcpPatch(rows, true);
    expect(enabled).toContain("- id: tool-web");
    expect(enabled).toContain("    search: false");
    expect(enabled).toContain("    fetch: false");
    expect(enabled).toContain("serverName: \"fixture\"");
  });

  it("does not expose an invocation Web MCP row when Web Search is disabled", () => {
    const disabled = dshMcpPatch([], false);
    expect(disabled).toContain("    search: false");
    expect(disabled).toContain("    fetch: false");
    expect(disabled).not.toContain("openfars-mcp-");
  });

  it("leaves turn admission to OpenFARS even without project MCP rows", () => {
    for (const patch of [dshMcpPatch(rows, true), dshMcpPatch([], false)]) {
      expect(patch).toContain("- id: tool-goal\n  disabled: true");
      expect(patch).toContain("- id: goal-round-driver\n  disabled: true");
    }
  });
});
