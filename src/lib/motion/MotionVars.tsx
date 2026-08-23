// Publishes the motion tokens to CSS custom properties on <html>.
//
// Renders nothing, and is mounted unconditionally and immediately — never
// behind an idle gate. Several rules in the stylesheet read these directly,
// with no fallback value, and an undefined custom property there is not a
// default: it is an invalid declaration, so the transition silently becomes
// instant.
//
// Keep this eager even if a smooth-scroll or other desktop-only module is added
// later. Publishing the variables from inside such a module is exactly how a
// phone ends up with a header whose transitions have no duration.

import { useEffect } from "react";
import { motionCssVars } from "./tokens";

export default function MotionVars() {
  useEffect(() => {
    const root = document.documentElement;
    const vars = motionCssVars();
    for (const [name, value] of Object.entries(vars)) {
      root.style.setProperty(name, value);
    }
    return () => {
      for (const name of Object.keys(vars)) root.style.removeProperty(name);
    };
  }, []);

  return null;
}
