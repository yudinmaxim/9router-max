import { NextResponse } from "next/server";
import { getSettings, updateSettings } from "@/lib/localDb";
import { resolveProviderAlias } from "open-sse/services/model.js";
import {
  ACP_PERMISSION_ACTIONS,
  ACP_PERMISSION_VALUES,
} from "open-sse/config/runtimeConfig.js";

export const dynamic = "force-dynamic";

const ACTIONS = new Set(ACP_PERMISSION_ACTIONS);
const VALUES = new Set(ACP_PERMISSION_VALUES);

/**
 * Validate at the trust boundary.
 *
 * This payload decides whether a local agent may run commands on the user's
 * machine, so nothing here is taken on trust: an unrecognised action or value
 * is rejected outright rather than coerced to something permissive. The UI
 * validates too, but this is the gate that actually matters.
 *
 * Returns { policy } (null = "inherit the router default") or { error }.
 */
function normalizePolicy(input) {
  if (input === null) return { policy: null };
  if (typeof input !== "object" || Array.isArray(input)) {
    return { error: "policy must be an object" };
  }

  const out = {};
  for (const [action, scopes] of Object.entries(input)) {
    if (!ACTIONS.has(action)) {
      return { error: `Unknown action: ${action}` };
    }
    if (typeof scopes !== "object" || scopes === null || Array.isArray(scopes)) {
      return { error: `${action} must be an object with inside/outside` };
    }
    const clean = {};
    for (const [scope, value] of Object.entries(scopes)) {
      if (scope !== "inside" && scope !== "outside") {
        return { error: `Unknown scope for ${action}: ${scope}` };
      }
      if (!VALUES.has(value)) {
        return { error: `Invalid value for ${action}.${scope}: ${value}` };
      }
      clean[scope] = value;
    }
    if (Object.keys(clean).length) out[action] = clean;
  }
  return { policy: Object.keys(out).length ? out : null };
}

async function readSettings() {
  const settings = await getSettings();
  return {
    defaults: settings.acpPermissions || {},
    byProvider: settings.acpPermissionsByProvider || {},
  };
}

/**
 * GET /api/acp-permissions
 * GET /api/acp-permissions?provider=<id> — that provider's override
 */
export async function GET(request) {
  try {
    const { defaults, byProvider } = await readSettings();
    const provider = new URL(request.url).searchParams.get("provider");
    if (!provider) {
      return NextResponse.json({
        defaults,
        byProvider,
        providers: Object.keys(byProvider),
        actions: ACP_PERMISSION_ACTIONS,
        values: ACP_PERMISSION_VALUES,
      });
    }
    const canonical = resolveProviderAlias(provider);
    return NextResponse.json({
      policy: byProvider[canonical] || null,
      defaults,
    });
  } catch (error) {
    console.log("Error getting ACP permissions:", error);
    return NextResponse.json({ error: "Failed to get permissions" }, { status: 500 });
  }
}

/**
 * PUT /api/acp-permissions — body: { policy, provider? }
 *   no provider → sets the router-wide default
 *   with provider → sets that provider's override (null clears it)
 */
export async function PUT(request) {
  try {
    const body = await request.json().catch(() => ({}));
    const { policy, error } = normalizePolicy(body.policy);
    if (error) return NextResponse.json({ error }, { status: 400 });

    const provider = body.provider ? resolveProviderAlias(body.provider) : null;

    if (!provider) {
      await updateSettings({ acpPermissions: policy || {} });
      return NextResponse.json({ defaults: policy || {} });
    }

    const { byProvider } = await readSettings();
    const next = { ...byProvider };
    if (policy) next[provider] = policy;
    else delete next[provider];
    await updateSettings({ acpPermissionsByProvider: next });
    return NextResponse.json({ policy: policy || null, providers: Object.keys(next) });
  } catch (error) {
    console.log("Error saving ACP permissions:", error);
    return NextResponse.json({ error: "Failed to save permissions" }, { status: 500 });
  }
}