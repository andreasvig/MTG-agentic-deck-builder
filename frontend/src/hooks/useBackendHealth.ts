import { useCallback, useEffect, useRef, useState } from "react";

import type { ApiClient, HealthResponse } from "../lib/api";
import { apiClient } from "../lib/api";

export type BackendHealthState =
  | { state: "checking"; details: null }
  | { state: "online"; details: HealthResponse }
  | { state: "offline"; details: null };

const HEALTH_CHECK_INTERVAL_MS = 30_000;

export function useBackendHealth(client: ApiClient = apiClient) {
  const [health, setHealth] = useState<BackendHealthState>({
    state: "checking",
    details: null,
  });
  const activeController = useRef<AbortController | null>(null);

  const check = useCallback(async () => {
    activeController.current?.abort();
    const controller = new AbortController();
    activeController.current = controller;
    setHealth((current) =>
      current.state === "online"
        ? current
        : { state: "checking", details: null },
    );

    try {
      const details = await client.getHealth(controller.signal);
      setHealth({ state: "online", details });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        return;
      }
      setHealth({ state: "offline", details: null });
    }
  }, [client]);

  useEffect(() => {
    void check();
    const interval = window.setInterval(() => void check(), HEALTH_CHECK_INTERVAL_MS);

    return () => {
      window.clearInterval(interval);
      activeController.current?.abort();
    };
  }, [check]);

  return { health, check };
}
