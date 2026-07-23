import { CircleCheck, CircleDashed, CircleX, RefreshCw } from "lucide-react";

import type { BackendHealthState } from "../hooks/useBackendHealth";

interface ConnectionStatusProps {
  health: BackendHealthState;
  onRefresh: () => void;
}

const statusCopy = {
  checking: {
    label: "Connecting",
    detail: "Checking local backend",
    Icon: CircleDashed,
  },
  online: {
    label: "Backend online",
    detail: "Local data service ready",
    Icon: CircleCheck,
  },
  offline: {
    label: "Backend offline",
    detail: "Local data service unavailable",
    Icon: CircleX,
  },
} as const;

export function ConnectionStatus({
  health,
  onRefresh,
}: ConnectionStatusProps) {
  const status = statusCopy[health.state];
  const StatusIcon = status.Icon;

  return (
    <div
      className={`connection-status connection-status--${health.state}`}
      role="status"
      aria-live="polite"
    >
      <StatusIcon aria-hidden="true" size={18} />
      <div>
        <strong>{status.label}</strong>
        <span>{status.detail}</span>
      </div>
      <button
        className="icon-button"
        type="button"
        onClick={onRefresh}
        aria-label="Check backend connection"
        title="Check backend connection"
      >
        <RefreshCw aria-hidden="true" size={16} />
      </button>
    </div>
  );
}
