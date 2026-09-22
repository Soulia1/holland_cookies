import { useEffect, useState } from "react";
import { Link, useLocation } from "wouter";
import {
  ChevronRight,
  ChevronsUpDown,
  Cookie,
  ExternalLink,
  LayoutGrid,
  LogOut,
  Package,
  Settings,
  Ticket,
  Users,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { settingsApi, signOut } from "@/lib/api";

type NavItem = {
  label: string;
  icon: typeof Package;
  href: string;
  /** Renders the trailing chevron the reference uses on expandable rows. */
  expandable?: boolean;
};

const PLATFORM: NavItem[] = [
  { label: "Overview", icon: LayoutGrid, href: "/" },
  { label: "Orders", icon: Package, href: "/orders" },
  { label: "Users", icon: Users, href: "/users" },
  { label: "Menu", icon: Cookie, href: "/menu" },
  { label: "Promo Codes", icon: Ticket, href: "/promos" },
];

const SYSTEM: NavItem[] = [{ label: "Settings", icon: Settings, href: "/settings", expandable: true }];

// The dashboard lives on admin.<shop>, so "/" here is the dashboard, not the shop.
function storefrontUrl(): string {
  const { protocol, hostname, port } = window.location;
  if (!hostname.startsWith("admin.")) return "/";
  return `${protocol}//${hostname.slice("admin.".length)}${port ? `:${port}` : ""}/`;
}

function SectionLabel({ children }: { children: string }) {
  return (
    <p className="px-2 pb-1 pt-3 text-xs font-medium text-muted-foreground">{children}</p>
  );
}

function NavLink({ item, active, collapsed }: { item: NavItem; active: boolean; collapsed: boolean }) {
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      title={collapsed ? item.label : undefined}
      className={cn(
        // 44px tall on touch so the rows are actually hittable with a thumb.
        "flex min-h-11 items-center gap-2.5 rounded-md px-2 py-2 text-sm transition-colors lg:min-h-0",
        collapsed && "justify-center px-0",
        active
          ? "bg-accent font-medium text-accent-foreground"
          : "text-foreground/80 hover:bg-accent hover:text-accent-foreground"
      )}
    >
      <Icon className="size-4 shrink-0" />
      {!collapsed && (
        <>
          <span className="flex-1 truncate">{item.label}</span>
          {item.expandable && <ChevronRight className="size-4 shrink-0 text-muted-foreground" />}
        </>
      )}
    </Link>
  );
}

function FooterLink({
  icon: Icon,
  label,
  href,
  collapsed,
  onClick,
}: {
  icon: typeof Package;
  label: string;
  href?: string;
  collapsed: boolean;
  onClick?: () => void;
}) {
  const className = cn(
    "flex min-h-11 w-full items-center gap-2.5 rounded-md px-2 py-2 text-sm text-foreground/80 transition-colors hover:bg-accent hover:text-accent-foreground lg:min-h-0",
    collapsed && "justify-center px-0"
  );
  const content = (
    <>
      <Icon className="size-4 shrink-0" />
      {!collapsed && <span className="truncate">{label}</span>}
    </>
  );
  if (href) {
    return (
      <a href={href} title={collapsed ? label : undefined} className={className}>
        {content}
      </a>
    );
  }
  return (
    <button type="button" title={collapsed ? label : undefined} onClick={onClick} className={className}>
      {content}
    </button>
  );
}

export default function Sidebar({
  collapsed,
  drawerOpen = false,
  onClose,
}: {
  collapsed: boolean;
  /** Below `lg` the sidebar is an overlay drawer rather than a column. */
  drawerOpen?: boolean;
  onClose?: () => void;
}) {
  const [location] = useLocation();
  // Optimistic until the server answers: the shop is open far more often than
  // it is closed, and flashing "not accepting orders" on every page load would
  // be alarming and wrong.
  const [acceptingOrders, setAcceptingOrders] = useState(true);

  useEffect(() => {
    settingsApi.get().then((settings) => {
      setAcceptingOrders(settings.acceptingOrders !== false);
    }).catch(() => {});
  }, []);

  return (
    <aside
      className={cn(
        // Drawer: fixed over the page, slid out of frame until opened.
        "fixed inset-y-0 start-0 z-50 flex w-[17rem] max-w-[85vw] shrink-0 flex-col",
        "border-e border-border bg-sidebar",
        "transition-[transform,visibility] duration-300 ease-out will-change-transform motion-reduce:transition-none",
        // `invisible` while parked off-screen keeps the links out of the tab
        // order and the accessibility tree — a transform alone leaves a
        // keyboard user tabbing into a menu they cannot see.
        drawerOpen
          ? "visible translate-x-0 shadow-2xl"
          : "invisible -translate-x-full lg:visible",
        // Column: back in the flow, no transform, width driven by the rail state.
        "lg:static lg:max-w-none lg:translate-x-0 lg:shadow-none lg:transition-[width] lg:duration-200",
        collapsed ? "lg:w-16" : "lg:w-64"
      )}
    >
      {/* Brand */}
      <div
        className={cn(
          "flex h-14 shrink-0 items-center gap-2.5 border-b border-border px-4",
          collapsed && "lg:justify-center lg:px-0"
        )}
      >
        <Cookie className="size-5 shrink-0" />
        {!collapsed && (
          <span className="truncate text-[15px] font-semibold tracking-tight">Holland Cookies</span>
        )}
        <button
          type="button"
          onClick={onClose}
          aria-label="Close navigation"
          className="-me-1.5 ms-auto rounded-md p-2 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground lg:hidden"
        >
          <X className="size-4" />
        </button>
      </div>

      {/* Store switcher */}
      <div className={cn("shrink-0 border-b border-border p-2", collapsed && "lg:px-1.5")}>
        <div
          className={cn(
            "flex items-center gap-2.5 rounded-md px-2 py-2",
            collapsed && "lg:justify-center lg:px-0"
          )}
        >
          <span
            aria-hidden
            className="size-5 shrink-0 rounded-full bg-[linear-gradient(135deg,#34d399,#3b82f6)]"
          />
          {!collapsed && (
            <>
              <span className="flex-1 truncate text-sm font-medium">Holland Cookies</span>
              <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" />
            </>
          )}
        </div>
      </div>

      {/* Nav and the callout scroll together, so a short viewport never clips
          the sign-out row off the bottom of the panel. */}
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <nav className={cn("p-2", collapsed && "lg:px-1.5")}>
          {!collapsed && <SectionLabel>Platform</SectionLabel>}
          <div className="space-y-0.5">
            {PLATFORM.map((item) => (
              <NavLink key={item.href} item={item} active={location === item.href} collapsed={collapsed} />
            ))}
          </div>

          {!collapsed && <SectionLabel>System</SectionLabel>}
          <div className={cn("space-y-0.5", collapsed && "lg:mt-1 lg:border-t lg:border-border lg:pt-1")}>
            {SYSTEM.map((item) => (
              <NavLink key={item.href} item={item} active={location === item.href} collapsed={collapsed} />
            ))}
          </div>
        </nav>

        {/* Callout card. Scooby's advertises its Cairo order cutoff, which its
            backend genuinely enforces when it computes a fulfilment date.
            Holland has no cutoff — it bakes to order — so repeating that here
            would state a rule the shop does not have. This shows the one
            operational fact Holland's settings really hold: whether the shop is
            taking orders at all, which is the switch on the Settings page. */}
        {!collapsed && (
          <div className="mt-auto hidden border-t border-border px-4 py-4 min-[420px]:block">
            <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              Store status
            </p>
            <p className="mt-1.5 flex items-center gap-2 text-sm font-semibold">
              <span
                aria-hidden
                className={cn(
                  "size-2 rounded-full",
                  acceptingOrders ? "bg-emerald-500" : "bg-rose-500",
                )}
              />
              {acceptingOrders ? "Accepting orders" : "Not accepting orders"}
            </p>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              {acceptingOrders
                ? "The storefront is live and the checkout is open."
                : "The server is refusing every new order."}
            </p>
            <Link
              href="/settings"
              className="mt-2 inline-block text-xs font-medium underline underline-offset-4 hover:text-muted-foreground"
            >
              Change this
            </Link>
      </div>
        )}
      </div>

      {/* Footer — pinned, and clear of the iOS home indicator. */}
      <div
        className={cn(
          "shrink-0 space-y-0.5 border-t border-border p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]",
          collapsed && "lg:px-1.5"
        )}
      >
        <FooterLink icon={ExternalLink} label="View storefront" href={storefrontUrl()} collapsed={collapsed} />
        <FooterLink
          icon={LogOut}
          label="Sign out"
          collapsed={collapsed}
          onClick={async () => {
            await signOut();
            window.location.reload();
          }}
        />
      </div>
    </aside>
  );
}
