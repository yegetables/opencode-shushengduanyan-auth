// 对真实接口做一次只读检查。不打印任何密钥。
//
//   SHUSHENG_API_KEY=sk-… node scripts/live.mjs
//   SHUSHENG_TOKEN=uaa-…  node scripts/live.mjs     # 顺带检查余额接口
//
// 只发 GET /v1/models、GET credits/balance，以及一个必然失败的换码请求
// （验证 /api/user-center/v1/users/auth 的形状）。

const API_BASE = "https://discovery-api.intern-ai.org.cn/v1"
const AUTH_API = "https://discovery.intern-ai.org.cn/api/user-center/v1"
const BALANCE_URL = "https://discovery.intern-ai.org.cn/api/tokenplan/v1/credits/balance"

const key = (process.env.SHUSHENG_API_KEY ?? "").trim()
const token = (process.env.SHUSHENG_TOKEN ?? "").trim()

const ok = (label, extra = "") => console.log(`✓ ${label}${extra ? " · " + extra : ""}`)
const bad = (label, extra = "") => {
  console.log(`✗ ${label}${extra ? " · " + extra : ""}`)
  process.exitCode = 1
}

async function main() {
  if (key) {
    const res = await fetch(`${API_BASE}/models`, { headers: { authorization: `Bearer ${key}`, accept: "application/json" } })
    const j = await res.json().catch(() => null)
    if (res.ok && Array.isArray(j?.data)) {
      const ids = j.data.map((m) => m.id)
      ok("GET /v1/models", `${ids.length} chat + ${(j.models ?? []).length} decision`)
      console.log(`  ${ids.join(", ")}`)
      for (const d of j.models ?? []) console.log(`  decision: ${d.name}`)
    } else {
      bad("GET /v1/models", j?.error?.message || `HTTP ${res.status}`)
    }
  } else {
    console.log("· 跳过 /v1/models：没有 SHUSHENG_API_KEY")
  }

  if (token) {
    const res = await fetch(BALANCE_URL, { headers: { authorization: `Bearer ${token}`, accept: "application/json" } })
    const j = await res.json().catch(() => null)
    if (j?.data) {
      const w = j.data.usage_windows ?? {}
      ok("GET credits/balance", `${j.data.available_credits} 墨点`)
      for (const k of ["5h", "7d"]) {
        const x = w[k]
        if (x) console.log(`  ${k}: ${x.used_credits}/${x.limit_credits} · 重置 ${x.next_recover_at}`)
      }
      console.log(`  rpm ${j.data.rpm_limit} · decision rpm ${j.data.decision_rpm_limit} · tpm ${j.data.tpm_limit}`)
    } else {
      bad("GET credits/balance", j?.msgCode ? `${j.msgCode} ${j.msg}` : `HTTP ${res.status}`)
    }
  } else {
    console.log("· 跳过 credits/balance：没有 SHUSHENG_TOKEN")
  }

  // 换码接口的形状：假 code 应当被拒（-40132），不是 404/405
  const res = await fetch(`${AUTH_API}/users/auth`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ code: "magpie-live-check" }),
  })
  const j = await res.json().catch(() => null)
  if (res.ok && typeof j?.code === "number" && j.code !== 0) {
    ok("POST users/auth", `拒绝假 code：${j.code} ${j.msg ?? ""}`.trim())
  } else {
    bad("POST users/auth", `HTTP ${res.status} ${JSON.stringify(j)?.slice(0, 120) ?? ""}`)
  }
}

main().catch((e) => bad("检查中断", e?.message ?? String(e)))
