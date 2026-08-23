import { useEffect } from "react";
import MotionVars from "@/lib/motion/MotionVars";
import { dismissSplash } from "@/lib/splash";
import TopBar from "@/sections/TopBar";
import Hero from "@/sections/Hero";
import MenuGrid from "@/sections/MenuGrid";
import Craft from "@/sections/Craft";
import Visit from "@/sections/Visit";
import Footer from "@/sections/Footer";

export default function App() {
  // Asked for from a mount effect, not from main.tsx immediately after
  // `createRoot().render()` — a concurrent root schedules that render rather
  // than performing it, so asking there requests the splash while the page
  // underneath is still empty.
  //
  // This is only a *request*. The hero holds the splash until its photograph
  // has decoded, and the controller will not act until nothing is holding and
  // the browser has actually painted the loader. See lib/splash.ts.
  useEffect(() => {
    dismissSplash();
  }, []);

  return (
    <>
      {/* Mounted unconditionally and eagerly: several stylesheet rules read the
          motion custom properties with no fallback, and an undefined custom
          property there is an invalid declaration rather than a default. */}
      <MotionVars />

      <a
        href="#menu"
        className="sr-only focus:not-sr-only focus:fixed focus:top-4 focus:left-4 focus:z-[900] focus:bg-deep-burgundy focus:text-white focus:px-5 focus:py-3 focus:rounded-sm focus:font-body focus:text-[12px] focus:font-semibold focus:uppercase focus:tracking-[0.15em]"
      >
        Skip to menu
      </a>

      <TopBar />

      <main>
        <Hero />
        <MenuGrid />
        <Craft />
        <Visit />
      </main>

      <Footer />
    </>
  );
}
