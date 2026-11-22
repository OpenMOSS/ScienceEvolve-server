# Workflow 图册截图

此工具只用于文档展示，不注册应用示例页，不修改可执行 Workflow。使用真实前端 `CanvasWorld`、`CanvasNodes`、`CanvasEdges`、语义适配器和路由器，单独设置打印卡片尺寸、字号与坐标；**不是完整应用窗口截图**。

- 方法导读来自 `catalog.mjs`，不写入路由。
- 总览保留全部外层边；阶段图是所选节点的真实诱导子图；组内图保留实际并行入口。
- 画布缩放固定 1，标题 16 CSS px、长名称换行，截图设备像素比 1.5。
- 浏览器检查节点数量、尺寸、标题溢出、节点重叠和边界裁切；准备阶段检查路由器采样点不穿过其他节点。
- 这些几何检查不是人工逐像素审美验收，也不证明边的交叉数量最优。
- 不运行后端、模型、MCP 或研究任务；浏览器只访问临时 loopback 服务器。

## 重新生成

使用项目已有的 `tsx`、`esbuild`、React 依赖，以及环境已安装的 Playwright/Chromium。不自动安装依赖或下载浏览器。输出先放本次专属 `.scratch/`，检查后再更新正式图片。

```sh
# 在主仓库根目录运行，以下路径须替换为真实环境路径。
node_modules/.bin/tsx scripts/workflow-gallery/prepare.mts \
  .scratch/gallery-task/prepared /absolute/sdk-repository

node scripts/workflow-gallery/capture.mjs \
  .scratch/gallery-task/prepared .scratch/gallery-task/images \
  /absolute/playwright/index.mjs /absolute/chromium

node scripts/workflow-gallery/docs.mjs \
  . .scratch/gallery-task/images main

node --test example/tests/workflow-gallery.test.mjs example/tests/workflow-topology.test.mjs
```

`prepare.mts` 和 `capture.mjs` 的输出目录必须不存在。`docs.mjs` 在截图完成后更新正式画廊、图片及 manifest；不会修改原始 Workflow。SDK 应以自己的配置重截，不把 main 的源哈希套到 SDK 文件：

```sh
node_modules/.bin/tsx scripts/workflow-gallery/prepare.mts \
  .scratch/gallery-task/prepared-sdk /absolute/sdk-repository /absolute/sdk-repository
# 对 prepared-sdk 单独 capture，再运行：
node scripts/workflow-gallery/docs.mjs \
  /absolute/sdk-repository .scratch/gallery-task/images-sdk sdk
```

`capture.mjs` 显式开启 Chromium sandbox。root 环境请使用有可写 HOME 的非特权账号运行截图；**不要添加 `--no-sandbox`**。临时目录需按实际账号权限准备。脚本在异常时关闭浏览器和服务器，不会尝试绕过限制。

`manifest.json` 保留实际源配置／图片哈希、日期、浏览器版本、前端 commit 及关键文件哈希、节点覆盖和尺寸。两仓库的画廊分别记录本仓库源文件；共用前端哈希指向主仓库。图片内的哈希为各自源文件的前 12 位。

任务完成后可清理自己创建的截图中间件、浏览器缓存与导出 JSON；正式图片、manifest、脚本和回归测试应保留。
