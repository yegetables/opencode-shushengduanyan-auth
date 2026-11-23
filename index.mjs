// 书生·端砚（Intern InkStone）TokenPlan —— magpie 供应商插件。
//
// 两条登录路径，最后都落成同一个账号：type "api"，key 是 TokenPlan 的 API Key，
// metadata.uaaToken 存网页登录态（读墨点余额与 5h/7d 限额用）。
//
//   • 网页登录（粘贴回调 URL）：打开 SSO，登录后浏览器跳回
//     discovery.intern-ai.org.cn 并带上 ?code=…，把整条地址栏 URL 粘回来，
//     插件在 /api/user-center/v1/users/auth 换到 uaa-token。没填 API Key 时
//     顺手在 TokenPlan 里新建一个名为 magpie-… 的 Key。
//   • 直接粘贴：API Key + 可选的 uaa-token。
//
// 推理只声明 chat completions：magpie 会把各家 agent 的请求翻译成它，厂商的
// 429 因此永远是 OpenAI 形状 —— quota_exceeded 才认得出（Anthropic 端点把
// 限速和额度不足都报成 rate_limit_error）。

const PROVIDER = "shusheng-duanyan"
const NPM = "@ai-sdk/openai-compatible"
const API_BASE = "https://discovery-api.intern-ai.org.cn/v1"
const WEB = "https://discovery.intern-ai.org.cn"
const AUTH_API = `${WEB}/api/user-center/v1`
const BALANCE_URL = `${WEB}/api/tokenplan/v1/credits/balance`
const KEYS_URL = `${WEB}/api/tokenplan/v1/keys`
const SSO = "https://sso.openxlab.org.cn/authentication"
// 书生·端砚 前端自己的 clientId 与回跳地址（discovery-home 的 product/auth.js）
const CLIENT_ID = "dagw07mkg1bazlxzoy31"
// 登录后的回跳地址。SSO 的白名单只比域名（sso-main.js 的 Vt：取 URL 的 host，
// 与白名单条目比，子域名也算），所以这里可以指一个**不会被前端用掉 code** 的
// 地址：公开模型列表返回纯 JSON，页面没有 JS，地址栏里的 ?code= 会一直留着，
// 用户复制整条 URL 就能换登录态。
const REDIRECT = `${WEB}/api/tokenplan/v1/public/models?page=1&page_size=5`

// 平台已知的模型：上下文、图片、思考档位。实时列表优先，这里只是兜底。
// 价格（墨点 / 百万 token，缓存命中 / 未命中 / 输出）见 README，magpie 的
// cost 以美元计，不拿来装墨点。
const KNOWN = {
  "Sage-S2.1-Flash": { context: 524288, image: true, reasoning: true, variants: { low: {}, high: {}, max: {} } },
  "Sage-A1.5": { context: 524288, image: true },
  "Sage-A1.5-Taiyi": { context: 524288 },
  "Atria-Dawn": { context: 524288 },
  "Agents-A1": { context: 262144, image: true },
  "intern-s2": { context: 262144, image: true },
  "deepseek-v4.1-flash-1017": { context: 1048576, image: true, reasoning: true, variants: { low: {}, high: {}, max: {} } },
  "glm-5.3": { context: 1048576, reasoning: true, variants: { low: {}, high: {}, max: {} } },
  "qwen3.8-27b": { context: 262144, image: true, reasoning: true, variants: { low: {}, medium: {}, xhigh: {} } },
  "kimi-k3.1-pro": { context: 1048576, image: true },
  // SystemOne 决策模型：只回答问题，magpie 拿它当路由组的分类器
  "intern-decision-4b": { context: 8192, decides: true },
}

const DECISION_CONTEXT = 8192

function num(v) {
  const n = typeof v === "number" ? v : Number(String(v ?? "").trim())
  return Number.isFinite(n) ? n : 0
}

function fmt(v, digits = 2) {
  return num(v).toLocaleString("en-US", { maximumFractionDigits: digits })
}

// 平台的时间是北京时间、不带时区（"2026-11-23 12:29:53"）：补上 +08:00，
// 否则在 UTC 的容器里会被当成本地时间，重置时间差 8 小时。
function beijingISO(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(String(v ?? "").trim())
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}+08:00` : ""
}

// 粘进来的可能是整条回跳 URL（?code=…）、裸 code，或者 uaa-token 本身。
function codeFrom(text) {
  const s = String(text ?? "").trim()
  if (!s) return ""
  try {
    const c = new URL(s).searchParams.get("code")
    if (c) return c
  } catch {
    /* 不是 URL */
  }
  const m = /[?&]code=([^&#\s]+)/.exec(s)
  if (m) {
    try {
      return decodeURIComponent(m[1])
    } catch {
      return m[1]
    }
  }
  return ""
}

// uaa-token 是一长串带点的串；SSO 的 code 短得多，也没有点。网址不是 token，
// 哪怕它带好几个点。
function looksLikeToken(s) {
  const t = String(s ?? "").trim()
  if (!t || /^https?:\/\//i.test(t)) return false
  return t.length > 60 || t.split(".").length >= 3
}

// 网页已经自己把 code 用掉时，怎么把 uaa-token 拿出来
const TOKEN_HOW =
  "F12 → Console 跑 copy(localStorage['uaa-token'] || document.cookie.match(/uaa-token=([^;]+)/)?.[1])，把 token 粘回来"

// 粘进来的可能只是一段 token，也可能连着 "uaa-token=…; other=…" 一起粘了
function tokenOf(text) {
  const s = String(text ?? "").trim()
  const m = /(?:^|[;\s])uaa-token=([^;\s]+)/.exec(s)
  if (!m) return s
  try {
    return decodeURIComponent(m[1])
  } catch {
    return m[1]
  }
}

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0")
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`
}

async function jsonOf(res) {
  try {
    return await res.json()
  } catch {
    return null
  }
}

// code → uaa-token（POST /api/user-center/v1/users/auth，前端换码用的就是它）
async function exchangeCode(code) {
  const res = await fetch(`${AUTH_API}/users/auth`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ code: String(code) }),
  })
  const j = await jsonOf(res)
  const token = j?.data?.token
  if (j?.code === 0 && typeof token === "string" && token) return token
  const why = String(j?.msg ?? j?.message ?? "").trim() || `HTTP ${res.status}`
  throw new Error(`换不到登录态（${why}）`)
}

// 余额接口同时用来验证一个 token 是否还活着
async function balanceOf(token) {
  const res = await fetch(BALANCE_URL, {
    headers: { authorization: `Bearer ${token}`, accept: "application/json" },
  })
  const j = await jsonOf(res)
  if (j && j.data && typeof j.data === "object") return j.data
  const why = String(j?.msg ?? j?.message ?? "").trim()
  if (String(j?.msgCode ?? "") === "A0211" || /token expired/i.test(why)) {
    const e = new Error("网页 token 已过期")
    e.expired = true
    throw e
  }
  throw new Error(why || `余额接口 HTTP ${res.status}`)
}

// 账号显示名：magpie 拿 metadata.email 当账号名，两个人不能撞。
async function userOf(token) {
  try {
    const res = await fetch(`${AUTH_API}/users/getUserInfo`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ jwt: token }),
    })
    const j = await jsonOf(res)
    if (j?.code === 0 && j.data) return j.data
  } catch {
    /* 拿不到名字不算登录失败 */
  }
  return null
}

function labelOf(user, key) {
  const d = user || {}
  const name = [d.sso_email, d.email, d.sso_phone, d.phone, d.nickname, d.sso_username]
    .map((v) => String(v ?? "").trim())
    .find(Boolean)
  return name || `书生 ${String(key ?? "").slice(-4)}`
}

// 网页登录没带 API Key 时新建一个：POST /api/tokenplan/v1/keys 的回复里就是完整 key
async function createKey(token, name) {
  const res = await fetch(KEYS_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json",
      "Idempotency-Key": crypto.randomUUID(),
    },
    body: JSON.stringify({ name }),
  })
  const j = await jsonOf(res)
  const key = j?.data?.key
  if (j?.code === 0 && typeof key === "string" && key) return key
  const why = String(j?.msg ?? j?.message ?? "").trim() || `HTTP ${res.status}`
  throw new Error(`新建 API Key 失败（${why}）`)
}

async function checkKey(key) {
  const res = await fetch(`${API_BASE}/models`, {
    headers: { authorization: `Bearer ${key}`, accept: "application/json" },
  })
  if (res.ok) return
  const j = await jsonOf(res)
  const why = j?.error?.message || j?.error?.code || `HTTP ${res.status}`
  throw new Error(`API Key 被拒绝（${why}）`)
}

function windowsOf(data) {
  const out = []
  const add = (slot, name, span) => {
    const w = data?.usage_windows?.[slot]
    if (!w || w.enabled === false) return
    const limit = num(w.limit_credits)
    const used = num(w.used_credits)
    if (limit <= 0) return
    const resetsAt = beijingISO(w.next_recover_at)
    out.push({
      name,
      span,
      used: Math.round((used / limit) * 10000) / 100,
      amount: used,
      limit,
      unit: "墨点",
      ...(resetsAt ? { resetsAt } : {}),
    })
  }
  add("5h", "5 hours", 5 * 3600)
  add("7d", "7 days", 7 * 24 * 3600)
  return out
}

// 实时模型列表 → magpie 的模型表（键就是模型 id）
function buildModels(list, base) {
  const out = {}
  const data = Array.isArray(list?.data) ? list.data : []
  for (const m of data) {
    const id = String(m?.id ?? "").trim()
    if (!id) continue
    const known = KNOWN[id] ?? {}
    const context = num(m.context_length) || known.context || 0
    const images =
      (Array.isArray(m.input_modalities) && m.input_modalities.some((x) => x?.type === "image")) || known.image === true
    out[id] = {
      ...(base?.[id] ?? {}),
      name: id,
      api: { id, url: API_BASE, npm: NPM },
      limit: { context },
      reasoning: known.reasoning === true,
      ...(known.variants ? { variants: known.variants } : {}),
      capabilities: { input: { text: true, image: images }, output: { text: true } },
      cost: { input: 0, output: 0 },
      ...(m.status ? { status: m.status } : {}),
    }
  }
  // 决策模型单独列在回复的 models 里，走 /v1/systemone
  for (const d of Array.isArray(list?.models) ? list.models : []) {
    const id = String(d?.name ?? "").trim()
    if (!id) continue
    out[id] = {
      ...(base?.[id] ?? {}),
      name: id,
      api: { id, url: API_BASE, npm: NPM },
      limit: { context: DECISION_CONTEXT },
      reasoning: false,
      capabilities: { input: { text: true }, output: { text: true } },
      cost: { input: 0, output: 0 },
      decides: true,
    }
  }
  return Object.keys(out).length ? out : null
}

// 登录前先摆出来的模型表
function defaultModels() {
  const out = {}
  for (const [id, known] of Object.entries(KNOWN)) {
    const decision = known.decides === true
    out[id] = {
      name: id,
      api: { id, url: API_BASE, npm: NPM },
      limit: { context: known.context ?? (decision ? DECISION_CONTEXT : 0) },
      reasoning: known.reasoning === true,
      ...(known.variants ? { variants: known.variants } : {}),
      capabilities: { input: { text: true, image: known.image === true }, output: { text: true } },
      cost: { input: 0, output: 0 },
      ...(decision ? { decides: true } : {}),
    }
  }
  return out
}

// 余额接口偶发会把一个好好的 token 判成 user token expired（实测过一次：同一个
// token 一分钟后恢复正常），所以验 token 失败时先等一会儿再试一次，别把人挡在门外。
async function verifyToken(token) {
  try {
    return await balanceOf(token)
  } catch (e) {
    if (!e?.expired) throw e
    await new Promise((r) => setTimeout(r, 2000))
    return balanceOf(token)
  }
}

// 网页登录：换码 → 换 token → 校验 Key → 存账号
async function webLogin(pasted, apiKey) {
  const text = String(pasted ?? "").trim()
  if (!text) return { type: "failed", error: "把登录后地址栏的整条 URL 粘进来（里面有 code=…），或者直接粘 uaa-token" }

  let token = ""
  const code = codeFrom(text)
  if (code) {
    try {
      token = await exchangeCode(code)
    } catch (e) {
      return {
        type: "failed",
        error: `${e.message}；code 只能用一次 —— 如果页面已经自己换过登录态（地址栏里没有 ?code= 了），就${TOKEN_HOW}`,
      }
    }
  } else if (/^https?:\/\//i.test(text)) {
    // 一条干净的 URL：SSO 没把 code 加回来，或者页面把它用掉了
    return {
      type: "failed",
      error: `这条 URL 里没有 code —— 登录后应该停在一个 JSON 页面、地址栏里带着 ?code=…；没停到那儿就重新登录一次。也可以直接粘 uaa-token：${TOKEN_HOW}`,
    }
  } else {
    // 没带 ?code=：先当 code 试，失败了再当 token 试
    let why = ""
    try {
      token = await exchangeCode(text)
    } catch (e) {
      why = e.message
    }
    if (!token) {
      if (!looksLikeToken(text)) return { type: "failed", error: `${why}；贴的是登录后的整条 URL 吗？` }
      const t = tokenOf(text)
      try {
        await verifyToken(t)
        token = t
      } catch (e) {
        return { type: "failed", error: `${why}；当 token 用也失败：${e.message}` }
      }
    }
  }

  let key = String(apiKey ?? "").trim()
  if (!key) {
    try {
      key = await createKey(token, `magpie-${stamp()}`)
    } catch (e) {
      return { type: "failed", error: `${e.message}；也可以自己填一个 API Key` }
    }
  }
  try {
    await checkKey(key)
  } catch (e) {
    return { type: "failed", error: e.message }
  }

  const user = await userOf(token)
  return {
    type: "success",
    key,
    metadata: {
      uaaToken: token,
      email: labelOf(user, key),
      ...(user?.sso_uid ? { ssoUid: String(user.sso_uid) } : {}),
    },
  }
}

function loginURL() {
  const redirect = encodeURIComponent(REDIRECT)
  return `${SSO}?redirect=${redirect}&clientId=${encodeURIComponent(CLIENT_ID)}&source=discovery`
}

export const ShushengDuanyanAuth = async () => ({
  // 供应商与登录前的模型表
  config: async (cfg) => {
    cfg.provider ??= {}
    cfg.provider[PROVIDER] ??= {
      name: "书生·端砚",
      npm: NPM,
      api: API_BASE,
      // 决策模型 intern-decision-4b 当路由组的分类器
      decide: true,
      models: defaultModels(),
    }
  },

  auth: {
    provider: PROVIDER,
    methods: [
      {
        type: "oauth",
        label: "网页登录（登录后粘回跳 URL）",
        async authorize() {
          return {
            url: loginURL(),
            instructions:
              "复制下面那段登录链接，在新标签页打开 —— magpie 跑在 Docker / 服务器上时不会替你开浏览器。" +
              "用书生账号登录（已经登录过 SSO 的话会直接跳走）。" +
              "登录后浏览器会停在一个 JSON 页面上（这是正常的，?code= 就留在地址栏里），把地址栏整条 URL 复制回来粘到下面。" +
              "插件会用它换登录态、新建一个 magpie-… 的 API Key（可在 TokenPlan 页面停用），并读出墨点余额。",
            method: "code",
            callback: (pasted) => webLogin(pasted, ""),
          }
        },
      },
      {
        type: "api",
        label: "API Key（个人中心 → TokenPlan → API Key）",
        placeholder: "sk-…",
        prompts: [
          {
            type: "password",
            key: "uaaToken",
            message: "网页 token（可选，填了才有墨点余额和 5h/7d 限额卡片；F12 → Console 里取）",
            placeholder: "uaa-token…（可留空）",
            validate: () => undefined,
          },
        ],
      },
    ],

    loader: async (getAuth) => {
      const auth = await getAuth()
      if (!auth) return {}
      return { baseURL: API_BASE, apiKey: auth.key ?? "" }
    },

    // 墨点余额 + 5h/7d 限额；窗口带 next_recover_at，额度用尽时路由会停到重置
    async usage(getAuth) {
      const auth = await getAuth()
      const token = String(auth?.metadata?.uaaToken ?? "").trim()
      if (!token) {
        return {
          error:
            "还没有网页 token：在这一行重新登录一次，选「API Key（个人中心 → TokenPlan → API Key）」，" +
            "把 token 和原来那个 API Key 一起填 —— 同一个 key 会替换这个账号，不会多出一行",
          windows: [],
        }
      }
      let data
      try {
        data = await verifyToken(token)
      } catch (e) {
        // 只影响卡片，不影响推理
        return {
          error: e?.expired
            ? "暂时读不到余额：平台回 user token expired —— 有时只是平台一时抽风，下一分钟会自动再试；一直这样就在这个账号上重新登录、立刻复制新 token"
            : String(e?.message ?? e),
          windows: [],
          signIn: "kept",
        }
      }
      return {
        plan: "TokenPlan",
        balance: `${fmt(data.available_credits)} 墨点`,
        windows: windowsOf(data),
      }
    },
  },

  provider: {
    id: PROVIDER,
    async models(provider, { auth } = {}) {
      const key = String(auth?.key ?? "").trim()
      if (!key) return provider.models
      let res
      try {
        res = await fetch(`${API_BASE}/models`, {
          headers: { authorization: `Bearer ${key}`, accept: "application/json" },
        })
      } catch {
        return provider.models
      }
      if (!res.ok) return provider.models
      const j = await jsonOf(res)
      return buildModels(j, provider.models) ?? provider.models
    },
  },
})

// 对象形式的入口：magpie 只加载 server，别把别的导出当插件
export default { id: PROVIDER, server: ShushengDuanyanAuth }

// 给测试用，不是插件的一部分
export const _internal = {
  PROVIDER,
  API_BASE,
  AUTH_API,
  BALANCE_URL,
  KNOWN,
  beijingISO,
  buildModels,
  codeFrom,
  defaultModels,
  fmt,
  labelOf,
  loginURL,
  looksLikeToken,
  num,
  stamp,
  tokenOf,
  verifyToken,
  windowsOf,
}
