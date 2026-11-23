import test from "node:test"
import assert from "node:assert/strict"

import plugin, { ShushengDuanyanAuth, _internal as m } from "../index.mjs"

test("codeFrom reads a pasted callback URL, and a bare code is not one", () => {
  assert.equal(m.codeFrom("https://discovery.intern-ai.org.cn/token-plan/home?code=abc123&state=x"), "abc123")
  assert.equal(m.codeFrom("https://discovery.intern-ai.org.cn/home?a=1&code=de%2Ff"), "de/f")
  assert.equal(m.codeFrom("  abc123  "), "")
  assert.equal(m.codeFrom(""), "")
})

test("looksLikeToken tells a uaa-token from an SSO code", () => {
  assert.equal(m.looksLikeToken("eyJ0eXBlIjoiSldUIiwiYWxnIjoiSFM1MTIifQ.eyJqdGkiOiIyMzU1MDA4NzUiLCJyb2wiOiJST0xFX1JFR0lTVEVSIiwiaXNzIjoiT3BlblhMYWIiLCJpYXQiOjE3OTU0MDA0NjQsInBob25lIjoiIiwiZW1haWwiOiIiLCJleHAiOjE3OTY2MTAwNjR9.fdbZma-SrDi3igtuqxZoxPPkastNEKProTxj8ikFJi9oMOE_nTZyoDhJtzjhns899h2ciI9LDeoH22ZpoDw9Yg"), true)
  assert.equal(m.looksLikeToken("a1b2c3d4e5f6"), false)
  assert.equal(m.looksLikeToken("https://discovery.intern-ai.org.cn/token-plan/home"), false)
})

test("beijingISO puts the platform's zone on its times", () => {
  assert.equal(m.beijingISO("2026-11-23 12:29:53"), "2026-11-23T12:29:53+08:00")
  assert.equal(m.beijingISO("2026-11-23T12:29:53"), "2026-11-23T12:29:53+08:00")
  assert.equal(m.beijingISO(""), "")
  assert.equal(m.beijingISO("not a time"), "")
})

// the reply the platform gave on 2026-11-23, trimmed to what matters
const BALANCE = {
  access_status: 1,
  rpm_limit: 50,
  decision_rpm_limit: 200,
  tpm_limit: 2000000,
  available_credits: "9999.814",
  active_package_count: 1,
  usage_windows: {
    "5h": {
      enabled: true,
      limit_credits: "10000.000",
      used_credits: "0.186",
      remaining_credits: "9999.814",
      next_recover_at: "2026-11-23 12:29:53",
    },
    "7d": {
      enabled: true,
      limit_credits: "50000.000",
      used_credits: "0.186",
      remaining_credits: "49999.814",
      next_recover_at: "2026-11-29 02:29:53",
    },
  },
}

test("windowsOf turns the credit windows into magpie's, with resets", () => {
  const ws = m.windowsOf(BALANCE)
  assert.equal(ws.length, 2)
  assert.deepEqual(ws.map((w) => w.name), ["5 hours", "7 days"])
  assert.deepEqual(ws.map((w) => w.span), [18000, 604800])
  assert.equal(ws[0].limit, 10000)
  assert.equal(ws[0].amount, 0.186)
  assert.equal(ws[0].unit, "墨点")
  assert.equal(ws[0].used, 0)
  assert.equal(ws[0].resetsAt, "2026-11-23T12:29:53+08:00")
  assert.equal(ws[1].resetsAt, "2026-11-29T02:29:53+08:00")
})

test("windowsOf skips a window off, empty, or without a limit", () => {
  assert.deepEqual(m.windowsOf({ usage_windows: { "5h": { enabled: false, limit_credits: "1" } } }), [])
  assert.deepEqual(m.windowsOf({ usage_windows: { "5h": { enabled: true, limit_credits: "0" } } }), [])
  assert.deepEqual(m.windowsOf({}), [])
  const noReset = m.windowsOf({ usage_windows: { "5h": { limit_credits: "10", used_credits: "5" } } })
  assert.equal(noReset[0].used, 50)
  assert.equal("resetsAt" in noReset[0], false)
})

const MODELS = {
  object: "list",
  data: [
    {
      id: "Sage-S2.1-Flash",
      object: "model",
      context_length: 524288,
      input_modalities: [{ type: "text" }, { type: "image", supported_inputs: {} }],
      status: "active",
    },
    {
      id: "glm-5.3",
      object: "model",
      context_length: 1048576,
      input_modalities: [{ type: "text" }],
      status: "active",
    },
    {
      id: "Atria-Dawn-Preview",
      object: "model",
      context_length: 524288,
      input_modalities: [{ type: "text" }],
      status: "deprecated",
      replacement_model: "Atria-Dawn",
    },
    { id: "mystery-model", object: "model", context_length: 131072, input_modalities: [{ type: "text" }] },
  ],
  models: [{ name: "intern-decision-4b", description: "InternLM Structured Decision Model", status: "active" }],
  total_count: 4,
}

test("buildModels maps the live list, including the decision model", () => {
  const out = m.buildModels(MODELS)
  assert.equal(out["Sage-S2.1-Flash"].limit.context, 524288)
  assert.equal(out["Sage-S2.1-Flash"].capabilities.input.image, true)
  assert.equal(out["Sage-S2.1-Flash"].reasoning, true)
  assert.deepEqual(Object.keys(out["Sage-S2.1-Flash"].variants), ["low", "high", "max"])
  assert.equal(out["glm-5.3"].capabilities.input.image, false)
  assert.equal(out["glm-5.3"].reasoning, true)
  assert.equal(out["Atria-Dawn-Preview"].status, "deprecated")
  assert.equal(out["mystery-model"].reasoning, false)
  assert.equal(out["mystery-model"].api.url, m.API_BASE)
  assert.equal(out["mystery-model"].api.npm, "@ai-sdk/openai-compatible")
  assert.equal(out["intern-decision-4b"].decides, true)
  assert.equal(out["intern-decision-4b"].limit.context, 8192)
})

test("buildModels keeps the last list when the reply has no models", () => {
  assert.equal(m.buildModels({ data: [] }), null)
  assert.equal(m.buildModels(null), null)
})

test("tokenOf takes a token out of a pasted cookie string", () => {
  assert.equal(m.tokenOf("uaa-token=abc.def.ghi; other=1"), "abc.def.ghi")
  assert.equal(m.tokenOf("abc.def.ghi"), "abc.def.ghi")
  assert.equal(m.tokenOf("  abc  "), "abc")
})

test("labelOf names an account by its email, else its key", () => {
  assert.equal(m.labelOf({ sso_email: "a@b.c" }, "sk-xxxx1234"), "a@b.c")
  assert.equal(m.labelOf({ sso_phone: "15500000000" }, "sk-xxxx1234"), "15500000000")
  assert.equal(m.labelOf({ nickname: "书生" }, "sk-xxxx1234"), "书生")
  assert.equal(m.labelOf(null, "sk-xxxx1234"), "书生 1234")
})

test("loginURL carries the site's own clientId and a redirect nothing consumes", () => {
  const u = new URL(m.loginURL())
  assert.equal(u.origin + u.pathname, "https://sso.openxlab.org.cn/authentication")
  assert.equal(u.searchParams.get("clientId"), "dagw07mkg1bazlxzoy31")
  // a JSON endpoint on the whitelisted host: no page JS runs to spend the code
  const redirect = new URL(u.searchParams.get("redirect"))
  assert.equal(redirect.origin, "https://discovery.intern-ai.org.cn")
  assert.equal(redirect.pathname, "/api/tokenplan/v1/public/models")
  assert.equal(u.searchParams.get("source"), "discovery")
})

test("the plugin declares the provider, both sign-ins, and the usage card", async () => {
  const p = await ShushengDuanyanAuth()
  const cfg = { provider: {} }
  await p.config(cfg)
  const declared = cfg.provider[m.PROVIDER]
  assert.equal(declared.name, "书生·端砚")
  assert.equal(declared.api, m.API_BASE)
  assert.equal(declared.npm, "@ai-sdk/openai-compatible")
  assert.equal(declared.decide, true)
  assert.ok(declared.models["Sage-A1.5"])

  assert.equal(p.auth.provider, m.PROVIDER)
  assert.deepEqual(p.auth.methods.map((x) => x.type), ["oauth", "api"])
  assert.equal(p.auth.methods[0].label, "网页登录（登录后粘回跳 URL）")
  // the link shows up at once: no question stands between the click and the page
  assert.equal(p.auth.methods[0].prompts, undefined)
  assert.equal(p.auth.methods[1].prompts[0].key, "uaaToken")

  // authorize hands back the sign-in page and a code callback
  const a = await p.auth.methods[0].authorize({})
  assert.equal(a.method, "code")
  assert.equal(typeof a.callback, "function")
  assert.equal(a.url, m.loginURL())
  assert.ok(a.instructions.includes("code="))

  // no web token yet: the card says why, and the account is not marked lapsed
  const u = await p.auth.usage(async () => ({ type: "api", key: "sk-x", metadata: {} }))
  assert.equal(u.windows.length, 0)
  assert.match(u.error, /网页 token/)
  assert.notEqual(u.signIn, "expired")

  // loader gives magpie the base and the key
  const l = await p.auth.loader(async () => ({ type: "api", key: "sk-abc", metadata: {} }))
  assert.equal(l.baseURL, m.API_BASE)
  assert.equal(l.apiKey, "sk-abc")
})

test("a token the platform rejects once is asked again before it is called dead", async () => {
  let calls = 0
  const real = globalThis.fetch
  globalThis.fetch = async () => {
    calls++
    const body =
      calls === 1
        ? { msgCode: "A0211", msg: "user token expired", data: null }
        : { code: 0, msg: "success", data: { available_credits: "1.5", usage_windows: {} } }
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })
  }
  try {
    const d = await m.verifyToken("some.token.here")
    assert.equal(calls, 2)
    assert.equal(d.available_credits, "1.5")
  } finally {
    globalThis.fetch = real
  }
})

test("a failed code exchange says why, without leaking the code", async () => {
  const p = await ShushengDuanyanAuth()
  const a = await p.auth.methods[0].authorize({ apiKey: "sk-test" })
  const real = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({ code: -40132, msg: "SSO authentication failed" }), { status: 200, headers: { "content-type": "application/json" } })
  try {
    const r = await a.callback("https://discovery.intern-ai.org.cn/token-plan/home?code=used-once")
    assert.equal(r.type, "failed")
    assert.match(r.error, /SSO authentication failed/)
    assert.match(r.error, /uaa-token/)
    assert.ok(!r.error.includes("used-once"))
  } finally {
    globalThis.fetch = real
  }
})

test("a clean callback URL asks for the token instead, without any request", async () => {
  const p = await ShushengDuanyanAuth()
  const a = await p.auth.methods[0].authorize({ apiKey: "sk-test" })
  const real = globalThis.fetch
  globalThis.fetch = async () => {
    throw new Error("no request should be made")
  }
  try {
    const r = await a.callback("https://discovery.intern-ai.org.cn/token-plan/home")
    assert.equal(r.type, "failed")
    assert.match(r.error, /没有 code/)
    assert.match(r.error, /uaa-token/)
  } finally {
    globalThis.fetch = real
  }
})

test("the entry exports the provider object magpie loads", () => {
  assert.equal(plugin.id, m.PROVIDER)
  assert.equal(plugin.server, ShushengDuanyanAuth)
})
