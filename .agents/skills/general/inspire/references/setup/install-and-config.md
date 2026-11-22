# 安装、配置与 SII Proxy

安装、更新、OAuth 登录、账号发现和本机 SII proxy setup 都看这一份。以下账号与资源命令按 **Inspire CLI 7.2.1** 的实际帮助核对；平台任务运行看 notebook / compute workloads / resources 等业务手册，具体参数以绑定可执行文件的 CLI help 为准。

## 1. 安装

macOS + Linux 是一等公民。Windows Agent 用 WSL2；Windows 原生命令行不支持。

前置只需要 `bash`、`curl`、`tar`、Python 3.10+，以及 `uv` 或 `pipx` 任一。没有 `uv` 时先装：

```bash
curl -LsSf https://astral.sh/uv/install.sh | sh
```

安装 InspireSkill：

```bash
curl -fsSL https://raw.githubusercontent.com/realZillionX/InspireSkill/main/scripts/install.sh | bash
```

脚本会从 PyPI 安装 `inspire-skill`，把 `SKILL.md` 和 `references/` 刷到已探测到的 Agent harness，并在 macOS 上安装每日静默版本检查。常用参数：

```bash
curl -fsSL https://raw.githubusercontent.com/realZillionX/InspireSkill/main/scripts/install.sh | bash -s -- --harness claude,codex
curl -fsSL https://raw.githubusercontent.com/realZillionX/InspireSkill/main/scripts/install.sh | bash -s -- --harness antigravity,cursor,qoder
curl -fsSL https://raw.githubusercontent.com/realZillionX/InspireSkill/main/scripts/install.sh | bash -s -- --harness qoder-work,kimi-code,kimi-desktop
curl -fsSL https://raw.githubusercontent.com/realZillionX/InspireSkill/main/scripts/install.sh | bash -s -- --no-cli
curl -fsSL https://raw.githubusercontent.com/realZillionX/InspireSkill/main/scripts/install.sh | bash -s -- --no-schedule
```

Qoder Work 的 skill 目录是 `~/.qoderwork/skills/inspire/`。

Kimi Code 的 skill 目录是 `$KIMI_CODE_HOME/skills/inspire/`，未设置 `KIMI_CODE_HOME` 时默认 `~/.kimi-code/skills/inspire/`。

Kimi Desktop 的 skill 目录是 `~/Library/Application Support/kimi-desktop/daimon-share/daimon/skills/inspire/`。

安装后只查这些：

```bash
inspire --version
inspire --help
inspire update --check
```

如果 `inspire: command not found`，先确认实际安装路径。ScienceEvolve 通过 `SCIENCEEVOLVE_INSPIRE_BIN` 绑定可执行文件，修改 Shell 的 PATH 或安装项目虚拟环境不会自动切换服务。OAuth 设备授权不要求在服务器启动图形浏览器；其它操作若报告浏览器运行时缺失，应按该操作的错误与安装说明处理，不能把它当作账号未登录。

## 2. 更新

```bash
inspire update
inspire update --check
inspire update --cli-only
inspire update --skill-only
```

`--check` 仅检查上游；实际升级须在部署授权后执行。`--cli-only` 升级 CLI 包与运行时，`--skill-only` 刷新 Skill 和 references。7.2.1 的实际 update 还会扫描并提示清理旧状态，即使没有新版本；不要将升级或清理当作只读检查，也不要绕过确认删除已有过程文件。

## 3. 账号登录与代理

使用与 ScienceEvolve Server 相同的操作系统用户和 `HOME`，在服务机器上执行绑定的 CLI；以下用 `inspire` 表示该可执行文件。账号持有者完成官方 OAuth 设备授权，Agent 不读取、复制或代填密码/令牌：

```bash
inspire --version
inspire login --account your-account-alias --no-use --no-browser
inspire account check --account your-account-alias
```

保持终端开启，在自己的浏览器打开 CLI 显示的官方授权地址并完成授权；设备码过期后重新执行登录，不把设备码发给别人。已有登录且检查通过时直接使用，不必重新授权。`account add` 只用于新账号名称，已有名称会失败；它同样使用设备授权，不是用户名/密码采集入口。

`--no-use` 保留当前活动账号。先用 `inspire account current` 查看服务会使用的账号；仅在部署授权且不影响原账号活动实验时运行 `inspire account use your-account-alias`。显式 `--account` 只选择本次命令，不更改共享默认值。登录7.2.1不等于正在运行的 SII MCP 已切到该版本。

账号配置和登录态由 CLI 保存到 `~/.inspire/accounts/<account-alias>/`；账号别名不要求等于平台登录 ID。不要把配置全文、OAuth会话、密码或令牌复制到仓库、Prompt、日志或 `INSPIRE.md`。本地账号改名用 `account rename`，不得用删账号/删会话来隐藏恢复失败。

需要 SII 专用代理时，在官方登录命令的 `--proxy URL` 中指定不含凭据的代理入口，具体参数先查 `login --help`。Clash mixed port 必须使用本机实际值，例如 `http://127.0.0.1:7897`；直连校园网时无需公网代理。代理凭据不能放进命令行或文档。

诊断配置来源和代理路由使用 `inspire account check --account your-account-alias --details`；只检查本地状态时加 `--offline`。这些输出不应原样贴入公共记录。ScienceEvolve 会清除通用 HTTP(S)/ALL 代理变量；本地核对时也可仅对该命令取消它们：

```bash
env -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY \
  -u http_proxy -u https_proxy -u all_proxy \
  inspire --no-env-file account check --account your-account-alias
```

## 4. 实时资源发现与路径

登录后进行只读验证，不将登录成功等同于资源可用：

```bash
inspire account context --account your-account-alias
inspire project detail "具有能动性的科学大模型" --account your-account-alias
inspire hpc quota --workspace "CPU资源空间" --account your-account-alias
inspire image list --workspace "CPU资源空间" --account your-account-alias
inspire resources availability --workspace "CPU资源空间" --include-cpu --account your-account-alias
```

`project detail` 不带 `--workspace`；Quota、镜像和 Availability 使用实际目标 Workspace，Availability 不接受 `all`。资源名、权限、规格、镜像和余额以当前查询为准，不能从历史输出推断。

CLI 7.2.1 的 `init` 只验证/规范化当前账号配置并写入账号的 `config.toml`，不是登录后必做步骤，也不建立仓库级配置。Project、Workspace、Group、Quota、Image 均需显式传入；不使用 Workload Profile 或 Path Alias。远端 `--cwd` 使用已验证的绝对路径，文件操作路径来自当前 `SCIENCEEVOLVE_ROLE_WORKSPACE` 和同一存储池，不从账号别名或文档示例推导。

CLI 仅通过显式 `--env-file PATH` 加载 dotenv，不自动读取仓库 `.env`；ScienceEvolve 使用 `--no-env-file` 并继承服务进程环境。不要把部署配置和项目说明混成另一份凭据来源。

Notebook 连接缓存通过 `notebook connection` 命令组管理。联网 Notebook 首次使用 SSH 前显式刷新连接；受限 Notebook 的 `exec` / `shell` 走 JupyterTerminal，不为其建立绕过限制的隧道。文件流转先落到同一 `/inspire/...` 共享路径，再通过已授权的联网 Notebook 上传/下载。

## 5. SII Proxy

Clash Verge 的目标只有一个：把 `*.sii.edu.cn` 分到单独的 `SII Proxy` 组。公网环境在这个组里选 SII proxy 节点；能直连 SII 校园网时选 `DIRECT`；其它流量继续走订阅原有规则。

Clash Verge Rev 的脚本常见路径：

```text
~/Library/Application Support/io.github.clash-verge-rev.clash-verge-rev/profiles/Script.js
```

先在 Clash Verge 设置页确认本机 mixed port，再在 `Script.js` 里按下面模板合并 SII 分流逻辑。下面只是模板：节点数量、节点端口和本机 mixed port 都按自己的环境改。`<...>` 必须替换为组织分发的真实 SII proxy host、port、user、password；不要提交真实凭据。`DIRECT` 是给校园网直连使用的选项，不要删。

```javascript
var SII_PROXY_GROUP_NAME = "SII Proxy";
var SII_PROXY_NAMES = ["SII Proxy 1", "SII Proxy 2", "DIRECT"];
var SII_PROXIES = [
  {
    name: "SII Proxy 1",
    type: "socks5",
    server: "<sii-proxy-host-1>",
    port: <sii-proxy-port-1>,
    username: "<sii-proxy-user-1>",
    password: "<sii-proxy-password-1>",
    tls: false,
    udp: true,
    "skip-cert-verify": true
  },
  {
    name: "SII Proxy 2",
    type: "socks5",
    server: "<sii-proxy-host-2>",
    port: <sii-proxy-port-2>,
    username: "<sii-proxy-user-2>",
    password: "<sii-proxy-password-2>",
    tls: false,
    udp: true,
    "skip-cert-verify": true
  }
];

var SII_PROXY_GROUP = {
  name: SII_PROXY_GROUP_NAME,
  type: "select",
  proxies: SII_PROXY_NAMES
};

var SII_MANAGED_PROXY_NAMES = {
  "SII Proxy 1": 1,
  "SII Proxy 2": 1
};

function ensureArray(v) {
  return Array.isArray(v) ? v : [];
}

function forceUnshift(rules, rule) {
  var idx = rules.indexOf(rule);
  if (idx !== -1) rules.splice(idx, 1);
  rules.unshift(rule);
}

function upsertProxy(proxies, newProxy) {
  var out = [];
  for (var i = 0; i < proxies.length; i++) {
    if (proxies[i] && proxies[i].name === newProxy.name) continue;
    out.push(proxies[i]);
  }
  out.push(newProxy);
  return out;
}

function removeProxyNames(proxies, names) {
  var out = [];
  for (var i = 0; i < proxies.length; i++) {
    var p = proxies[i];
    if (p && p.name && names[p.name]) continue;
    out.push(p);
  }
  return out;
}

function resetSiiProxy(config) {
  config.proxies = removeProxyNames(ensureArray(config.proxies), SII_MANAGED_PROXY_NAMES);
  config["proxy-groups"] = ensureArray(config["proxy-groups"]).filter(function(group) {
    return group && group.name !== SII_PROXY_GROUP_NAME;
  });
}

function injectSiiProxy(config) {
  config.proxies = ensureArray(config.proxies);
  for (var i = 0; i < SII_PROXIES.length; i++) {
    config.proxies = upsertProxy(config.proxies, SII_PROXIES[i]);
  }

  config["proxy-groups"] = ensureArray(config["proxy-groups"]);
  config["proxy-groups"].unshift(SII_PROXY_GROUP);

  var rules = ensureArray(config.rules);
  forceUnshift(rules, "DOMAIN-SUFFIX,sii.edu.cn," + SII_PROXY_GROUP_NAME);
  config.rules = rules;
}

function main(config, profileName) {
  resetSiiProxy(config);
  injectSiiProxy(config);
  return config;
}
```

验证只看三件事：

```bash
lsof -iTCP:<mixed-port> -sTCP:LISTEN
curl -sS -o /dev/null -w "sii: %{http_code}\n" -x http://127.0.0.1:<mixed-port> https://qz.sii.edu.cn
inspire account check --account your-account-alias
```

如果 `qz.sii.edu.cn` 失败，先查 Clash Verge 规则里是否有 `DOMAIN-SUFFIX,sii.edu.cn,SII Proxy`，再查 `SII Proxy` 组当前选中的是可用代理还是 `DIRECT`，最后用 `inspire account check --account your-account-alias --details` 核对配置来源和代理路由；不要把网络可达当作认证成功。
