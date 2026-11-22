# 远端路径

理解共享盘作用域、存储池和挂载隔离时先看本页。路径配置按 CLI 7.2.1；调度条件和资源规格看 [`resources-and-paths.md`](resources-and-paths.md)，公网 / 内部源看 [`network-and-sources.md`](network-and-sources.md)。

## 1. 路径不是调度条件

远端路径只回答“文件在哪里”，不回答“任务在哪里跑”。`workspace`、`project`、`group`、`quota`、`image` 是独立的调度参数。CLI 7.2.1 不提供 Path Alias 或 Workload Profile，也不读取仓库级路径配置；`--cwd` 和远端文件参数使用经过验证的绝对路径。

### ScienceEvolve 动态存储归属

ScienceEvolve Execution Agent 不预设固定存储池。每次创建 Workload 前，以运行时注入的 `SCIENCEEVOLVE_ROLE_WORKSPACE` 为唯一当前工作区事实：

1. 规范化 `SCIENCEEVOLVE_ROLE_WORKSPACE` 的真实路径，并确认它位于 `SCIENCEEVOLVE_INSPIRE_WORKSPACE_ROOT` 边界内。不使用当前 shell 的偶然 `cwd`、历史会话或文档示例代替这两个运行时事实。
2. 从真实工作区的 `/inspire/<tier>/...` 前缀提取 `<tier>`。这个值由当前部署决定，Skill 不写死任何存储池名称。
3. 任务源码、启动脚本、工作目录、输入、Checkpoint、日志和结果默认位于该工作区或其子目录。提交前检查 `--cwd`、命令文本和所有显式输入输出路径，不得静默切换到其他 `<tier>`。
4. 将已验证的绝对路径传给 `--cwd` 和远端文件参数；不使用 `me:<repo>` 等缩写，也不从账号别名推导个人目录。
5. 无法解析真实工作区、路径不在允许边界内、存储池不一致，或目标 Workload 看不到该项目路径时，停止创建并向用户说明。只有用户明确要求跨存储池，并已确认目标路径在当前项目可见时，才能偏离默认归属。

## 2. 路径作用域

| 作用域 | 路径形状 | 定位 |
| --- | --- | --- |
| 项目个人 | `/inspire/<tier>/project/<topic>/<path-user>/...` | 每项目、每账号一份，适合代码、脚本、调试输出 |
| 项目公共 | `/inspire/<tier>/project/<topic>/public/...` | 项目成员共享，适合数据集、权重、批量结果、checkpoint |
| 全局个人 | `/inspire/<tier>/global_user/<path-user>/...` | 跨项目个人盘，适合小工具和中转 |
| 全局公共 | `/inspire/hdd/global_public/...` | 全平台共享，普通账号通常只读 |

`<path-user>` 是共享盘返回的个人目录名，不一定等于登录 ID。路径事实以文件页 Browser API 发现结果为准。

## 3. 存储池

| 池 | 项目路径前缀 | 定位 |
| --- | --- | --- |
| SSD `gpfs_flash` | `/inspire/ssd/project/<topic>/` | 训练 Hot Path、活跃工作集、Checkpoint 热点 |
| HDD `gpfs_hdd` | `/inspire/hdd/project/<topic>/` | 通用空间，写前看剩余容量 |
| qb-ilm `qb_prod_ipfs01` | `/inspire/qb-ilm/project/<topic>/` | 大容量，顺序读带宽接近 SSD |
| qb-ilm2 `qb_prod_ipfs02` | `/inspire/qb-ilm2/project/<topic>/` | 新的大容量存储池；是否使用以当前工作区和项目路径事实为准 |

`global_public` 只在 HDD。需要 SSD 或 Qb-Ilm 速度时，优先走项目个人或项目公共路径。

## 4. 挂载隔离

实例只挂自身所在项目的 Fileset。其它项目的 `/inspire/{hdd,ssd,qb-ilm,qb-ilm2}/project/<others>/` 在该实例里通常不存在，`ls` 报 `No such file` 不是权限问题。

跨项目搬小文件时，在两个项目各起一个 Notebook，用全局个人路径中转。大数据集或全量 Checkpoint 超出个人 Quota 时，联系项目管理员处理。

## 5. 路径核验与记录

在项目 `INSPIRE.md` 中记录不含凭据的目录约定；实际提交仍需核对运行时工作区和目标实例的挂载可见性。`notebook exec --cwd` 要求远端绝对目录；SCP 远端相对路径依赖远端 Shell，不能作为可复现项目路径。共享盘文件位置不授予其他项目访问权限。
