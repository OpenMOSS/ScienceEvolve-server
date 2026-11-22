# ScienceEvolve 搜索树

搜索树是项目创建时可选的探索记录，省略 `searchTree` 即关闭。创建后不能启停或替换根。它不派任务、不执行实验、不触发业务 PR，也不作为完成门禁。

Web 在新建项目或科研任务草稿中点击「搜索树规划」展开画布，也可在 Workflow 画布顶栏点击「搜索树」进入全屏编辑。两个入口共用同一份课题草稿；返回 Workflow 不会清空修改，搜索树随课题保存和启动，不包含在独立 Workflow 模板中。

搜索树复用 Workflow 的画布容器和视口计算，支持拖动空白处平移、滚轮定点缩放、缩放按钮、适应画布、拖动节点及整理布局。拖动仅调整当前视图中的位置，不改变父子关系或写入研究记录；父子关系在右侧「父方向 / 父节点」中修改。选择起点或方向后可添加子方向，在右侧编辑名称、说明与初始文件快照；新增节点会展开其父分支并定位显示。初始节点随课题保存，启动后保留相同身份与结构。

项目创建后，可在「运行 Workflow」卡片、大画布顶栏或「查看与调整 Workflow」窗口点击「搜索树」，直接展开项目当前持久化的树；这些入口读取实时节点，不使用创建时的 `searchTree.directions` 草稿作为运行结果。返回时保留原 Workflow 窗口及其编辑内容。创建时未启用搜索树的项目显示禁用的「搜索树 · 未启用」，不会自动创建或补开搜索树。

运行页「搜索树与探索记录」及上述窗口沿用同一画布，展开时每 5 秒同步当前结构，收起、关闭窗口或页面不可见时不轮询。点击节点按需读取详情；用户可修改名称、说明和父节点，并查看候选的执行状态、结果、证据、初始文件快照和分页变更历史。同步不覆盖未保存编辑；保存基于读取节点时的版本，冲突明确显示错误并保留草稿，不自动覆盖或重试。请求失败后暂停同步，可检查错误后手动刷新。

运行中只有用户可编辑方向；移动父节点同时移动整个子树，删除有子节点的节点会报错。候选由项目中当前有效调用的 Agent 登记、更新和删除，用户也可在运行页调整候选的名称、说明、父节点或删除叶节点；这些操作保留候选的其他证据字段及变更历史。

```json
{
  "searchTree": {
    "root": { "name": "研究起点", "inputFiles": ["reference.txt"] },
    "directions": [
      { "id": "speed", "kind": "direction", "name": "速度", "parentId": "root" },
      { "id": "latency", "kind": "direction", "name": "延迟", "parentId": "speed" }
    ]
  }
}
```

`inputFiles` 可省略；指定时必须是本项目初始上传材料的相对路径。根名称必填，方向可为空。结构必须单根、无环、身份唯一、父节点存在。方向不能放在候选下面。Web、Server 与 SDK 使用相同校验。

Agent 只获得按需查询索引，调用 MCP 工具 `search_tree`。用户 API 为 `POST /api/projects/:id/search-tree`；SDK 使用 `run.searchTree(request)`，无需 Web 服务。查询：

- `{"operation":"overview"}`：当前版本与节点目录，不包含候选结果正文。
- `{"operation":"node","nodeId":"cache"}`：节点详情；可加 `revision` 读取历史版本。
- `{"operation":"subtree","nodeId":"speed"}`：指定子树详情。
- `{"operation":"history","limit":20}`：更新来源与版本；用返回的 `nextBefore` 作为 `before` 翻页。
- `{"operation":"input","path":"reference.txt"}`：原始快照，含 SHA-256 与 base64 内容。

候选写入示例（`expectedRevision` 使用最近读取的版本，`requestId` 标识本次明确更新）：

```json
{
  "operation": "put",
  "requestId": "record-cache-proposal-1",
  "expectedRevision": "<metadata commit SHA>",
  "node": {
    "id": "cache", "kind": "candidate", "parentId": "latency", "name": "复用缓存",
    "goal": "减少重复计算", "source": "当前 Agent 提出的方案",
    "version": { "status": "uncommitted" },
    "execution": { "status": "not_started" }
  }
}
```

候选可保存 `change`、`parameters`、`result`、`evidence`、`evaluation`。执行状态为 `not_started/running/succeeded/failed/unknown`，成功声明需带证据；未执行想法不得带实验结果或评价。已有业务提交时使用 `version: {status:"committed",commit:"<40位 SHA>"}`，系统核对真实提交对象并保留引用；元数据提交不能冒充业务版本。保存的是有来源的记录，不证明 Agent 的科研判断客观正确。删除使用 `operation: "delete"`、`nodeId`、`requestId` 和 `expectedRevision`。

Git 开启时复用项目平台裸仓库；Git 关闭时在项目数据目录创建 `search-tree.git`，不改用户工作区。权威记录在 `refs/heads/metadata/search-tree`，通过独立索引提交；业务版本保留在 `refs/scienceevolve/search-tree/versions/`，请求回执保留为 Git refs。初始材料不可变；后续工作区改动不会改变快照。查询不产生提交，删除保留历史。没有自动远端备份或 push。

并发写入以 `expectedRevision` 检查实际版本；冲突明确失败。相同身份、相同 `requestId`、相同内容可核对原成功回执，不重复提交；复用 ID 改内容会报错。失败或结果未确认时先查询核对，不自动重试。初始快照限制为每文件 10 MiB、总计 200 MiB，拒绝链接与越界路径。

SDK 的 Workflow 配置保存相同的 `searchTree` 字段。CLI：

```bash
scievolve run search-tree PROJECT_ID request.json
```

该命令读取本地 JSON 请求并使用本地 SDK 运行时，支持与 MCP 相同的查询、更新与版本冲突语义。
