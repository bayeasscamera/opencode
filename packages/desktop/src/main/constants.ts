import { app } from "electron"

type Channel = "dev" | "beta" | "prod" | "asse"
const raw = import.meta.env.OPENCODE_CHANNEL
export const CHANNEL: Channel = raw === "dev" || raw === "beta" || raw === "prod" || raw === "asse" ? raw : "dev"

// Only the channels that publish a release feed can update themselves. `dev` is
// never packaged, and `asse` declares no `publish`, so neither ships an
// `app-update.yml`; `checkForUpdates` would reject with ENOENT and the updater
// dialog would report a failed check. `electron-updater` also needs a signed,
// notarized app and a `zip` artifact, which the `asse` channel does not produce.
export const UPDATER_ENABLED = app.isPackaged && (CHANNEL === "beta" || CHANNEL === "prod")
