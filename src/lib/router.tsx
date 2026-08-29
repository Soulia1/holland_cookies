/**
 * A router, in about sixty lines.
 *
 * The site has two pages. A routing library is twenty-odd kilobytes of matcher,
 * nested outlets, loaders and data APIs to answer one question — is this `/menu`
 * or is it the home page — and this project has form for declining that trade
 * (no smooth-scroll library, no icon font, no animation helper). What it cannot
 * decline is doing the small version *properly*: the reason people reach for a
 * library here is not matching, it is the boring parts underneath — back and
 * forward, modified clicks, external links, scroll position. Those are handled
 * below, and they are the whole job.
 *
 * If this ever grows a third page with parameters, replace it wholesale rather
 * than growing it. The point of it being this small is that swapping it costs
 * nothing.
 */

import { useCallback, useSyncExternalStore, type AnchorHTMLAttributes } from "react";

/** Subscribers to a location change we made ourselves. */
const listeners = new Set<() => void>();

function announce(): void {
  for (const listener of listeners) listener();
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  // popstate covers the browser's own navigation — back, forward, and a hash
  // the user edits by hand. Our own pushState does not fire it, which is what
  // the listener set above is for.
  window.addEventListener("popstate", onChange);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("popstate", onChange);
  };
}

function readPath(): string {
  return window.location.pathname;
}

/**
 * The current pathname, without the hash.
 *
 * The hash deliberately does not re-render anything: on `/menu` it tracks the
 * category being read and changes constantly, and a router that re-rendered the
 * page for each one would throw away the scroll position it was reporting.
 */
export function usePath(): string {
  return useSyncExternalStore(subscribe, readPath, () => "/");
}

/**
 * Scroll to a hash target, retrying for a few frames.
 *
 * `scrollIntoView` with no arguments on purpose: the stylesheet already sets
 * `scroll-behavior: smooth` and a `scroll-padding-top` that clears the fixed
 * header, and both are switched off together under reduced motion. Passing
 * options here would mean maintaining a second copy of that in JavaScript.
 *
 * The retry exists because a cross-page link renders its destination *after*
 * this runs — `/#craft` from the menu page has no `#craft` in the document at
 * the moment the URL changes.
 */
function scrollToHash(hash: string, attempt = 0): void {
  const id = decodeURIComponent(hash.slice(1));
  const target = id ? document.getElementById(id) : null;
  if (target) {
    target.scrollIntoView();
    return;
  }
  if (attempt < 12) requestAnimationFrame(() => scrollToHash(hash, attempt + 1));
}

export function navigate(to: string, options: { replace?: boolean } = {}): void {
  const target = new URL(to, window.location.href);
  const samePath = target.pathname === window.location.pathname;
  const sameHash = target.hash === window.location.hash;

  if (!samePath || !sameHash) {
    if (options.replace) window.history.replaceState(null, "", target);
    else window.history.pushState(null, "", target);
    if (!samePath) announce();
  }

  // pushState does not scroll — that is the whole difference between it and
  // following a link, and forgetting it is how in-page anchors quietly stop
  // working the day they are routed through a router. Done *after* the URL
  // changes and unconditionally, so clicking "Visit" a second time takes you
  // back to Visit rather than doing nothing.
  if (target.hash) scrollToHash(target.hash);
  else if (samePath) window.scrollTo({ top: 0 });
}

/**
 * An internal link.
 *
 * Renders a real `<a href>`, so it is a real link: middle-click opens a tab,
 * ctrl/cmd-click opens a tab, the status bar shows where it goes, and a crawler
 * or a browser with the bundle still loading follows it normally. Only a plain
 * left click is intercepted.
 */
export function Link({
  href,
  onClick,
  children,
  ...rest
}: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) {
  const handle = useCallback(
    (event: React.MouseEvent<HTMLAnchorElement>) => {
      onClick?.(event);
      if (event.defaultPrevented) return;
      // Everything the browser would do differently is left to the browser.
      if (event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      if (rest.target && rest.target !== "_self") return;
      event.preventDefault();
      navigate(href);
    },
    [href, onClick, rest.target],
  );

  return (
    <a href={href} onClick={handle} {...rest}>
      {children}
    </a>
  );
}
