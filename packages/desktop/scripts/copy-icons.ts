import { $ } from "bun"
import { resolveChannel } from "./utils"

const arg = process.argv[2]
const rawChannel = arg === "dev" || arg === "beta" || arg === "prod" || arg === "asse" ? arg : resolveChannel()
// "asse" uses dev icons (no dedicated icon set)
const iconSet = rawChannel === "asse" ? "dev" : rawChannel

const src = `./icons/${iconSet}`
const dest = "resources/icons"

await $`rm -rf ${dest}`
await $`cp -R ${src} ${dest}`
console.log(`Copied ${iconSet} icons from ${src} to ${dest} (channel: ${rawChannel})`)
