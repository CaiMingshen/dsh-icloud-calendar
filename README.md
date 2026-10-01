# dsh-icloud-calendar

让 **DeepSeek Harness（DSH）** 通过标准 **CalDAV** 读写你的 **苹果 iCloud 日历**：查日历、按时间窗读事件（自动展开重复日程）、建事件、以及带四道闸门的删除。

> English: [README.en.md](./README.en.md)

**状态**：代码可编译、**77 项测试全绿**（含 DAV 读取器、内存 CalDAV 假服务器与一套真实 cordis 挂载测试，不需要真实账号）。**尚未用真实 iCloud 账号做过端到端验收** —— 首次使用请先跑 `dsh-icloud-calendar status --probe`，并用一个单独的测试日历验证写入。

---

## 为什么是 CalDAV

苹果没有公开 iCloud 日历的 REST API，EventKit 只在 macOS 本机可用。跨平台唯一可行的自动化入口就是 **CalDAV（RFC 4791）**：

```
DSH 插件 → HTTPS → https://caldav.icloud.com/ → 你的 iCloud 日历
认证：Apple ID（邮箱）+ App 专用密码
```

所以这个插件在 Windows / macOS / Linux 上行为一致。

---

## 安装

需要 DSH `>=0.2.0-rc.2`、Node `^22.19 || >=24`。

```bash
# 1) 从本地 checkout 安装（开发/自用首选）
dsh plugin --profile web add /绝对路径/dsh-icloud-calendar

# 2) 直接从 GitHub 安装（仓库已提交构建产物 lib/，不需要任何构建授权）
dsh plugin --profile web add github:<你的用户名>/dsh-icloud-calendar

# 3) 从 npm 安装（发布后）
dsh plugin --profile web add dsh-icloud-calendar
```

验证装载成功：

```bash
dsh --profile web --dump-config | Select-String icloud-calendar
```

应能看到 `# == dsh-icloud-calendar` 这一层，以及 `icloud-calendar-host` / `icloud-calendar-tools` 两行。

> **为什么把 `lib/` 也提交进仓库**：pnpm ≥10 默认拒绝执行 git 依赖的 `prepare` 脚本，源码安装会失败并要求用户写 `allowBuilds`（等于授权该包在安装期执行代码）。预构建产物让 `github:` 安装零授权、零构建。

---

## 配置

插件是 **bundle**：`dsh.bundle.patch` → `cordis.patch.yml` 插入两行。

| 行 | 作用 |
| --- | --- |
| `dsh-icloud-calendar/host` | 连接、缓存、策略：注册 `ctx.icloudCalendar` 服务 |
| `dsh-icloud-calendar/tools` | 把服务暴露成 5 个模型可见的工具 |

只装 host 行不装 tools 行，日历就能被代码使用但对模型不可见 —— 这是一个有用的开关。

完整可复制的配置见 [`examples/cordis.patch.example.yml`](./examples/cordis.patch.example.yml)。常用项：

```yaml
- insert:
    - id: icloud-calendar-host
      name: 'dsh-icloud-calendar/host'
      config:
        account: 'you@example.com'      # 也可留空，用 $ICLOUD_ACCOUNT
        secretEnv: ICLOUD_APP_PASSWORD  # 密码所在的环境变量名
        secretSource: auto              # auto | env | store
        allowWrites: true
        allowDeletes: false             # 默认关闭删除
        maxDeletesPerCall: 1
        timeoutMs: 30000
        retries: 2
        proxyUrl: ''                    # 例：http://127.0.0.1:7890
    - id: icloud-calendar-tools
      name: 'dsh-icloud-calendar/tools'
```

配置里**没有密码字段**，这是故意的：profile 补丁是磁盘上的文件，把 App 专用密码写进去就等于绕过了系统凭据存储。改配置需要重载 profile（这些字段没有标 `.volatile()`，因此不会出现在设置页表单里）。

`serverUrl` 的取值规则：**远程主机必须 HTTPS**；只有 `127.0.0.1` / `::1` / `localhost` 允许明文 HTTP —— 自建 CalDAV（Radicale、Nextcloud、Baikal）经常就在本机跑明文，而凭据仍走 `Authorization` 头，所以只对回环开这个口子。想连局域网里的自建服务，请给它配上 HTTPS。

---

## 凭据

### 1. 生成 App 专用密码（必须）

1. 登录 <https://appleid.apple.com>
2. **登录与安全 → App 专用密码 → 生成**（形如 `abcd-efgh-ijkl-mnop`）
3. **不要用 Apple ID 登录密码** —— 开了双重认证后它必然被拒（HTTP 401）

### 2. 存放（三种来源，按 `secretSource` 决定优先级）

| 来源 | 说明 |
| --- | --- |
| OS 凭据存储 | Windows → **DPAPI**（绑定当前用户）；macOS → **钥匙串**（`security`）；Linux → **libsecret**（`secret-tool`） |
| 环境变量 | `secretEnv` 指定的变量，默认 `ICLOUD_APP_PASSWORD` |
| 都不配 | 报错点名缺哪个变量、并给出下一步命令，绝不回显密文 |

`auto`（默认）**先查系统凭据存储，再查环境变量**；`env` / `store` 可各自锁定。

写入系统凭据存储：

```powershell
# Windows：密码只经过 stdin，不进 argv、不进 shell 历史
$p = Read-Host 'App 专用密码'
$p | node lib/cli.js login --account you@example.com
```

```bash
# macOS / Linux
read -rs -p 'app-specific password: ' P && printf '%s' "$P" | node lib/cli.js login --account you@example.com
```

安全边界：

- 密钥**永不**进入 profile 配置、工具参数、session log 或错误信息；
- DPAPI 明文只交给 PowerShell 子进程的 stdin，磁盘上是 DPAPI 密文（`%LOCALAPPDATA%\dsh-icloud-calendar`，`.gitignore` 已排除 `*.dpapi.xml`）；
- Linux 走 `secret-tool` 时密码走 stdin；**macOS 钥匙串是唯一例外**，`security` 只接受命令行参数，argv 会短暂可见（已在代码注释中标注）；
- 环境变量名刻意不叫 `*PASSWORD*` 之外的花样（`DSH_CALENDAR_PASSWORD` 那类名字会被部分日志脱敏工具整行打码，反而破坏文件）——本插件用 `ICLOUD_APP_PASSWORD`，DPAPI 子进程内部用 `DSH_ICLOUD_STORE_FILE`。

---

## 工具（模型可见）

| 工具 | 说明 |
| --- | --- |
| `calendar_status` | 配置/凭据来源/连通性自检，**不返回密码** |
| `calendar_list_calendars` | 列出日历（名称、集合 URL、颜色、时区、组件类型）；iCloud 提醒事项列表会标 `supportsEvents=false` |
| `calendar_list_events` | 按时间窗读事件，**重复日程展开为逐条**，可取消的实例被跳过；返回 `uid` 供删除使用 |
| `calendar_create_event` | 建事件；两个日期=全天事件（end 为排他），两个带偏移的时间戳=定时事件 |
| `calendar_delete_events` | 删除，**默认干跑**，四道闸门见下 |

### 删除的四道闸门（针对"一次误删 8 条"）

1. **总开关**：`allowDeletes: false` 是默认值，不打开就没有任何删除路径；
2. **窗口必填**：`start` / `end` 必填，且删除窗口上限（默认 90 天）比读窗口（366 天）更小；
3. **精确指名**：只能给 `uid`（来自 `calendar_list_events`）或 `summaryEquals`（**完整标题、区分大小写**）——子串/模糊匹配一律拒绝；
4. **二次确认**：默认 `dryRun=true` 只报告匹配结果；真删必须 `dryRun=false` 且 `confirmCount` **等于匹配到的对象数**，同时受 `maxDeletesPerCall`（默认 1）封顶。

注意：命中重复日程时"对象数"小于"出现次数"，删除会移除**整个重复序列**，结果里会明确写出这一点。

---

## 命令行（不走模型也能用）

```bash
dsh-icloud-calendar status [--probe] [--json]
dsh-icloud-calendar login  --account you@example.com      # 密码从 stdin 读
dsh-icloud-calendar logout --account you@example.com
dsh-icloud-calendar calendars
dsh-icloud-calendar events --start 2026-01-05T00:00:00+08:00 --end 2026-01-12T00:00:00+08:00
dsh-icloud-calendar add    --summary "评审" --start 2026-01-05T09:00:00+08:00 --end 2026-01-05T10:00:00+08:00 --time-zone Asia/Shanghai
dsh-icloud-calendar delete --start 2026-01-01T00:00:00+08:00 --end 2026-02-01T00:00:00+08:00 --uid <uid>
dsh-icloud-calendar delete ... --uid <uid> --dry-run=false --yes
```

CLI 复用**同一套**客户端与删除闸门；`delete` 永远先跑一次干跑，再要求 `--yes`，所以 `--yes` 单独出现不会删掉任何没人看过的东西。

---

## 踩坑清单（实测）

| # | 坑 | 现象 | 处理 |
| --- | --- | --- | --- |
| 1 | 用登录密码 | HTTP 401，看起来像服务器故障 | 只能 App 专用密码；错误码 `CALENDAR_AUTH_FAILED` 会直接说明 |
| 2 | 每次调用新建连接 | 单次操作约 13 秒 | host 服务常驻复用连接；CLI 单进程内完成多步；读操作本身按日历串行以免被限流 |
| 3 | DPAPI 走 PowerShell | 本机实测每次读写约 9 秒 | 只在建立连接时读一次密钥并缓存；不要把凭据读取放进每步 |
| 4 | 删除慢 | 按日历全扫描，事件越多越慢 | 删除必须带日期窗口（默认 ≤90 天），不做全库扫描 |
| 5 | 删除过杀 | 模糊匹配一次删掉 8 条 | 精确匹配 + 干跑 + `confirmCount` + 上限 1 |
| 6 | 没有超时 | 网络卡住就干等 | 每请求 30s deadline，429/5xx 指数退避重试；**401 不重试**（避免锁号） |
| 7 | 时区 | 全天事件差一天、无偏移时间戳含义不明 | 无 offset 的时间戳直接拒绝；全天事件按 iCalendar 的日期字段读取，不经过本地时区 |
| 8 | 代理 | 国内直连 iCloud 可能不通 | `proxyUrl`（需要可选依赖 `undici`，未装时给出明确提示） |
| 9 | 热重载预期 | 换了插件 JS 却没生效 | 新增 bundle 可经 HMR 生效，**替换已安装包必须重启** |
| 10 | 重复日程 | 以为删的是"这一次" | 删除作用于整个对象（整个序列），结果中明确提示 |
| 11 | Reminders 列表 | 被当成日历读/写 | 若服务端公布了组件集合且不含 `VEVENT`，该集合会被跳过、显式指名则报错。但**实测中国区 iCloud 的 19 个日历全部不公布组件集合**，所以无法预判：对"提醒"集合查询一个月返回 **0 条**，代价只是多一次请求。写入该集合的行为未在本插件内验证 |
| 12 | 多日历歧义 | 不知道写进哪个日历 | 只有唯一候选时才允许省略 `calendar`，否则报错并列出候选。实测账号里有两个都叫「家庭」的日历，裸用名字会被拒绝并要求给集合 URL |
| 13 | 中国区账号的分区主机 | 以为要连 `caldav.icloud.com` | 入口仍填 `https://caldav.icloud.com/` 即可；principal/calendar-home 发现会跟着服务端给出的分区主机走。实测真实账号的日历 URL 落在 `p236-caldav.icloud.com.cn`，19 个日历全部正常 |

---

## 架构

| 文件 | 职责 |
| --- | --- |
| `src/client.ts` | CalDAV 客户端：principal/home 自动发现、calendar-query、PUT/GET/DELETE、超时与重试、可选代理 |
| `src/xml.ts` | 面向 CalDAV 多状态响应的极小 XML 读取器（命名空间前缀无关） |
| `src/ical.ts` | iCalendar 语义：时间戳校验、重复日程展开、事件构造与折行、全天事件边界 |
| `src/credentials.ts` | 跨平台凭据存储（DPAPI / 钥匙串 / libsecret / 关闭） |
| `src/config.ts` | schemastery 配置模式、默认值、凭据解析与来源说明 |
| `src/policy.ts` | 删除闸门（唯一实现，服务与 CLI 共用） |
| `src/host.ts` | cordis 服务 `ctx.icloudCalendar`：连接复用、缓存、策略 |
| `src/tools.ts` | `defineTool` 注册 5 个模型可见工具 |
| `src/cli.ts` | 独立命令行入口 |
| `tests/` | vitest：DAV 读取器（`xml.test.ts`，含"只返回第一个自闭合元素"这类回归）、内存 CalDAV 假服务器（401/503/超时）、iCalendar、删除闸门、凭据存储、以及**用真实 cordis 上下文挂载两个插件行**的激活测试 |

一个刻意的取舍：**不手填日历集合 URL**。插件走标准的 `current-user-principal → calendar-home-set → 列日历` 发现流程，所以换账号/换服务器只要改 `account`。

---

## 开发

```bash
pnpm install
pnpm typecheck     # src + tests
pnpm test          # 77 项：DAV 读取器 + mock CalDAV + 真实 cordis 挂载
pnpm build         # tsc → lib/
```

测试不需要 Apple ID、不需要网络：`tests/mock-caldav.ts` 是一个进程内 HTTP 服务器，实现了发现、REPORT、PUT、GET、DELETE，并可注入 401、连续 503、慢响应。`tests/activation.test.ts` 则用真实 `@deepseek-ai/cordis` 上下文把 host 行与 tools 行挂起来，断言服务注册、`inject` 满足、5 个工具入册、`calendar_status` 可执行、以及只读闸门生效。

### 启动验证（以及为什么"没报错"能算证据）

除单测外，还做了两层真机验证：

1. **组合层**：`dsh plugin --profile <probe> add <本包>` 后 `dsh --profile <probe> --dump-config`，能看到 `# == dsh-icloud-calendar` 层与两行；
2. **启动层**：从官方 `headless` 模板建一个临时 profile 装上本包并真实启动，进程 2.2 秒内走到 LLM 阶段、只因缺少 LLM 凭据退出（`MISSING_CREDENTIAL`），**没有任何插件行报错**。

第 2 条之所以有说服力，是因为做了**反证实验**：把 `cordis.patch.yml` 里的模块名改成不存在的路径后，启动会**直接卡在组合阶段**（600 秒不退出），而不是静默继续。也就是说"启动能走到 LLM 阶段"确实等价于"两行插件成功激活"，而不是"错误被吞了"。

3. **端到端**：把测试用的 CalDAV 服务**编译成独立进程**跑在真实 HTTP 端口上，再用**构建产物 `lib/` 里的 CLI** 走完整流程（结果见下表）。这条路径覆盖了真实的 HTTP 层、iCalendar 构造、策略闸门与退出码，而不只是单测内的函数调用。

| 命令 | 结果 |
| --- | --- |
| `status --probe` | 配置/凭据来源/连接全部正常，退出码 0 |
| `calendars` | 5 个日历：`Reminders` 标 `EVENTS=no`、`Shared` 标 `READ-ONLY=yes`、`Mixed`（VTODO+VEVENT）标 `EVENTS=yes` |
| `events` | 5 条出现：1 条单次 + 4 条 weekly 展开（`RRULE` 在窗口内正确展开） |
| `add`（09:00+08:00） | 建成 `2026-01-06T01:00:00Z`，时区正确折算 |
| `delete`（未加 `--dry-run=false`） | `DRY RUN — 1 object(s)`，什么都没删 |
| `delete`（`--dry-run=false` 但没 `--yes`） | 拒绝：`CALENDAR_UNSAFE_DELETE: Refusing to delete 1 object(s) without --yes` |
| `delete --summary-equals=E2E`（部分标题） | 匹配 0 条 —— 模糊匹配确实不存在 |
| `delete --summary-equals=E2E review --dry-run=false --yes` | `DELETED — 1 object(s)` |
| 删除后再 `events` | 新建的那条消失，原有 5 条出现完好 |
| 退出码契约 | 成功 0 / 闸门或配置问题 1 / 未知命令 2 / `help` 0 |

---

## 已知限制 / 路线图

- 没有设置页表单（配置项未标 `.volatile()`），改配置需编辑 profile 并重载；
- 暂不支持更新事件（`calendar_update_event`）与多账号同时挂载（可用多个 profile 行 + 不同 `account` 变通）；
- 重复日程的 `RRULE` 展开在客户端完成，单序列上限 `maxOccurrencesPerSeries`（默认 400），命中上限会在结果里报告；
- 未做真实 iCloud 账号的端到端验收（见文首状态说明）。

## 许可证与致谢

MIT。

设计与实现参考了同一生态里的两个开源项目（代码为独立实现，未复制）：

- [`moziforge/calendar-plugins`](https://github.com/moziforge/calendar-plugins)（Apache-2.0）—— iCloud CalDAV 的凭据与错误码处理思路；
- [`STARDUSTLC666/dsh-calendar`](https://github.com/STARDUSTLC666/dsh-calendar)（MIT）—— DSH 插件形态与多日历解析实践。

插件形态遵循官方 `cordis-plugin-development` skill 与 `docs/user/develop/basic/publish.md`。
