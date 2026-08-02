import { Icon, type IconName } from "./Icon";
import type { BackendHealthState } from "../hooks/useBackendHealth";

interface ConnectionStatusProps {
  health: BackendHealthState;
  onRefresh: () => void;
}

const statusCopy = {
  checking: {
    label: "Connecting",
    detail: "Checking local backend",
    icon: "pending",
  },
  online: {
    label: "Backend online",
    detail: "Local data service ready",
    icon: "checkCircle",
  },
  offline: {
    label: "Backend offline",
    detail: "Local data service unavailable",
    icon: "xCircle",
  },
} as const satisfies Record<string, { label: string; detail: string; icon: IconName }>;

export function ConnectionStatus({
  health,
  onRefresh,
}: ConnectionStatusProps) {
  const status = statusCopy[health.state];

  return (
    <div
      className={`connection-status connection-status--${health.state}`}
      role="status"
      aria-live="polite"
    >
      <Icon name={status.icon} aria-hidden="true" size={18} />
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
        <Icon name="refresh" aria-hidden="true" size={16} />
      </button>
    </div>
  );
}
