import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ProjectInspireWorkloadRegistry,
  registrationsFromTrace
} from "../src/inspire-workload-registry.js";

const PROJECT_ID = "prj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

describe("project Inspire workload registry", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))
    );
  });

  it("extracts successful creates without inspecting the remote start command", () => {
    const registrations = registrationsFromTrace(
      "env -u HTTP_PROXY inspire --json job create --name project-run --workspace 分布式训练空间 --group 开发区-H100-cuda12.8版本 --quota 2,40,400 --nodes 2 --command 'python train.py'",
      [
        "warning",
        JSON.stringify({
          success: true,
          data: {
            name: "project-run",
            framework_config: [
              {
                gpu_count: 2,
                instance_count: 2,
                instance_spec_price_info: {
                  gpu_info: { gpu_product_simple: "H100" }
                }
              }
            ]
          }
        })
      ].join("\n"),
      {
        projectId: PROJECT_ID,
        invocationId: "inv_trace_test",
        source: "trace-backfill",
        registeredAt: "2026-08-09T00:00:00.000Z"
      }
    );

    expect(registrations).toEqual([
      expect.objectContaining({
        projectId: PROJECT_ID,
        kind: "job",
        name: "project-run",
        workspace: "分布式训练空间",
        requestedGpuCount: 4,
        requestedAcceleratorType: "H100"
      })
    ]);
  });

  it("requires create-success evidence instead of trusting command text", () => {
    const context = {
      projectId: PROJECT_ID,
      invocationId: "inv_trace_false_positive",
      source: "trace-backfill" as const
    };
    expect(
      registrationsFromTrace(
        "sed -n '1,220p' submit.sh # inspire job create --name not-created --workspace 分布式训练空间",
        "inspire job create --name not-created --workspace 分布式训练空间",
        context
      )
    ).toEqual([]);
  });

  it("backfills every successful create emitted by a submission script", () => {
    const registrations = registrationsFromTrace(
      "GEN4_STAMP=20260809c scripts/submit_generation4.sh principals",
      [
        "Using compute group: 开发区-H100-cuda12.8版本 (8xNVIDIA H100)",
        "OK Job created: first-script-run",
        "Quota: 8,160,1800",
        "Check status with: inspire job status first-script-run --workspace 分布式训练空间",
        "Using compute group: 开发区-H100-cuda12.8版本 (8xNVIDIA H100)",
        "OK Job created: second-script-run",
        "Quota: 8,160,1800",
        "Check status with: inspire job status second-script-run --workspace 分布式训练空间"
      ].join("\n"),
      {
        projectId: PROJECT_ID,
        invocationId: "inv_trace_script",
        source: "trace-backfill"
      }
    );

    expect(registrations.map((item) => item.name)).toEqual([
      "first-script-run",
      "second-script-run"
    ]);
    expect(registrations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          workspace: "分布式训练空间",
          requestedGpuCount: 8,
          requestedAcceleratorType: "H100"
        })
      ])
    );
  });

  it("accepts an unnamed create acknowledgement but excludes dry runs", () => {
    const context = {
      projectId: PROJECT_ID,
      invocationId: "inv_trace_hpc",
      source: "trace-backfill" as const
    };
    const command =
      "inspire --json hpc create --name cpu-stage --workspace CPU资源空间 --group CPU资源-2 --quota 0,4,16 --entrypoint 'srun python stage.py'";

    expect(
      registrationsFromTrace(
        command,
        JSON.stringify({ success: true, data: { sub_code: 0, sub_msg: "" } }),
        context
      )
    ).toEqual([
      expect.objectContaining({
        schemaVersion: 2,
        kind: "hpc",
        name: "cpu-stage",
        requestedGpuCount: 0
      })
    ]);
    expect(
      registrationsFromTrace(
        `${command} --dry-run`,
        JSON.stringify({
          success: true,
          data: { dry_run: true, kind: "hpc", name: "cpu-stage" }
        }),
        context
      )
    ).toEqual([]);
  });

  it("incrementally backfills only this project's completed command events", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "scienceevolve-ledger-"));
    roots.push(root);
    const projectsRoot = path.join(root, "projects");
    const runtime = path.join(
      projectsRoot,
      PROJECT_ID,
      "runtime",
      "inv_backfill"
    );
    await fs.mkdir(runtime, { recursive: true });
    const eventsPath = path.join(runtime, "codex-events.jsonl");
    await fs.writeFile(
      eventsPath,
      `${commandEvent("first-run", "H100", 1)}\n`,
      "utf8"
    );
    const registry = new ProjectInspireWorkloadRegistry(projectsRoot);

    await registry.prepare(PROJECT_ID);
    expect(await registry.list(PROJECT_ID)).toEqual([
      expect.objectContaining({
        name: "first-run",
        workspace: "分布式训练空间",
        source: "trace-backfill"
      })
    ]);

    await fs.appendFile(
      eventsPath,
      `${commandEvent("second-run", "H200", 2)}\n`,
      "utf8"
    );
    await registry.prepare(PROJECT_ID);
    expect((await registry.list(PROJECT_ID)).map((item) => item.name)).toEqual([
      "first-run",
      "second-run"
    ]);
  });
});

function commandEvent(name: string, accelerator: string, gpuCount: number) {
  return JSON.stringify({
    type: "item.completed",
    item: {
      type: "command_execution",
      exit_code: 0,
      command: `inspire --json job create --name ${name} --workspace 分布式训练空间 --group ${accelerator}-group --quota ${gpuCount},20,200 --command 'python train.py'`,
      aggregated_output: JSON.stringify({
        success: true,
        data: {
          name,
          framework_config: [
            {
              gpu_count: gpuCount,
              instance_count: 1,
              instance_spec_price_info: {
                gpu_info: { gpu_product_simple: accelerator }
              }
            }
          ]
        }
      })
    }
  });
}
