# magpie-our-free-model-plus

一个 Magpie 插件，把 **dsh-our-free-model** 的**账号渠道**接进 Magpie。

范围刻意收窄：**12 个账号渠道 + 自动签到 + 能正常用**。其余全部剥离。

## 它做什么

| 能力 | 状态 |
|---|---|
| 12 个账号渠道（CodeArts、CodeBuddy、WorkBuddy、LobsterAI、Qoder、Qoder 中国版、TRAE、Cline、Loomy、Raccoon、MiniMax Code、ZCode） | ✅ |
| 自动每日签到（接 Magpie 原生 `auth.checkin`：每个北京日一次、失败自动重试、结果直接显示在供应商卡片上，**需在 Magpie 里手动打开开关**） | ✅ |
| 真实推理请求（Chat Completions） | ✅ |
| 匿名免费池 / Kilo / EAC / 聚合渠道（76 家）/ 组合回退 / 省 Token / 更新器 / 公告 | ❌ 已剥离（服务、接口、控制台界面三处） |
| Gemini | ❌ 按要求排除（渠道不注册、卡片不出、模型不列、按 id 调用返回 404、控制台界面无残留） |

## 架构

和社区版（`mu-zi-lee/magpie-our-free-model`）最大的不同：**不需要 Node 子进程**，而且剥得更彻底。

社区版的前提是"上游的渠道 Worker 需要 Node API"，因此背上了下载 Node、开子进程、管道协议、轮询父进程存活等一整套机器。实测 **上游切片在 Magpie 自带的 Bun 1.4.3 下原生就能跑**（13 个渠道全部注册、真实请求返回 200），所以本插件直接在插件宿主进程内启动它。

```
magpie 插件宿主（Bun）
  └── index.mjs → src/plugin.mjs          钩子面（config / auth / provider.models）
        └── src/service.mjs               进程内启动 vendor 的上游切片
              └── vendor/ofm/…            上游 standalone 切片（原样 vendor）
                    └── 渠道 Worker        13 个渠道
```

Magpie 只看到一个 provider：`our-free-model-plus`，它的 `auth.loader` 指向本插件在回环地址上启动的本地服务。

## 目录

```
index.mjs                入口（只导出一个插件函数，magpie 的要求）
src/plugin.mjs           钩子面 + 模型映射 + 通过判定
src/service.mjs          嵌入式服务生命周期（单例、锁回收、macOS 锁守卫、范围剥离、黑名单策略）
src/channels.mjs         12 个渠道的定义与过滤（唯一事实来源）
vendor/ofm/              上游 standalone 切片（见下方「与上游的差异」）
tests/hooks.test.mjs     46 项契约测试（无需网络，不碰账号）
scripts/accept.mjs       真实账号端到端验收（会花掉凭证，见下）
scripts/e2e.mjs          全新目录端到端
```

## 与上游的差异

`vendor/ofm/` 尽量原样保留，只有两处例外，都在 `src/` 里而不是 vendor 内，方便以后同步上游：

1. **渠道范围剥离**（`scope`）—— 只有 12 个账号渠道注册、列出、可调用；匿名池、Kilo、EAC、
   聚合、组合、省 Token 全部不进服务。改动在 `vendor/ofm/packages/standalone/{service.mjs,
   channels/worker.mjs, channels/business.mjs}` 和 `web/*.js`（控制台界面）。其中
   `business.mjs` 只加了 scope 守卫（Gemini 的后台昵称修复、续期定时器，以及
   `account.create`/`account.refresh` 两个按需 RPC 都跳过不在 scope 内的渠道），
   **与上游改动不重叠**，可三方合并。
2. **macOS 陈旧锁自动回收**（`src/service.mjs` 的 `acquireLockGuard`）—— 上游的进程守卫
   只在 Windows / Linux 生效（darwin 上明确返回 `null`，因为它的 Unix Socket 方案会残留
   文件）。所以 macOS 上被强杀的 Magpie 会留下 `service.lock`，之后每次启动都 EEXIST，
   要手动删。本插件用 BSD 的 `O_EXLOCK`（`0x20`，Node 不导出这个常量）补上：内核在持有者
   退出时——**包括 `kill -9`**——自动释放，无需进程配合。守卫横跨「回收陈旧锁」和
   「创建新锁」两步，消除了两个启动者同时判定同一个陈旧锁、后者删掉前者**活锁**的竞态。

## 跑验收测试前请注意

`scripts/accept.mjs` 会**启动服务并消耗你真实的账号凭证** —— 这些 refresh token 是
单次性的，跑一次就会把社区插件（以及任何用同一批账号的东西）登出，需要重新登录。

所以它默认拒绝运行，必须显式确认：

```bash
node scripts/accept.mjs                      # 拒绝，并说明原因
OFM_ACCEPT=yes node scripts/accept.mjs       # 确认（要求社区插件已停止）
OFM_ACCEPT=yes-live node scripts/accept.mjs  # 明知社区插件在跑，仍然要跑
```

`tests/hooks.test.mjs` 不会碰账号，随便跑。

## 安装

```sh
git clone https://github.com/xiyingruyi/magpie-our-free-model-plus.git
magpie plugin add ./magpie-our-free-model-plus
```

也可以直接 `magpie plugin add xiyingruyi/magpie-our-free-model-plus` 让 Magpie 自己拉。

## 用法

在 Magpie 的 **供应商（Providers）** 页面找到 **Our Free Model Plus**，
点它那一行的登录按钮（文字是「**打开账号管理控制台（登录 12 个渠道的账号）**」）。

浏览器会自己打开账号管理控制台 —— **不需要记地址，也不需要输入任何东西**。
（万一浏览器没弹出来，登录面板里会有那条链接，复制到浏览器打开即可。）

### 账号管理控制台 —— 登录渠道账号的地方

这是最重要的一个页面：**12 个渠道的账号都在这里登录、查看、管理**。

- 从 Magpie 的登录按钮打开，浏览器自动弹出，不用输密码
- 里面每个渠道显示：账号数、模型数、模型禁用开关、签到状态

### 开启每日签到

签到走的是 **Magpie 自己的签到机制**，不是插件自带的定时器 —— 所以结果和失败原因会直接
显示在供应商卡片上，而不是只写进日志。代价是它**默认关闭**，需要手动打开一次：

- **供应商卡片上的「自动签到」（Auto check-in）开关**，或
- **设置 → 插件 → 每日签到** 那一行

打开后，Magpie 每个北京日会调用一次本插件，失败会在当天自动重试；卡片上还有一枚
**「立即签到」（Check in now）** 按钮可以随时手动跑一次。`zcode` 不在自动签到范围内
（它的积分只能在 ZCode 应用里领），所以不会被报成失败。
- `trae` 和 `cline` 现在账号数是 0 —— 在这两个渠道的卡片上点登录即可

**以后想再打开它，同样的路：回到「供应商」页面点 Our Free Model Plus 的登录按钮。**
那个入口一直都在，用过一次也不会消失，可以反复点。

每次打开给出的是一条**一次性链接（十分钟内有效、只能用一次）**。
你的服务密钥不会出现在链接里，也不会有裸地址需要你记住。

控制台是上游自带的完整网页 UI（`vendor/ofm/packages/standalone/web/`），
本插件把它原样接出来，没有重写。

> ⚠️ **切换前请先读下面的「换过去会发生什么」。**

## 换过去会发生什么

这套渠道包里的 refresh token 是**单次性**的：谁用一次，别人手上的就作废
（`invalid refresh token: 'the refresh token has been used'`）。

所以**同时跑两个插件是不可能的** —— 它们的账号是同一套。你登录 `our-free-model-plus`
的那一刻，社区插件 `our-free-model` 就会被登出。这不是 bug，是账号机制决定的。

完整的切换步骤：

1. 在应用里登录 `our-free-model-plus`。
2. 把路由组从 `our-free-model/…` 换成 `our-free-model-plus/…`
   （`magpie groups` 看有哪些组，`magpie group set <id> models=…` 改）。
3. 确认模型能用之后，把社区插件关掉：`magpie plugin off github:mu-zi-lee/magpie-our-free-model`。

第 2 步之前，`our-free-model-plus` 里的模型**不会被任何路由组使用**，所以看起来像没生效。

## 选项

```json
{ "managed": {
    "dataDir": "...",        // 默认 <magpie 配置目录>/our-free-model-plus
    "port": 0,               // 0 = 系统分配
    "refresh": true,
    "blocklist": "keep",     // "keep" 沿用旧插件的模型禁用名单；"reset" 清空，全部恢复
    "maxConcurrency": 2
} }
```

用 `magpie plugin options our-free-model-plus '<json>'` 设置。

## 两个要知道的行为

**1. 模型禁用名单会被沿用。** 社区插件里你手动禁用的模型记录在 `channel-pack/state.json` 的 `disabledModels`。本插件默认**沿用**（尊重你的选择），并会在日志里写明哪些渠道被禁了多少个模型。本机现在共 119 个模型被禁用，所以 workbuddy / qoder / qodercn / zcode 这几个渠道**一个模型都不显示**。想让它们全部回来：

```
magpie plugin options our-free-model-plus '{"managed":{"blocklist":"reset"}}'
```

然后重启 Magpie。

**2. TRAE 和 Cline 暂时没有模型，这是正常的** —— 你在渠道包里没有登录这两个账号。登录之后模型会自己出来。

**3. 登录账号会过期，但会自动续期。** 续期失败时，日志会写明是哪个账号，重新登录即可。

## 数据

数据目录默认 `<magpie 配置目录>/our-free-model-plus`，和社区插件的 `our-free-model` **互不干扰**。账号凭据存在该目录的 `channel-credentials.json` 与 `channel-pack/state.json`（0600）。

要复用社区插件里已登录的账号，把社区数据目录下的 `channel-pack/` 和 `channel-credentials.json` 复制过来即可（**先停掉社区插件**，否则 `service.lock` 会冲突）。

## 许可

MIT。上游 `vendor/ofm/` 来自 [Ebony-Vinyl/dsh-our-free-model](https://github.com/Ebony-Vinyl/dsh-our-free-model)（MIT），原样保留其许可证与出处。
