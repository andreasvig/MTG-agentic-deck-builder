import { useCallback, useState } from "react";

/**
 * Debug mode is one interface-wide preference, not a search setting.
 *
 * It gates the search trace and the deck agent's running cost, so it is owned by
 * the workspace shell and passed down. The storage key predates that move and is
 * kept as it is, because renaming it would silently reset the preference.
 */
export const DEBUG_MODE_STORAGE_KEY = "manabase.search-debug";

export function useDebugMode(): [boolean, (enabled: boolean) => void] {
  const [enabled, setEnabled] = useState(
    () => window.localStorage.getItem(DEBUG_MODE_STORAGE_KEY) === "true",
  );

  const update = useCallback((next: boolean) => {
    setEnabled(next);
    window.localStorage.setItem(DEBUG_MODE_STORAGE_KEY, String(next));
  }, []);

  return [enabled, update];
}
