// Fork only. playwright.config.ts starts the local Worker instead of the Go server when this is
// set, and the few steps that reach into PocketBase directly have no Worker counterpart.
export const cloudflareRuntime = process.env["RENEWLET_E2E_RUNTIME"]?.trim() === "cloudflare";
