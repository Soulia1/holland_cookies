import { useEffect, useState } from "react";

/** Tailwind's `lg` — the width at which the sidebar can sit beside the content. */
export const DESKTOP_QUERY = "(min-width: 1024px)";

/**
 * Live match for a media query. Initialised from the real value so the first
 * paint is already correct — starting at `false` made the sidebar flash as a
 * drawer on desktop for a frame.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(
    () => typeof window !== "undefined" && window.matchMedia(query).matches
  );

  useEffect(() => {
    const list = window.matchMedia(query);
    const onChange = (e: MediaQueryListEvent) => setMatches(e.matches);
    setMatches(list.matches);
    list.addEventListener("change", onChange);
    return () => list.removeEventListener("change", onChange);
  }, [query]);

  return matches;
}

export function useIsDesktop(): boolean {
  return useMediaQuery(DESKTOP_QUERY);
}
