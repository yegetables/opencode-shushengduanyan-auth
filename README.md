# 书生·端砚 for magpie

给 [magpie](https://usemagpie.ai) 接上**书生·端砚（Intern InkStone）TokenPlan**：一个供应商，两条登录路径，墨点余额与 5 小时 / 7 天限额卡片。

- 供应商 id：`shusheng-duanyan`，模型形如 `shusheng-duanyan/glm-5.3`
- 接口：`https://discovery-api.intern-ai.org.cn/v1`（OpenAI Chat Completions；Responses 与 Anthropic 由 magpie 自己翻译过去）
- 用量：`/api/tokenplan/v1/credits/balance` → 墨点余额 + 5h / 7d 两个窗口，带重置时间
- 并发：每个账号 4 个请求（`magpie.maxConcurrency`），平台侧是每用户 50 RPM / 2M TPM、同一账号全部 Key 合并计算

## 安装

在 magpie 的**插件 → 添加插件**里粘仓库地址：

```
https://github.com/yegetables/opencode-shushengduanyan-auth
```

或者命令行：

```sh
magpie plugin add github:yegetables/opencode-shushengduanyan-auth
```

装好后在**插件**页那一行登录，然后：

```sh
magpie provider test shusheng-duanyan        # 走一遍 chat
magpie quota                                 # 看墨点余额和 5h/7d
```

## 两种登录

### 1 · 网页登录（登录后粘回跳 URL）

按「登录」→「网页登录」，对话框立刻给出书生 SSO 的地址：

```
https://sso.openxlab.org.cn/authentication?redirect=…&clientId=dagw07mkg1bazlxzoy31&source=discovery
```

**magpie 跑在服务器 / Docker 里时不会替你开浏览器**（它会在服务器上调 `xdg-open`，那儿没有浏览器），所以要把对话框里那段地址复制到新标签页打开，用书生账号登录（已经登录过 SSO 的话会直接跳走）。

登录后浏览器会停在**一个 JSON 页面**上（公开模型列表），地址栏里带着 `?code=…`。这是故意的：那个地址没有页面脚本，不会把 code 用掉，所以**把地址栏整条 URL 复制回来**粘进对话框就行。

插件随后：

1. `POST /api/user-center/v1/users/auth` `{code}` 换到登录态；
2. 在 TokenPlan 里新建一个名为 `magpie-20261123-1520` 的 API Key（回复里才有完整 key）；
3. 用 `/v1/models` 验一遍 Key，存账号，卡片立刻有墨点余额。

> SSO 的重定向白名单只比**域名**（`sso-main.js` 里的 `Vt`：取 URL 的 host 与白名单条目比，子域名也算），所以可以把回跳指到同一域名下的任意路径。指到 `/token-plan/home` 的话，页面脚本落地就会拿 code 去换登录态，你复制到的 URL 里 code 已经失效；指到那个 JSON 接口就不会。
>
> 粘 `uaa-token` 本身也行（F12 → Console：`copy(localStorage["uaa-token"] || document.cookie.match(/uaa-token=([^;]+)/)?.[1])`）。
>
> 每次网页登录会新建一个 `magpie-…` 的 Key（一个账号最多 10 个）。攒多了去 TokenPlan 页面把旧的停用/删掉即可。

### 2 · API Key（个人中心 → TokenPlan → API Key）

在 **个人中心 → TokenPlan → API Key** 建一个 Key，粘进 magpie 的 API Key 框。同一个框下面还能选填**网页 token**（`uaa-token`）——填了才有余额和限额卡片，不填也能正常推理。

网页 token 从浏览器拿：登录 `discovery.intern-ai.org.cn` 后，按 F12 → Console：

```js
copy(localStorage["uaa-token"] || document.cookie.match(/uaa-token=([^;]+)/)?.[1])
```

> `copy()` 自己返回 `undefined` 是正常的，值已经进剪贴板。想先看结果就跑
> `const ls = localStorage['uaa-token']; const ck = (document.cookie.split('; ').find(x => x.startsWith('uaa-token=')) || '').slice(10); console.log({ ls, ck });`
> 两个都空就是 httpOnly，去 DevTools → Application → Cookies → `discovery.intern-ai.org.cn` 里复制 `uaa-token` 的值。

### 给已有账号补网页 token

API Key 登进来的账号没有 token，卡片会写「还没有网页 token」。补的办法是**重新登录一次同一个账号**：

1. 插件 → 书生·端砚 → 那个账号那一行 → 重新登录
2. 选「API Key（个人中心 → TokenPlan → API Key）」
3. 第一个框粘网页 token，第二个框粘**原来那个** API Key
4. 保存

同一个 key 会被认成同一个账号，直接替换、不会多出一行（`settle()` 比的是 key）。

**每个书生账号只保留最新一次登录的 token。** 同一个号再登录一次（哪怕只是为了复制 token），之前那个就作废，卡片会变成「网页 token 失效」。所以顺序是：登录 → 立刻复制 → 立刻粘进 magpie，之后别再登这个号。插件会在保存前用余额接口验一遍，失效的 token 当场拒绝，不会存成一张读不出数的卡。

## 为什么不能像 zcode / cline / commandcode 那样自己完成

那几个插件不用你粘东西，是因为厂商给了它们一条不用浏览器的路：

| 插件 | 靠什么 |
|---|---|
| zcode | `POST /api/v1/oauth/cli/init` 拿 `flow_id`，再轮询 `/api/v1/oauth/cli/poll/{flow_id}` 到 `ready` |
| cline / opendesign | WorkOS 或自家的**设备码**，轮询 token 端点（`authorization_pending` → `access_token`） |
| commandcode | 插件在 `127.0.0.1` 起一个回调，厂商页面把 key POST 进来；Docker 里够不着，就退回「去 keys 页面建一个 key 粘进来」 |

书生这三样都没有，实测过：

- SSO 没有设备码，也没有可轮询的登录状态接口；
- 唯一的「凭 SSO 会话换 code」的接口 `POST /gw/uaa-be/api/v1/internal/auth {clientId}`，要求先有 SSO 会话，而拿会话的 `iam/issue-authorize` 直接返回 `A0246 lab network required`；
- 手机号 + 短信验证码那条路被滑块验证码挡着（`getSmsCode` 必须带 `captchaVerifyParam`）。

所以「浏览器登录 → 带回一个 token」这一步必须有人粘一次，插件能做的只是把这一步压到最短（点开就是链接、粘完自动建 Key 并读余额）。

## 余额卡片与 token 过期

平台只把墨点余额和窗口告诉**网页登录态**，API Key 打这个接口一律返回 `user token expired`（`msgCode A0211`）——这是平台的设计，不是插件的问题。所以：

- 有网页 token：卡片显示 `9,999.81 墨点` + `5 hours` / `7 days` 两个窗口（已用百分比、`0.19 / 10,000 墨点`、重置时间）。
- token 过期：卡片写「网页 token 已过期」，**推理不受影响**；重新登录一次（或重新粘贴 token）即可。
- 没有自动续期：书生的前端只把 token 存进 `localStorage`，收到 401 就跳登录页，没有 refresh 接口。任何声称能自动续期的做法都要拿你的 SSO 密码，不建议。

窗口带重置时间是有用的：额度用尽时 magpie 会把账号停到 `next_recover_at`，而不是每 15 分钟盲试一次。

## 并发与限速

| 平台 | 值 |
|---|---|
| RPM（生成模型） | 50 / 用户，全部 Key 合并 |
| RPM（决策模型） | 200 / 用户 |
| TPM | 2,000,000 / 用户，全部 Key 合并 |
| 5 小时 / 7 天 | 墨点额度（示例 10,000 / 50,000），合并计算 |

插件默认每个账号 4 个并发。想改就在 magpie 的供应商设置里改「同时请求数」，或在 `package.json` 里改 `magpie.maxConcurrency`（1–1000）。一个账号挂多个 Key 时平台额度是合并的，RPM 别按 Key 数乘：`magpie provider rpm shusheng-duanyan 45` 是每个账号的上限，两个账号就各 45。

429 的两种要分开看：`rate_limit_exceeded` 可以退避重试，`quota_exceeded` 是墨点不够、重试没意义。插件只声明 chat 协议，所以 magpie 看到的永远是 OpenAI 形状的错误体，能分清这两种。

## 模型

实时读 `/v1/models`（`context_length` 与 `input_modalities` 都会用上），已知模型的思考档位写死在 `index.mjs` 的 `KNOWN` 里。价格单位是**墨点 / 百万 token**（缓存命中 / 未命中 / 输出），magpie 的 `cost` 是美元，所以这里不填，避免把墨点当美元记账：

| 模型 | 上下文 | 缓存命中 | 未命中 | 输出 | 思考 |
|---|---:|---:|---:|---:|---|
| Sage-S2.1-Flash | 512K | 2.3 | 8 | 28 | low / high / max |
| Sage-A1.5 | 512K | 0.8 | 4 | 16 | — |
| Sage-A1.5-Taiyi | 512K | 6.4 | 32 | 128 | — |
| Atria-Dawn | 512K | 20 | 80 | 280 | — |
| Agents-A1 | 256K | 0.8 | 4 | 16 | — |
| 书生-S2 (`intern-s2`) | 256K | 6 | 30 | 180 | — |
| DeepSeek-V4.1-Flash-1017 | 1M | 20 | 1000 | 4000 | low / high / max |
| GLM-5.3 | 1M | 2000 | 8000 | 28000 | low / high / max |
| Qwen3.8-27B | 256K | 100 | 800 | 2700 | low / medium / xhigh |
| Kimi-K3.1-Pro | 1M | — | — | — | — |
| 书生-Decision-4B | 8K | — | 200 | 0 | 决策模型 |

`intern-decision-4b` 走 `/v1/systemone`，插件把它标成决策模型：路由组可以拿它当分类器（200 RPM 单独算）。

## 排错

| 现象 | 原因 |
|---|---|
| `换不到登录态（SSO authentication failed）` | code 用过了或过期了，重新登录一次 |
| `API Key 被拒绝（invalid_api_key）` | Key 删了/停用了，或复制时带了空格 |
| 卡片写「网页 token 已过期」 | 重新登录一次；推理不受影响 |
| `新建 API Key 失败（…）` | 账号的 10 个 Key 名额满了，先去 TokenPlan 删掉几个，或自己填一个 |
| 429 `rate_limit_exceeded` 多 | 降并发或 `magpie provider rpm shusheng-duanyan 40` |

## 隐私

- API Key 存在 magpie 的 `plugin-auth.json`（权限 600），网页 token 存在同一账号的 `metadata.uaaToken`。
- 插件只向 `discovery-api.intern-ai.org.cn`、`discovery.intern-ai.org.cn`、`sso.openxlab.org.cn` 发请求，没有别的去处。
- 余额接口只在 magpie 读用量时被调用（最多每分钟一次）。

## 开发

```sh
npm test        # 纯函数与钩子形状，不联网
SHUSHENG_API_KEY=sk-… node scripts/live.mjs
```

MIT
