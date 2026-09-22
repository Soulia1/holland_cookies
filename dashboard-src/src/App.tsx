import { useEffect, useState } from "react";
import { Route, Switch, Router as WouterRouter, useLocation } from "wouter";
import Header from "@/components/Header";
import Sidebar from "@/components/Sidebar";
import KeyGate from "@/components/KeyGate";
import Dashboard from "@/pages/Dashboard";
import Orders from "@/pages/Orders";
import OrderDetail from "@/pages/OrderDetail";
import Users from "@/pages/Users";
import Menu from "@/pages/Menu";
import Promos from "@/pages/Promos";
import Settings from "@/pages/Settings";
import { ordersApi } from "@/lib/api";
import { useIsDesktop } from "@/lib/useMediaQuery";

function Shell() {
  // Two different behaviours behind one button: on desktop the sidebar
  // collapses to an icon rail beside the content, on a phone there is no room
  // beside anything, so it slides in over the page and is dismissed.
  const [collapsed, setCollapsed] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [openOrders, setOpenOrders] = useState(0);
  const isDesktop = useIsDesktop();
  const [location] = useLocation();

  // Orders still awaiting action, for the header's notification dot. Read once
  // per session; the Orders and Overview pages own their own refreshes.
  useEffect(() => {
    let active = true;
    ordersApi
      .stats(7)
      .then((stats) => {
        if (!active) return;
        const byStatus = stats.byStatus || {};
        setOpenOrders(
          (byStatus.ordered || 0) + (byStatus.confirmed || 0) + (byStatus.baking || 0)
        );
      })
      .catch(() => {
        /* the dot is an affordance, not a requirement */
      });
    return () => {
      active = false;
    };
  }, []);

  // Tapping a nav item should take you to the page, not leave you staring at
  // the drawer you just used.
  useEffect(() => {
    setDrawerOpen(false);
  }, [location]);

  // Rotating to landscape, or resizing a desktop window down and back, must not
  // leave a stale drawer overlaying the page.
  useEffect(() => {
    if (isDesktop) setDrawerOpen(false);
  }, [isDesktop]);

  // While the drawer covers the page, the page behind it must not scroll.
  useEffect(() => {
    if (!drawerOpen) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDrawerOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previous;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [drawerOpen]);

  return (
    <div className="flex h-dvh overflow-hidden bg-sidebar">
      <Sidebar
        collapsed={isDesktop && collapsed}
        drawerOpen={drawerOpen}
        onClose={() => setDrawerOpen(false)}
      />

      {/* Scrim — only ever rendered over the drawer, never on desktop. */}
      {drawerOpen && (
        <button
          type="button"
          aria-label="Close navigation"
          onClick={() => setDrawerOpen(false)}
          className="fixed inset-0 z-40 bg-foreground/40 backdrop-blur-[2px] lg:hidden"
        />
      )}

      {/* The rounded inset frame is a desktop affordance; on a phone every
          pixel of width counts, so the content runs edge to edge. */}
      <div className="flex min-w-0 flex-1 lg:p-2 lg:ps-0">
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden border-border bg-background lg:rounded-xl lg:border">
          <Header
            onToggle={() => (isDesktop ? setCollapsed((c) => !c) : setDrawerOpen(true))}
            openOrders={openOrders}
          />
          <main className="flex-1 overflow-y-auto overflow-x-hidden p-4 sm:p-5 lg:p-6">
            <Switch>
              <Route path="/" component={Dashboard} />
              <Route path="/orders" component={Orders} />
              {/* Declared after /orders so the list keeps the bare path. */}
              <Route path="/orders/:id" component={OrderDetail} />
              <Route path="/users" component={Users} />
              <Route path="/menu" component={Menu} />
                            <Route path="/promos" component={Promos} />
              <Route path="/settings" component={Settings} />
              <Route>Not found</Route>
            </Switch>
          </main>
        </div>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <WouterRouter>
      <KeyGate>
        <Shell />
      </KeyGate>
    </WouterRouter>
  );
}
