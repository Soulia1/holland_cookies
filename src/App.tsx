import { lazy, Suspense, useEffect, useRef } from "react";
import { AuthProvider } from "@/lib/auth";
import { CartProvider, useCart } from "@/lib/cart";
import { useOnceOpened } from "@/lib/useOnceOpened";
import { LanguageProvider, useLang } from "@/lib/i18n";
import MotionVars from "@/lib/motion/MotionVars";
import { usePath } from "@/lib/router";
import { dismissSplash } from "@/lib/splash";
import MenuPage from "@/pages/MenuPage";

// Loaded on demand.
//
// Checkout, tracking and order history pull in the API client, the form
// primitives and the order types, and none of that is wanted by the visitor who
// has just landed on the home page — where the boot splash is held open until
// the hero photograph decodes, behind whatever the entry chunk costs. Putting
// these three in that chunk added ~230KB to the bundle the hero waits for, to
// render surfaces nobody has asked for. Same reasoning as PanDetail.
// The drawer brings Radix Dialog with it and is closed on load. Left eager it
// put the whole dialog primitive — focus trap, scroll lock, dismissable layer —
// into the chunk the hero's splash waits on, for a surface that is not on
// screen. Fetched the first time the cart is opened and kept from then on.
const CartDrawer = lazy(() => import("@/components/CartDrawer"));
const CheckoutPage = lazy(() => import("@/pages/CheckoutPage"));
const TrackPage = lazy(() => import("@/pages/TrackPage"));
const AccountPage = lazy(() => import("@/pages/AccountPage"));
import TopBar from "@/sections/TopBar";
import Hero from "@/sections/Hero";
import MenuGrid from "@/sections/MenuGrid";
import Craft from "@/sections/Craft";
import BuildYourBox from "@/sections/BuildYourBox";
import Footer from "@/sections/Footer";

function Home() {
  return (
    <main>
      <Hero />
      <MenuGrid />
      <BuildYourBox />
      <Craft />
    </main>
  );
}

/**
 * The application, inside the providers.
 *
 * Split out so it can call `useLang` — a provider cannot consume its own
 * context. Both providers sit above the router rather than inside a page, which
 * is what makes the language and the cart survive navigation: neither is ever
 * unmounted by a route change, so there is nothing to restore.
 */
/**
 * The routes.
 *
 * Still a lookup table rather than a router library — the site now has five
 * pages instead of two, which is exactly the growth the comment in
 * lib/router.tsx anticipated and still well short of needing parameters or
 * nested outlets. When one of these needs a path segment, replace the router
 * wholesale rather than growing it.
 */
const PAGES: Record<string, () => React.ReactElement> = {
  "/menu": () => <MenuPage />,
  "/checkout": () => <CheckoutPage />,
  "/track": () => <TrackPage />,
  "/account": () => <AccountPage />,
};

/**
 * Mounts the cart drawer, but only once the cart has actually been opened.
 *
 * `useOnceOpened` keeps it mounted from then on, so the closing animation runs
 * and reopening costs nothing.
 */
function CartMount() {
  const { open } = useCart();
  const everOpened = useOnceOpened(open);
  if (!everOpened) return null;
  return (
    <Suspense fallback={null}>
      <CartDrawer />
    </Suspense>
  );
}

function Shell() {
  const path = usePath();
  const { t } = useLang();
  // Trailing slashes normalised so `/checkout/` and `/checkout` are one route.
  const route = path.length > 1 ? path.replace(/\/+$/, "") : path;
  const isMenu = route === "/menu";
  const page = PAGES[route];
  // The order flow: checkout, its confirmation, tracking and history.
  const isEditorial = route === "/checkout" || route === "/track" || route === "/account";

  // Asked for from a mount effect, not from main.tsx immediately after
  // `createRoot().render()` — a concurrent root schedules that render rather
  // than performing it, so asking there requests the splash while the page
  // underneath is still empty.
  //
  // This is only a *request*. On the home page the hero holds the splash until
  // its photograph has decoded, and the controller will not act until nothing
  // is holding and the browser has actually painted the loader. The menu page
  // has no such asset, so nothing holds and it retires on the paint gate alone.
  // See lib/splash.ts.
  useEffect(() => {
    dismissSplash();
  }, []);

  // A new page starts at the top — except on the very first render, where the
  // document may carry a hash that MenuPage is about to scroll to, and except
  // when the navigation itself named an anchor.
  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    if (window.location.hash) return;
    window.scrollTo({ top: 0, behavior: "auto" });
  }, [path]);

  return (
    <>
      {/* Mounted unconditionally and eagerly: several stylesheet rules read the
          motion custom properties with no fallback, and an undefined custom
          property there is an invalid declaration rather than a default. */}
      <MotionVars />

      <a
        href={isMenu ? "#menu-content" : "#menu"}
        className="sr-only focus:not-sr-only focus:fixed focus:top-4 focus:left-4 focus:z-[900] focus:bg-deep-burgundy focus:text-white focus:px-5 focus:py-3 focus:rounded-sm focus:font-body focus:text-[12px] focus:font-semibold focus:uppercase focus:tracking-[0.15em]"
      >
        {t.skipToMenu}
      </a>

      <TopBar />

      {/* No fallback element: these are whole pages reached by a click, and a
          spinner that flashes for one frame on a warm chunk is worse than the
          brief nothing it replaces. */}
      {page ? <Suspense fallback={null}>{page()}</Suspense> : <Home />}

      {/* No marketing footer over the order flow. Scooby's checkout is an
          overlay and so has none by construction; here it is a route, and a
          newsletter sign-up and three columns of links under a form somebody is
          part-way through filling in is an invitation to leave. */}
      {!isEditorial && <Footer />}

      {/* Mounted once, at the top, rather than per surface. The cart is a
          property of the session and not of whichever page happens to be
          rendered — a drawer that belonged to the menu page would close itself
          the moment someone navigated home with it open. */}
      <CartMount />
    </>
  );
}

export default function App() {
  return (
    <LanguageProvider>
      {/* Auth above the cart: the checkout reads both, and a customer signing
          in mid-session must not lose the basket they were filling. */}
      <AuthProvider>
        <CartProvider>
          <Shell />
        </CartProvider>
      </AuthProvider>
    </LanguageProvider>
  );
}
