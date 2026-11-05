export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { initConsoleLogCapture } = await import("@/lib/consoleLogBuffer");
    initConsoleLogCapture();

    // Server-only: lets capabilities.js read the synced catalog without pulling
    // node:fs into the dashboard's browser bundle.
    const { installCatalogSource } = await import("open-sse/providers/catalogOverride.js");
    await installCatalogSource();

    const { startModelCatalogSync } = await import("@/lib/modelCatalog/sync.js");
    startModelCatalogSync();

    // Seed the in-memory disabled-providers cache from the persistent store
    const { getSettings } = await import("@/lib/localDb.js");
    const { setDisabledProviders } = await import("@/lib/disabledProviders.js");
    const settings = await getSettings();
    setDisabledProviders(settings.disabledProviders || []);
  }
}
