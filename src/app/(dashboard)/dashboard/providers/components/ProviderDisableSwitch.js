"use client";

/**
 * Global on/off for one provider, backed by settings.disabledProviders.
 *
 * This is deliberately separate from the connection toggle next to it: that one
 * pauses a provider's account rows, while turning a provider off here removes it
 * from the engine, /v1/models and the ACP probes entirely. So the switch has to
 * be reachable even when the provider has no connections at all — every local
 * agent (omp-acp, devin-cli, …) is a noAuth provider with zero rows, and the
 * connection toggle is hidden when total is 0.
 *
 * The card is wrapped in a <Link>, so the click must not navigate.
 */

import PropTypes from "prop-types";
import { Toggle } from "@/shared/components";

export default function ProviderDisableSwitch({ disabled, onToggle, name }) {
  return (
    <div
      className="flex items-center gap-1"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onToggle(!disabled);
      }}
      title={disabled ? `Enable ${name}` : `Disable ${name}`}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          e.stopPropagation();
          onToggle(!disabled);
        }
      }}
    >
      <span
        className={`material-symbols-outlined text-[15px] ${disabled ? "text-text-muted" : "text-green-500"}`}
      >
        {disabled ? "power_off" : "power"}
      </span>
      <Toggle size="sm" checked={!disabled} onChange={() => {}} />
    </div>
  );
}

ProviderDisableSwitch.propTypes = {
  disabled: PropTypes.bool.isRequired,
  onToggle: PropTypes.func.isRequired,
  name: PropTypes.string.isRequired,
};
