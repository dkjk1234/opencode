import { readdir, unlink } from "node:fs/promises"
import { resolveChannel } from "./utils"

const arg = process.argv[2]
const channel = arg === "dev" || arg === "beta" || arg === "prod" ? arg : resolveChannel()

const APP_IDS = {
  dev: "com.codexshare.desktop.dev",
  beta: "com.codexshare.desktop.beta",
  prod: "com.codexshare.desktop",
} as const

const PRODUCT_NAMES = {
  dev: "CodexShare Dev",
  beta: "CodexShare Beta",
  prod: "CodexShare",
} as const

const appId = APP_IDS[channel]
const productName = PRODUCT_NAMES[channel]
const summary = `CodexShare AI coding desktop${channel !== "prod" ? ` (${channel})` : ""}`
const resourcesDir = "resources"

const xml = `<?xml version="1.0" encoding="UTF-8"?>
<component type="desktop-application">
  <id>${appId}</id>

  <metadata_license>CC0-1.0</metadata_license>
  <project_license>MIT</project_license>

  <name>${productName}</name>
  <summary>${summary}</summary>

  <developer id="com.codexshare">
    <name>CodexShare</name>
  </developer>

  <description>
    <p>
      CodexShare is a branded AI coding desktop wired to the CodexShare gateway for account login, model access, and credit metering.
    </p>
  </description>

  <launchable type="desktop-id">${appId}.desktop</launchable>

  <content_rating type="oars-1.1" />

  <url type="bugtracker">https://github.com/YOUR_ORG/codexshare-desktop/issues</url>
  <url type="homepage">https://codexshare.local</url>
  <url type="vcs-browser">https://github.com/YOUR_ORG/codexshare-desktop</url>
</component>
`

await Promise.all(
  (await readdir(resourcesDir))
    .filter((name) => name.endsWith(".metainfo.xml"))
    .map((name) => unlink(`${resourcesDir}/${name}`).catch(() => {})),
)

await Bun.write(`${resourcesDir}/${appId}.metainfo.xml`, xml)
console.log(`Generated metainfo for ${channel} at resources/${appId}.metainfo.xml`)
