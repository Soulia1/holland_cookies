import { lazy, Suspense, useEffect, useRef } from "react";
import { AuthProvider } from "@/lib/auth";
import { CartProvider, useCart } from "@/lib/cart";
import { useOnceOpened } from "@/lib/useOnceOpened";
import { LanguageProvider, useLang } from "@/lib/i18n";
import MotionVars from "@/lib/motion/MotionVars";
import { navigate, usePath } from "@/lib/router";
import { dismissSplash } from "@/lib/splash";
import { GROUP_BY_CATEGORY_ID, GROUP_BY_ID, MENU_GROUPS, type MenuGroup } from "@/data/menu";
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
 * A lookup table for the routes that are just a path, and `menuSlug` below for
 * the one that is not. That is twenty-one addressable pages — four here, and
 * seventeen menu categories — served by a matcher of two string comparisons.
 *
 * The comment in lib/router.tsx anticipated exactly this and said to replace the
 * router wholesale rather than grow it once parameters arrived. The judgement
 * here is that one optional segment under one fixed prefix is still the small
 * version done properly rather than the beginning of a matcher; the moment a
 * second parameterised route appears, or one of them needs to nest, that advice
 * comes back into force.
 */
const PAGES: Record<string, () => React.ReactElement> = {
  "/checkout": () => <CheckoutPage />,
  "/track": () => <TrackPage />,
  "/account": () => <AccountPage />,
};

/** Everything the menu lives under. */
const MENU_ROOT = "/menu";

/**
 * The one path segment the lookup table above cannot express.
 *
 * The menu is a page per group — `/menu/cookies` — so it is the first route
 * here with a variable in it. That is deliberately still not a reason to take a
 * routing library: one prefix and one segment is the entire requirement, and
 * `lib/router.tsx` says to replace it wholesale rather than grow it the day that
 * stops being true.
 *
 * Returns the slug for any menu URL and `null` for anything that is not one.
 * The bare `/menu` yields `""`, which resolves to the first group below — every
 * "Menu" link on the site points there, and keeping those pointing at a stable
 * root rather than at whichever group happens to be first is what stops a
 * reordering of the data from breaking the header, the footer, the hero, the
 * cart and four order pages at once.
 */
function menuSlug(route: string): string | null {
  if (route === MENU_ROOT) return "";
  if (!route.startsWith(`${MENU_ROOT}/`)) return null;
  // Decoded: the Arabic pills link to the same ASCII ids as the English ones,
  // but a pasted or hand-edited URL can still arrive percent-encoded.
  try {
    return decodeURIComponent(route.slice(MENU_ROOT.length + 1));
  } catch {
    // A malformed escape is not a group, and throwing here would take the
    // whole page down over a bad URL.
    return "";
  }
}

/**
 * Where a menu URL points: always a group, and sometimes a section within it.
 *
 * Never fails. An unknown slug falls through to the first group rather than to
 * a dead end, and the effect below corrects the URL to match what was rendered.
 *
 * Three kinds of address arrive here and only the first is current:
 *
 *  - `/menu/cookies` — a group. What every link on the site now produces.
 *  - `/menu/cookie-pans` — a *category*. This was a real page until the
 *    seventeen categories were folded into three groups, so those addresses are
 *    in the wild. A category is still a real thing; it is a section now, so the
 *    reader lands on its group with that section named.
 *  - `/menu#gateaux` — how the original one-page menu deep-linked, older still
 *    and handled the same way.
 *
 * The `section` is what the page scrolls to and what the URL keeps as its hash,
 * so an old link ends up at an address that is both canonical and still points
 * at exactly what it always meant.
 */
interface MenuTarget {
  group: MenuGroup;
  /** A category id inside `group`, when the URL named one. */
  section: string | null;
}

function resolveMenuTarget(slug: string): MenuTarget {
  const group = GROUP_BY_ID.get(slug);
  if (group) {
    // A group page can still carry a section in its hash — that is how an old
    // category link ends up addressed, and it is what the sub-category bar
    // writes. A hash naming a category in some *other* group is ignored rather
    // than followed: the path is the more specific half of the address.
    const hash = decodeURIComponent(window.location.hash.slice(1));
    return { group, section: GROUP_BY_CATEGORY_ID.get(hash) === group ? hash : null };
  }

  const byCategory = GROUP_BY_CATEGORY_ID.get(slug);
  if (byCategory) return { group: byCategory, section: slug };

  const hash = decodeURIComponent(window.location.hash.slice(1));
  const byHash = GROUP_BY_CATEGORY_ID.get(hash);
  if (byHash) return { group: byHash, section: hash };
  return { group: GROUP_BY_ID.get(hash) ?? MENU_GROUPS[0], section: null };
}

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
  const slug = menuSlug(route);
  const isMenu = slug !== null;
  // Resolved during render rather than in an effect, so the group the URL names
  // is the one painted on the very first frame. Doing it in an effect would
  // show the wrong group — or nothing — for a frame on every load of a deep
  // link.
  const target = slug === null ? null : resolveMenuTarget(slug);
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

  // Put the URL where the rendered page says it should be.
  //
  // Four cases arrive here and all four are already showing the right page: the
  // bare `/menu` that every "Menu" link on the site points at, an old
  // `/menu/cookie-pans` category address, an older `/menu#gateaux` deep link,
  // and a slug that names nothing at all. Each is corrected to its canonical
  // `/menu/<group>`, keeping `#<category>` where one was named — that hash is
  // the difference between "the cookies page" and "the cookie pans on the
  // cookies page", so dropping it would quietly downgrade every old link. What
  // gets bookmarked, shared or reloaded is then the real address of what is on
  // screen.
  //
  // `replace`, never push: this is a correction rather than a navigation, and
  // pushing would put a step in the history whose only effect on Back is to
  // bounce the reader straight forward again.
  const wantPath = target ? `${MENU_ROOT}/${target.group.id}` : null;
  const wantHash = target?.section ? `#${target.section}` : "";
  useEffect(() => {
    if (!wantPath) return;
    if (window.location.pathname === wantPath && window.location.hash === wantHash) return;
    navigate(`${wantPath}${wantHash}`, { replace: true });
  }, [wantPath, wantHash]);

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
      {target ? (
        <MenuPage group={target.group} section={target.section} />
      ) : page ? (
        <Suspense fallback={null}>{page()}</Suspense>
      ) : (
        <Home />
      )}

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
