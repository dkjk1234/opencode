import { describe, expect, test } from "bun:test"
import stripAnsi from "strip-ansi"

import { defaultConsoleUrl, formatAccountLabel, formatOrgLine, resolveConsoleUrl } from "../../src/cli/cmd/account"

describe("console account display", () => {
  test("uses the local service gateway as the default login URL", () => {
    expect(defaultConsoleUrl).toBe("http://127.0.0.1:8788")
  })

  test("allows YOURSERVICE_CONSOLE_URL to override the default login URL", () => {
    const previous = process.env.YOURSERVICE_CONSOLE_URL
    process.env.YOURSERVICE_CONSOLE_URL = "https://console.codexshare.example/"
    try {
      expect(resolveConsoleUrl()).toBe("https://console.codexshare.example")
    } finally {
      if (previous === undefined) delete process.env.YOURSERVICE_CONSOLE_URL
      else process.env.YOURSERVICE_CONSOLE_URL = previous
    }
  })

  test("includes the account url in account labels", () => {
    expect(stripAnsi(formatAccountLabel({ email: "one@example.com", url: "https://one.example.com" }, false))).toBe(
      "one@example.com https://one.example.com",
    )
  })

  test("includes the active marker in account labels", () => {
    expect(stripAnsi(formatAccountLabel({ email: "one@example.com", url: "https://one.example.com" }, true))).toBe(
      "one@example.com https://one.example.com (active)",
    )
  })

  test("includes the account url in org rows", () => {
    expect(
      stripAnsi(
        formatOrgLine({ email: "one@example.com", url: "https://one.example.com" }, { id: "org-1", name: "One" }, true),
      ),
    ).toBe("  ● One  one@example.com  https://one.example.com  org-1")
  })
})
