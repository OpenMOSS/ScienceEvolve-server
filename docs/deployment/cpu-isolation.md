# 服务与计算任务的 CPU 隔离

续租 Worker 与业务线程属于同一 Node 进程。Worker 可以避开业务线程阻塞，但仍受进程所在 cgroup 的 CPU 配额及 SQLite 写锁约束。

## 平台前提

需要 Inspire / 宿主机管理员提供一个具有 CPU controller 委派权限的父 cgroup，并在其中创建 `service` 与 `agents` 两个子组。当前运行容器的 `/sys/fs/cgroup` 为只读，应用不能自行创建或修改资源组。项目不会调用 sudo、移动其他任务或改变现有实验的资源配置。

对于独立分配的 10 核预算，可将所有本地计算及 Harness 子进程放入 `agents`，上限设置为 8 核，为 `service` 留出其余预算。父组中的其他计算进程也必须纳入计算组，否则不能保证服务获得这部分预算。共享宿主机还需由平台保证父组的 CPU 分配。

以下由管理员在已委派、无内部进程的父组中执行；`/sys/fs/cgroup/scienceevolve` 是部署时提供的路径，不能直接套用于当前只读容器：

```bash
cpu_root=/sys/fs/cgroup/scienceevolve
mkdir -p "$cpu_root/service" "$cpu_root/agents"
printf '+cpu\n' > "$cpu_root/cgroup.subtree_control"
printf '200000 100000\n' > "$cpu_root/service/cpu.max"
printf '800000 100000\n' > "$cpu_root/agents/cpu.max"
printf '1000\n' > "$cpu_root/service/cpu.weight"
printf '100\n' > "$cpu_root/agents/cpu.weight"
```

配额数值需与平台实际分配一致。服务组包含 HTTP、状态机和心跳；计算组包含全部 Harness 及其后代。它们共享平台分配的总量，分组不等于获得额外 CPU。

## 启动配置

后端启动器支持已有资源组：

```bash
OPENFARS_SERVICE_CGROUP=/sys/fs/cgroup/scienceevolve/service bash scripts/start-openfars.sh
```

**启用前还须配置各 Harness 的计算组入口。** 否则子进程会继承服务组，占用服务预算。为每个 Harness 准备一个可执行包装器，例如 Codex：

```bash
#!/usr/bin/env bash
set -euo pipefail
exec bash /path/to/ScienceEvolve-server/scripts/run-in-cpu-group.sh \
  /sys/fs/cgroup/scienceevolve/agents /absolute/path/to/real/codex "$@"
```

将对应 Harness 的 executable 配置为包装器路径，真实命令使用另一绝对路径，避免递归调用。Pi、DSH 及 SDK 的 Harness executable 使用相同方法，包装器末尾的真实程序各自替换。原生 Shell 和工具能力不变，只有进程资源组改变。独立于 Harness 启动的本地实验也必须通过 `run-in-cpu-group.sh` 进入计算组。

`run-in-cpu-group.sh` 只将自己移动到已存在且可写的组，然后以原 PID 执行命令。组缺失或不可写时明确失败，不宣称隔离已经生效。

## 验证

分别读取后端 PID、心跳线程以及 Harness / 实验 PID 的 `/proc/<PID>/cgroup`，确认服务与计算位于不同组。检查两组 `cpu.max`、`cpu.stat` 和 `cpu.pressure`，确认计算达到上限时服务心跳仍正常。验证健康接口应返回 HTTP 200 且 `collaboration.status=ready`；真实租约失效时返回 HTTP 503，项目显示服务中断。

代码构建不会自动应用这些宿主机设置，也不会重启现有服务或重置项目。受控恢复继续使用已有项目、原会话及执行审计记录。
