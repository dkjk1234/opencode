import { cmd } from "./cmd"
import { Duration, Effect, Match, Option } from "effect"
import { UI } from "../ui"
import { Account } from "@/account/account"
import { AccountID, OrgID, PollExpired, type PollResult, type AccountError } from "@/account/schema"
import { effectCmd } from "../effect-cmd"
import * as Prompt from "../effect/prompt"
import open from "open"
import { randomUUID } from "node:crypto"
import { Billing, type BillingPlanSummary } from "@/account/billing"

const openBrowser = (url: string) => Effect.promise(() => open(url).catch(() => undefined))

const println = (msg: string) => Effect.sync(() => UI.println(msg))

const dim = (value: string) => UI.Style.TEXT_DIM + value + UI.Style.TEXT_NORMAL

const activeSuffix = (isActive: boolean) => (isActive ? dim(" (active)") : "")

export const resolveConsoleUrl = () =>
  (process.env.OPENCODE_CONSOLE_URL || process.env.YOURSERVICE_CONSOLE_URL || "https://llms.ai.kr/opencode-gateway").replace(
    /\/+$/,
    "",
  )

export const defaultConsoleUrl = resolveConsoleUrl()

export const formatAccountLabel = (account: { email: string; url: string }, isActive: boolean) =>
  `${account.email} ${dim(account.url)}${activeSuffix(isActive)}`

const formatOrgChoiceLabel = (account: { email: string }, org: { name: string }, isActive: boolean) =>
  `${org.name} (${account.email})${activeSuffix(isActive)}`

export const formatOrgLine = (
  account: { email: string; url: string },
  org: { id: string; name: string },
  isActive: boolean,
) => {
  const dot = isActive ? UI.Style.TEXT_SUCCESS + "●" + UI.Style.TEXT_NORMAL : " "
  const name = isActive ? UI.Style.TEXT_HIGHLIGHT_BOLD + org.name + UI.Style.TEXT_NORMAL : org.name
  return `  ${dot} ${name}  ${dim(account.email)}  ${dim(account.url)}  ${dim(org.id)}`
}

export const formatBillingPlanLabel = (plan: BillingPlanSummary) => {
  const amount = new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: plan.currency || "usd",
  }).format((plan.amount || 0) / 100)
  return `${plan.name || plan.id} - ${amount} - ${plan.credits.toLocaleString()} credits`
}

const isActiveOrgChoice = (
  active: Option.Option<{ id: AccountID; active_org_id: OrgID | null }>,
  choice: { accountID: AccountID; orgID: OrgID },
) => Option.isSome(active) && active.value.id === choice.accountID && active.value.active_org_id === choice.orgID

const loginEffect = Effect.fn("login")(function* (url: string) {
  const service = yield* Account.Service

  yield* Prompt.intro("Log in")
  const login = yield* service.login(url)

  yield* Prompt.log.info("Go to: " + login.url)
  yield* Prompt.log.info("Enter code: " + login.user)
  yield* openBrowser(login.url)

  const s = Prompt.spinner()
  yield* s.start("Waiting for authorization...")

  const poll = (wait: Duration.Duration): Effect.Effect<PollResult, AccountError> =>
    Effect.gen(function* () {
      yield* Effect.sleep(wait)
      const result = yield* service.poll(login)
      if (result._tag === "PollPending") return yield* poll(wait)
      if (result._tag === "PollSlow") return yield* poll(Duration.sum(wait, Duration.seconds(5)))
      return result
    })

  const result = yield* poll(login.interval).pipe(
    Effect.timeout(login.expiry),
    Effect.catchTag("TimeoutError", () => Effect.succeed(new PollExpired())),
  )

  yield* Match.valueTags(result, {
    PollSuccess: (r) =>
      Effect.gen(function* () {
        yield* s.stop("Logged in as " + r.email)
        yield* Prompt.outro("Done")
      }),
    PollExpired: () => s.stop("Device code expired", 1),
    PollDenied: () => s.stop("Authorization denied", 1),
    PollError: (r) => s.stop("Error: " + String(r.cause), 1),
    PollPending: () => s.stop("Unexpected state", 1),
    PollSlow: () => s.stop("Unexpected state", 1),
  })
})

const logoutEffect = Effect.fn("logout")(function* (email?: string) {
  const service = yield* Account.Service
  const accounts = yield* service.list()
  if (accounts.length === 0) return yield* println("Not logged in")

  if (email) {
    const match = accounts.find((a) => a.email === email)
    if (!match) return yield* println("Account not found: " + email)
    yield* service.remove(match.id)
    yield* Prompt.outro("Logged out from " + email)
    return
  }

  const active = yield* service.active()
  const activeID = Option.map(active, (a) => a.id)

  yield* Prompt.intro("Log out")

  const opts = accounts.map((a) => {
    const isActive = Option.isSome(activeID) && activeID.value === a.id
    return {
      value: a,
      label: formatAccountLabel(a, isActive),
    }
  })

  const selected = yield* Prompt.select({ message: "Select account to log out", options: opts })
  if (Option.isNone(selected)) return

  yield* service.remove(selected.value.id)
  yield* Prompt.outro("Logged out from " + selected.value.email)
})

interface OrgChoice {
  orgID: OrgID
  accountID: AccountID
  label: string
}

const switchEffect = Effect.fn("switch")(function* () {
  const service = yield* Account.Service

  const groups = yield* service.orgsByAccount()
  if (groups.length === 0) return yield* println("Not logged in")

  const active = yield* service.active()

  const opts = groups.flatMap((group) =>
    group.orgs.map((org) => {
      const isActive = isActiveOrgChoice(active, { accountID: group.account.id, orgID: org.id })
      return {
        value: { orgID: org.id, accountID: group.account.id, label: org.name },
        label: formatOrgChoiceLabel(group.account, org, isActive),
      }
    }),
  )
  if (opts.length === 0) return yield* println("No orgs found")

  yield* Prompt.intro("Switch org")

  const selected = yield* Prompt.select<OrgChoice>({ message: "Select org", options: opts })
  if (Option.isNone(selected)) return

  const choice = selected.value
  yield* service.use(choice.accountID, Option.some(choice.orgID))
  yield* Prompt.outro("Switched to " + choice.label)
})

const orgsEffect = Effect.fn("orgs")(function* () {
  const service = yield* Account.Service

  const groups = yield* service.orgsByAccount()
  if (groups.length === 0) return yield* println("No accounts found")
  if (!groups.some((group) => group.orgs.length > 0)) return yield* println("No orgs found")

  const active = yield* service.active()

  for (const group of groups) {
    for (const org of group.orgs) {
      const isActive = isActiveOrgChoice(active, { accountID: group.account.id, orgID: org.id })
      yield* println(formatOrgLine(group.account, org, isActive))
    }
  }
})

const openEffect = Effect.fn("open")(function* () {
  const service = yield* Account.Service
  const active = yield* service.active()
  if (Option.isNone(active)) return yield* println("No active account")

  const url = active.value.url
  yield* openBrowser(url)
  yield* Prompt.outro("Opened " + url)
})

const billingEffect = Effect.fn("billing")(function* (planID?: string) {
  const service = yield* Account.Service
  const active = yield* service.active()
  if (Option.isNone(active)) return yield* println("No active account")

  const account = active.value
  const accessToken = yield* service.token(account.id)
  if (Option.isNone(accessToken)) return yield* println("No usable console token. Run `opencode console login` again.")

  yield* Prompt.intro("Billing")
  const plansOption = yield* Billing.plans().pipe(
    Effect.catch((error) => Effect.fail(new Error(`Could not load billing plans: ${error.message}`))),
  )
  const plans = Option.getOrElse(plansOption, () => [] as BillingPlanSummary[])
  if (!plans.length) {
    yield* Prompt.log.warn("No billing plans are configured on " + account.url)
    return yield* Prompt.outro("Billing is not enabled yet")
  }

  let selectedPlanID = planID?.trim()
  if (!selectedPlanID) {
    if (plans.length === 1) {
      selectedPlanID = plans[0].id
    } else {
      const selected = yield* Prompt.select({
        message: "Select a credit plan",
        options: plans.map((plan) => ({ value: plan.id, label: formatBillingPlanLabel(plan) })),
      })
      if (Option.isNone(selected)) return yield* Prompt.outro("Canceled")
      selectedPlanID = selected.value
    }
  }

  const selectedPlan = plans.find((plan) => plan.id === selectedPlanID)
  if (!selectedPlan) {
    yield* Prompt.log.error(`Unknown billing plan: ${selectedPlanID}`)
    yield* Prompt.log.info("Available plans: " + plans.map((plan) => plan.id).join(", "))
    return yield* Prompt.outro("Billing checkout was not created")
  }

  const checkout = yield* Billing.checkout({
    planID: selectedPlan.id,
    idempotencyKey: `opencode-${Date.now()}-${randomUUID()}`,
  }).pipe(Effect.catch((error) => Effect.fail(new Error(`Could not create billing checkout: ${error.message}`))))
  if (Option.isNone(checkout)) return yield* println("No active account")
  const checkoutValue = checkout.value

  if (!checkoutValue.checkout_url) {
    yield* Prompt.log.error("Billing checkout response did not include a checkout URL")
    return yield* Prompt.outro("Billing checkout was not opened")
  }

  yield* Prompt.log.info(formatBillingPlanLabel(selectedPlan))
  yield* Prompt.log.info("Opening: " + checkoutValue.checkout_url)
  yield* openBrowser(checkoutValue.checkout_url)
  yield* Prompt.outro("Checkout opened")
})

export const LoginCommand = effectCmd({
  command: "login [url]",
  describe: false,
  instance: false,
  builder: (yargs) =>
    yargs.positional("url", {
      describe: "server URL",
      type: "string",
    }),
  handler: Effect.fn("Cli.account.login")(function* (args) {
    UI.empty()
    yield* Effect.orDie(loginEffect(args.url ?? resolveConsoleUrl()))
  }),
})

export const LogoutCommand = effectCmd({
  command: "logout [email]",
  describe: false,
  instance: false,
  builder: (yargs) =>
    yargs.positional("email", {
      describe: "account email to log out from",
      type: "string",
    }),
  handler: Effect.fn("Cli.account.logout")(function* (args) {
    UI.empty()
    yield* Effect.orDie(logoutEffect(args.email))
  }),
})

export const SwitchCommand = effectCmd({
  command: "switch",
  describe: false,
  instance: false,
  handler: Effect.fn("Cli.account.switch")(function* () {
    UI.empty()
    yield* Effect.orDie(switchEffect())
  }),
})

export const OrgsCommand = effectCmd({
  command: "orgs",
  describe: false,
  instance: false,
  handler: Effect.fn("Cli.account.orgs")(function* () {
    UI.empty()
    yield* Effect.orDie(orgsEffect())
  }),
})

export const OpenCommand = effectCmd({
  command: "open",
  describe: false,
  instance: false,
  handler: Effect.fn("Cli.account.open")(function* () {
    UI.empty()
    yield* Effect.orDie(openEffect())
  }),
})

export const BillingCommand = effectCmd({
  command: "billing [plan]",
  describe: false,
  instance: false,
  builder: (yargs) =>
    yargs.positional("plan", {
      describe: "billing plan id",
      type: "string",
    }),
  handler: Effect.fn("Cli.account.billing")(function* (args) {
    UI.empty()
    yield* Effect.orDie(billingEffect(args.plan as string | undefined))
  }),
})

export const ConsoleCommand = cmd({
  command: "console",
  describe: false,
  builder: (yargs) =>
    yargs
      .command({
        ...LoginCommand,
        describe: "log in to console",
      })
      .command({
        ...LogoutCommand,
        describe: "log out from console",
      })
      .command({
        ...SwitchCommand,
        describe: "switch active org",
      })
      .command({
        ...OrgsCommand,
        describe: "list orgs",
      })
      .command({
        ...OpenCommand,
        describe: "open active console account",
      })
      .command({
        ...BillingCommand,
        describe: "open credit billing checkout",
      })
      .demandCommand(),
  async handler() {},
})
