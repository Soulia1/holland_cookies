import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

// A slow font provider must not block the operations UI. Start the stylesheet
// after window.load, then apply it when ready without an inline CSP-sensitive
// event handler.
const webFonts = document.getElementById("web-fonts") as HTMLLinkElement | null;
if (webFonts) {
  const loadWebFonts = () => {
    const href = webFonts.dataset.href;
    if (!href) return;
    webFonts.addEventListener("load", () => { webFonts.media = "all"; }, { once: true });
    webFonts.href = href;
  };
  if (document.readyState === "complete") loadWebFonts();
  else window.addEventListener("load", loadWebFonts, { once: true });
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
