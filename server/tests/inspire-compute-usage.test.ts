import { describe, expect, it, vi } from "vitest";
import {
  emptyProjectComputeUsage,
  InspireComputeUsageCollector,
  isProjectComputeUsage
} from "../src/inspire-compute-usage.js";
import type { ProjectComputeUsage } from "../src/types.js";

const PROJECT_A = "prj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const PROJECT_B = "prj_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

describe("Inspire compute usage", () => {
  it("aggregates exact Inspire running time by accelerator and card count", async () => {
    const previous: ProjectComputeUsage = {
      source: "inspire",
      totalCardHours: 2,
      byAccelerator: [{ type: "A100", cardHours: 2 }],
      workloadCount: 1,
      activeWorkloadCount: 0,
      workloads: [
        {
          kind: "job",
          name: "deleted-history",
          workspace: "分布式训练空间",
          status: "job_succeeded",
          runningTimeMs: 3_600_000,
          accelerators: [{ type: "A100", count: 2 }],
          observedAt: "2026-08-01T00:00:00.000Z"
        }
      ],
      updatedAt: "2026-08-01T00:00:00.000Z"
    };
    const runJson = vi.fn(async (args: string[]) => {
      const name = args[4];
      if (name === "h100-run") {
        return statusJob("job_running", 4_500_000, "H100", 2);
      }
      if (name === "h200-run") {
        return statusJob("job_succeeded", 1_800_000, "H200", 1);
      }
      throw new Error(`Unexpected job: ${name}`);
    });
    const collector = new InspireComputeUsageCollector("inspire", {
      runJson,
      statusConcurrency: 2,
      registry: registry({
        [PROJECT_A]: [
          registration(PROJECT_A, "deleted-history"),
          registration(PROJECT_A, "h100-run"),
          registration(PROJECT_A, "h200-run")
        ],
        [PROJECT_B]: []
      })
    });

    const result = await collector.collect(
      new Map([
        [PROJECT_A, previous],
        [PROJECT_B, emptyProjectComputeUsage()]
      ])
    );

    expect(result.get(PROJECT_A)).toMatchObject({
      source: "inspire",
      totalCardHours: 5,
      byAccelerator: [
        { type: "H100", cardHours: 2.5 },
        { type: "A100", cardHours: 2 },
        { type: "H200", cardHours: 0.5 }
      ],
      workloadCount: 3,
      activeWorkloadCount: 1
    });
    expect(result.get(PROJECT_A)?.workloads.map((item) => item.name)).toEqual([
      "deleted-history",
      "h100-run",
      "h200-run"
    ]);
    expect(result.get(PROJECT_B)).toMatchObject({
      totalCardHours: 0,
      byAccelerator: [],
      workloadCount: 0
    });
    expect(runJson).toHaveBeenCalledTimes(2);
    expect(runJson.mock.calls.every(([args]) => !args.includes("list"))).toBe(
      true
    );
  });

  it("keeps the persisted workload ledger when a live status lookup fails", async () => {
    const previous: ProjectComputeUsage = {
      source: "inspire",
      totalCardHours: 1,
      byAccelerator: [{ type: "H100", cardHours: 1 }],
      workloadCount: 1,
      activeWorkloadCount: 0,
      workloads: [
        {
          kind: "job",
          name: "unstable-job",
          workspace: "分布式训练空间",
          status: "job_running",
          runningTimeMs: 3_600_000,
          accelerators: [{ type: "H100", count: 1 }],
          observedAt: "2026-08-01T00:00:00.000Z"
        }
      ]
    };
    const runJson = vi.fn(async (args: string[]) => {
      throw new Error("temporary platform timeout");
    });
    const collector = new InspireComputeUsageCollector("inspire", {
      runJson,
      registry: registry({
        [PROJECT_A]: [registration(PROJECT_A, "unstable-job")]
      })
    });

    const result = await collector.collect(new Map([[PROJECT_A, previous]]));

    expect(result.get(PROJECT_A)).toMatchObject({
      totalCardHours: 1,
      byAccelerator: [{ type: "H100", cardHours: 1 }],
      workloadCount: 1
    });
    expect(result.get(PROJECT_A)?.workloads[0]?.observedAt).toBe(
      "2026-08-01T00:00:00.000Z"
    );
  });

  it("does not query workloads whose registered quota is CPU-only", async () => {
    const runJson = vi.fn();
    const cpuRegistration = {
      ...registration(PROJECT_A, "cpu-only"),
      kind: "hpc" as const,
      workspace: "CPU资源空间",
      requestedGpuCount: 0
    };
    const collector = new InspireComputeUsageCollector("inspire", {
      runJson,
      registry: {
        prepare: vi.fn(async () => undefined),
        list: vi.fn(async () => [cpuRegistration])
      }
    });

    const usage = await collector.collectProject(
      PROJECT_A,
      emptyProjectComputeUsage()
    );

    expect(usage).toMatchObject({ totalCardHours: 0, workloadCount: 0 });
    expect(runJson).not.toHaveBeenCalled();
  });

  it("validates persisted compute usage records", () => {
    expect(isProjectComputeUsage(emptyProjectComputeUsage())).toBe(true);
    expect(
      isProjectComputeUsage({
        ...emptyProjectComputeUsage(),
        totalCardHours: -1
      })
    ).toBe(false);
  });
});

function registration(
  projectId: string,
  name: string
) {
  return {
    schemaVersion: 1 as const,
    projectId,
    invocationId: "inv_test",
    kind: "job" as const,
    name,
    workspace: "分布式训练空间",
    registeredAt: "2026-08-01T00:00:00.000Z",
    source: "wrapper" as const
  };
}

function registry(
  registrations: Record<string, ReturnType<typeof registration>[]>
) {
  return {
    prepare: vi.fn(async () => undefined),
    list: vi.fn(async (projectId: string) => registrations[projectId] ?? [])
  };
}

function statusJob(
  status: string,
  runningTimeMs: number,
  gpuType: string,
  gpuCount: number
) {
  return {
    success: true,
    data: {
      job: {
        status,
        running_time_ms: String(runningTimeMs),
        framework_config: [
          {
            instance_count: 1,
            gpu_count: gpuCount,
            instance_spec_price_info: {
              gpu_info: {
                gpu_product_simple: gpuType
              }
            }
          }
        ]
      }
    }
  };
}
