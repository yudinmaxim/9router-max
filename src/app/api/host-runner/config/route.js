import { NextResponse } from "next/server";
import {
  readHostRunnerSnapshot,
  signConfigMessage,
  submitConfigMessage,
  validateHostRunnerConfig,
  HostRunnerConfigError,
} from "@/lib/hostRunner/config";
import { verifyDashboardPassword } from "@/lib/auth/dashboardSession";

export const dynamic = "force-dynamic";

/**
 * GET renders the whitelist the host daemon actually loaded.
 *
 * Nothing here reads a file: the whitelist lives outside every container mount,
 * so the only view available is the snapshot the daemon publishes into the
 * read-only `out` mount. A missing snapshot means the daemon is not running,
 * which is a normal answer rather than an error.
 */
export async function GET() {
  try {
    const snapshot = await readHostRunnerSnapshot();
    if (!snapshot) {
      return NextResponse.json({
        available: false,
        writable: false,
        authConfigured: false,
        configPath: null,
        salt: null,
        config: null,
        error:
          "The host daemon is not running — it has not published a snapshot to the queue.",
      });
    }
    const config =
      snapshot.config === undefined || snapshot.config === null
        ? null
        : validateHostRunnerConfig(snapshot.config);
    const authConfigured =
      snapshot.authConfigured === true && typeof snapshot.salt === "string";
    return NextResponse.json({
      available: true,
      writable: authConfigured,
      authConfigured,
      configPath:
        typeof snapshot.configPath === "string" ? snapshot.configPath : null,
      salt: authConfigured ? snapshot.salt : null,
      config,
    });
  } catch (error) {
    if (error instanceof HostRunnerConfigError) {
      return NextResponse.json(
        {
          available: true,
          writable: false,
          authConfigured: false,
          configPath: null,
          salt: null,
          config: null,
          error: error.message,
        },
        { status: 422 },
      );
    }
    console.error("[host-runner] read snapshot failed:", error);
    return NextResponse.json(
      {
        available: false,
        writable: false,
        authConfigured: false,
        configPath: null,
        salt: null,
        config: null,
        error: "failed to read the daemon snapshot",
      },
      { status: 500 },
    );
  }
}

/** Daemon rejection codes → HTTP status. */
const REJECTION_STATUS = {
  bad_request: 400,
  invalid_config: 422,
  auth_not_configured: 409,
  bad_mac: 409,
  stale_snapshot: 409,
  stale_timestamp: 409,
  rate_limited: 429,
  write_failed: 500,
  internal_error: 500,
};

/**
 * PUT submits a signed whitelist edit to the host daemon.
 *
 * The body is untrusted and re-validated in full before anything is signed.
 * The password is checked here purely to answer a typo immediately — the
 * authoritative check happens on the host, because an agent can write straight
 * into `in/` and never passes through this route at all.
 */
export async function PUT(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "request body must be JSON" },
      { status: 400 },
    );
  }

  const config = body?.config;
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return NextResponse.json(
      { error: "`config` is required" },
      { status: 400 },
    );
  }
  const password = body?.password;
  if (typeof password !== "string" || !password) {
    return NextResponse.json(
      {
        error: "The dashboard password is required to change the whitelist.",
        code: "password_required",
      },
      { status: 401 },
    );
  }

  let clean;
  try {
    clean = validateHostRunnerConfig(config);
  } catch (error) {
    if (error instanceof HostRunnerConfigError) {
      return NextResponse.json({ error: error.message }, { status: 422 });
    }
    throw error;
  }

  try {
    if (!(await verifyDashboardPassword(password))) {
      return NextResponse.json(
        { error: "Invalid password.", code: "invalid_password" },
        { status: 401 },
      );
    }
  } catch (error) {
    console.error("[host-runner] password check failed:", error);
    return NextResponse.json(
      { error: "failed to verify the password" },
      { status: 500 },
    );
  }

  let snapshot;
  try {
    snapshot = await readHostRunnerSnapshot();
  } catch (error) {
    if (error instanceof HostRunnerConfigError) {
      return NextResponse.json(
        { error: error.message, code: "bad_snapshot" },
        { status: 422 },
      );
    }
    console.error("[host-runner] read snapshot failed:", error);
    return NextResponse.json(
      { error: "failed to read the daemon snapshot" },
      { status: 500 },
    );
  }

  if (!snapshot) {
    return NextResponse.json(
      {
        error:
          "The host daemon is not running, so there is nothing to save to.",
        code: "daemon_unavailable",
      },
      { status: 503 },
    );
  }
  if (snapshot.authConfigured !== true || typeof snapshot.salt !== "string") {
    return NextResponse.json(
      {
        error:
          "The host has no key material yet. Run `hostrunner-ctl set-password` on the host once, then reload this page.",
        code: "auth_not_configured",
      },
      { status: 409 },
    );
  }

  let message;
  try {
    message = signConfigMessage({
      config: clean,
      password,
      salt: snapshot.salt,
    });
  } catch (error) {
    if (error instanceof HostRunnerConfigError) {
      return NextResponse.json(
        { error: error.message, code: "sign_failed" },
        { status: 422 },
      );
    }
    throw error;
  }

  let result;
  try {
    result = await submitConfigMessage(message);
  } catch (error) {
    if (error instanceof HostRunnerConfigError) {
      return NextResponse.json(
        { error: error.message, code: "queue_unavailable" },
        { status: 503 },
      );
    }
    console.error("[host-runner] submit failed:", error);
    return NextResponse.json(
      { error: "failed to submit the config" },
      { status: 500 },
    );
  }

  if (!result) {
    return NextResponse.json(
      {
        error: "The host daemon did not answer in time — is it running?",
        code: "timeout",
      },
      { status: 504 },
    );
  }

  if (result.status !== "ok") {
    const code =
      typeof result.code === "string" ? result.code : "internal_error";
    // The password already passed the local check, so a MAC mismatch means the
    // host key was derived from a *different* password — say that instead of
    // implying the operator mistyped.
    const error =
      code === "bad_mac"
        ? "Your password is correct, but the host key was created from a different one. Run `hostrunner-ctl set-password` on the host with this password, then save again."
        : code === "stale_snapshot"
          ? "The host key changed while this page was open. Press Reload and save again."
          : typeof result.error === "string" && result.error
            ? result.error
            : "the host daemon rejected the change";
    return NextResponse.json(
      { error, code },
      { status: REJECTION_STATUS[code] ?? 500 },
    );
  }

  return NextResponse.json({
    ok: true,
    configPath:
      typeof result.configPath === "string" ? result.configPath : null,
    config: validateHostRunnerConfig(result.config),
    available: true,
    writable: true,
    authConfigured: true,
    salt: snapshot.salt,
  });
}
