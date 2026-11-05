import { NextResponse } from "next/server";
import { getSettings, updateSettings } from "@/lib/localDb";
import { setDisabledProviders } from "@/lib/disabledProviders.js";
import {
  AI_PROVIDERS,
  isOpenAICompatibleProvider,
  isAnthropicCompatibleProvider,
  isCustomEmbeddingProvider,
} from "@/shared/constants/providers";

export const dynamic = "force-dynamic";

// Compatible/embedding providers are user-created at runtime and so are absent
// from the static registry; their id prefix is the only thing that proves the
// id is real rather than a typo written straight into settings.
function isToggleable(providerId) {
  return (
    Boolean(AI_PROVIDERS[providerId]) ||
    isOpenAICompatibleProvider(providerId) ||
    isAnthropicCompatibleProvider(providerId) ||
    isCustomEmbeddingProvider(providerId)
  );
}

// updateSettings() is transactional at the row level, but the read of the
// current list and the write of the mutated copy happen here, outside that
// transaction. Two concurrent toggles would each read the same list and the
// second write would drop the first one's entry. Serializing toggles through a
// module promise chain makes each read-merge-write atomic within the process,
// which is where all writes to disabledProviders originate.
let toggleChain = Promise.resolve();

function toggleDisabledProvider(providerId, disabled) {
  const run = async () => {
    const settings = await getSettings();
    const current = Array.isArray(settings.disabledProviders)
      ? settings.disabledProviders
      : [];
    const isMember = current.includes(providerId);
    const unchanged = disabled ? isMember : !isMember;
    if (unchanged) {
      // Re-sync the cache anyway: the stored state was already correct, so
      // only the in-memory copy may be stale (fresh process after restart).
      setDisabledProviders(current);
      return current;
    }
    const next = disabled ? [...current, providerId] : current.filter((p) => p !== providerId);

    const updated = await updateSettings({ disabledProviders: next });
    const list = Array.isArray(updated.disabledProviders)
      ? updated.disabledProviders
      : next;
    setDisabledProviders(list);
    return list;
  };
  const result = toggleChain.then(run, run);
  // Keep the chain alive when one toggle fails, but surface only this call's
  // error to its caller.
  toggleChain = result.then(() => {}, () => {});
  return result;
}

export async function PATCH(request, { params }) {
  try {
    const { id } = await params;
    const providerId = String(id || "").trim().toLowerCase();

    if (!isToggleable(providerId)) {
      return NextResponse.json(
        { error: `Unknown provider: ${id}` },
        { status: 400 }
      );
    }

    const body = await request.json().catch(() => ({}));
    const disabled = body.disabled === true;

    const disabledProviders = await toggleDisabledProvider(providerId, disabled);

    return NextResponse.json({
      disabledProviders,
      providerId,
      disabled,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error.message || "Failed to toggle provider" },
      { status: 500 }
    );
  }
}
