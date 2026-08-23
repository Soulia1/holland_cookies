import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

const container = document.getElementById("root");
if (!container) throw new Error("#root is missing from index.html");

// The splash is deliberately *not* dismissed here. A concurrent root schedules
// the render rather than performing it, so asking on the next line would retire
// the loader while the page underneath is still empty. App does it from a mount
// effect instead — see lib/splash.ts.
createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
