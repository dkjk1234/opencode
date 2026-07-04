import { Effect, Option } from "effect"

import { Account } from "./account"

export interface BillingStatus {
  object?: string
  provider?: string
  checkout_configured?: boolean
  plans_count?: number
  webhook_configured?: boolean
}

export interface BillingPlanSummary {
  id: string
  name: string
  credits: number
  amount: number
  currency: string
}

export interface BillingCheckout {
  object?: string
  checkout_id?: string
  checkout_url: string
  plan_id?: string
  credits?: number
  provider?: string
  replayed?: boolean
}

interface BillingAccess {
  url: string
  headers: Record<string, string>
}

const resolveAccess = Effect.fn("Billing.resolveAccess")(function* () {
  const service = yield* Account.Service
  const active = yield* service.active()
  if (Option.isNone(active)) return Option.none<BillingAccess>()

  const token = yield* service.token(active.value.id)
  if (Option.isNone(token)) return Option.none<BillingAccess>()

  const headers: Record<string, string> = {
    authorization: `Bearer ${token.value}`,
  }
  if (active.value.active_org_id) headers["x-org-id"] = active.value.active_org_id

  return Option.some({
    url: active.value.url,
    headers,
  })
})

const billingJson = (url: string, init: RequestInit = {}) =>
  Effect.tryPromise({
    try: async () => {
      const response = await fetch(url, {
        ...init,
        headers: {
          accept: "application/json",
          ...(init.headers || {}),
        },
      })
      const text = await response.text()
      let body: any = {}
      try {
        body = text ? JSON.parse(text) : {}
      } catch {
        body = { error: { message: text.slice(0, 240) || `HTTP ${response.status}` } }
      }
      if (!response.ok || body.error) throw new Error(body?.error?.message || `HTTP ${response.status}`)
      return body
    },
    catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
  })

const status = Effect.fn("Billing.status")(function* () {
  const access = yield* resolveAccess()
  if (Option.isNone(access)) return Option.none<BillingStatus>()
  const body = yield* billingJson(`${access.value.url}/billing/status`, { headers: access.value.headers })
  return Option.some(body as BillingStatus)
})

const plans = Effect.fn("Billing.plans")(function* () {
  const access = yield* resolveAccess()
  if (Option.isNone(access)) return Option.none<BillingPlanSummary[]>()
  const body = yield* billingJson(`${access.value.url}/billing/plans`, { headers: access.value.headers })
  return Option.some(Array.isArray(body.data) ? (body.data as BillingPlanSummary[]) : [])
})

const checkout = Effect.fn("Billing.checkout")(function* (input: { planID: string; idempotencyKey: string }) {
  const access = yield* resolveAccess()
  if (Option.isNone(access)) return Option.none<BillingCheckout>()
  const body = yield* billingJson(`${access.value.url}/billing/checkout`, {
    method: "POST",
    headers: {
      ...access.value.headers,
      "content-type": "application/json",
      "idempotency-key": input.idempotencyKey,
    },
    body: JSON.stringify({ plan_id: input.planID }),
  })
  if (!body.checkout_url) throw new Error("Billing checkout response did not include a checkout URL")
  return Option.some(body as BillingCheckout)
})

export const Billing = {
  status,
  plans,
  checkout,
}
