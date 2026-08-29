import { useEffect, useRef, useState, type FormEvent } from "react";
import { useLocation } from "wouter";
import { Bell, LayoutGrid, LogOut, Menu, PanelLeft, Search } from "lucide-react";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { signOut } from "@/lib/api";

const PAGE_TITLES: Record<string, string> = {
  "/": "Overview",
  "/orders": "Orders",
  "/users": "Users",
  "/menu": "Menu",
  "/promos": "Promo codes",
  "/settings": "Settings",
};

export default function Header({
  onToggle,
  openOrders = 0,
}: {
  onToggle: () => void;
  /** Drives the bell's unread dot — real orders still awaiting action. */
  openOrders?: number;
}) {
  const [location, navigate] = useLocation();
  const [search, setSearch] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const title = PAGE_TITLES[location]
    ?? (location.startsWith("/orders/") ? "Order" : "Overview");

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key.toLowerCase() === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        inputRef.current?.focus();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  function handleSearch(e: FormEvent) {
    e.preventDefault();
    if (!search.trim()) return;
    navigate(`/orders?q=${encodeURIComponent(search.trim())}`);
    setSearch("");
    inputRef.current?.blur();
  }

  return (
    <header className="flex h-14 shrink-0 items-center justify-between gap-2 border-b border-border px-2 sm:gap-4 sm:px-4">
      <div className="flex min-w-0 items-center gap-2 sm:gap-3">
        <button
          onClick={onToggle}
          className="rounded-md p-2 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          aria-label="Toggle sidebar"
        >
          {/* A hamburger on a phone, where the button opens an overlay; the
              panel glyph on desktop, where it collapses a column in place. */}
          <Menu className="size-5 lg:hidden" />
          <PanelLeft className="hidden size-4 lg:block" />
        </button>
        <div className="hidden h-4 w-px bg-border sm:block" />
        <div className="flex min-w-0 items-center gap-2">
          <LayoutGrid className="hidden size-4 shrink-0 text-muted-foreground sm:block" aria-hidden />
          <span className="truncate text-sm font-medium">{title}</span>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-1 sm:gap-2">

        <form
          onSubmit={handleSearch}
          className="hidden items-center gap-2 rounded-md border border-border px-2.5 py-1.5 transition-colors focus-within:border-ring sm:flex"
        >
          <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <input
            ref={inputRef}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search orders…"
            aria-label="Search orders"
            className="w-36 min-w-0 bg-transparent text-sm outline-none placeholder:text-muted-foreground lg:w-48"
          />
          <kbd className="flex shrink-0 items-center gap-0.5 rounded border border-border px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
            <span className="text-xs">⌘</span>K
          </kbd>
        </form>

        <button
          type="button"
          onClick={() => navigate("/orders")}
          aria-label={
            openOrders > 0 ? `${openOrders} orders awaiting action` : "No orders awaiting action"
          }
          className="relative rounded-md border border-border p-2 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <Bell className="size-4" />
          {openOrders > 0 && (
            <span className="absolute right-1.5 top-1.5 size-1.5 rounded-full bg-emerald-500" />
          )}
        </button>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="Account menu"
              className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground"
            >
              HC
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-44">
            <div className="px-2 py-1.5">
              <p className="text-sm font-medium">Store admin</p>
              <p className="text-xs text-muted-foreground">Shared admin session</p>
            </div>
            <div className="my-1 h-px bg-border" />
            <DropdownMenuItem onClick={() => navigate("/settings")}>Settings</DropdownMenuItem>
            <DropdownMenuItem
              variant="destructive"
              onClick={async () => {
                await signOut();
                window.location.reload();
              }}
            >
              <LogOut className="size-4" />
              Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
