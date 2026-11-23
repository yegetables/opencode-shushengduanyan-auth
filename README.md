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

### 1 · 网页登录（粘贴回调 URL）

按「登录」，插件会给出书生 SSO 的地址：

```
https://sso.openxlab.org.cn/authentication?redirect=…&clientId=dagw07mkg1bazlxzoy31&source=discovery
```

**magpie 跑在服务器 / Docker 里时不会替你开浏览器**（它会在服务器上调 `xdg-open`，那儿没有浏览器）。把对话框里那段链接复制到新标签页打开，用书生账号登录。

登录后浏览器跳回 `discovery.intern-ai.org.cn`：

- 地址栏**还带** `?code=…`：把整条 URL（或只把 `code`）粘进 Code 输入框。
- 地址栏**已经干净**（页面自己把 code 换掉并清掉了）：粘 `uaa-token` 也一样，F12 → Console 跑：

  ```js
  copy(localStorage["uaa-token"] || document.cookie.match(/uaa-token=([^;]+)/)?.[1])
  ```

插件收到后：

1. 有 code 就 `POST /api/user-center/v1/users/auth` `{code}` 换到网页登录态（`uaa-token`）；没有 code 就把它当 token 验一遍；
2. 登录前如果没填 API Key，就在 TokenPlan 里新建一个名为 `magpie-20261123-1520` 的 Key（回复里才有完整 key）；
3. 用 `/v1/models` 验一遍 Key，然后存账号。

> code 只能用一次，而且书生页面自己也会拿它换登录态——抢不到就粘 token，效果一样。

### 2 · 直接粘贴 API Key

在 **个人中心 → TokenPlan → API Key** 建一个 Key，粘进 magpie 的 API Key 框。同一个框下面还能选填**网页 token**（`uaa-token`）——填了才有余额和限额卡片，不填也能正常推理。

网页 token 从浏览器拿：登录 `discovery.intern-ai.org.cn` 后，按 F12 → Console：

```js
copy(localStorage["uaa-token"] || document.cookie.match(/uaa-token=([^;]+)/)?.[1])
```

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
