import { cn } from "@/lib/utils";
import type { ReactNode } from "react";

/**
 * The handful of primitives the Menu page uses.
 *
 * Kept separate from `components/ui/*`, which is the ported Scooby design
 * system every other page is built on. The Menu page is deliberately Holland's
 * own layout, so its parts live here rather than being bolted onto a set they
 * are not part of — and nothing here can drift the pages that share `ui/`.
 */

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn("rounded-xl border border-border bg-card", className)}>{children}</div>;
}

export function CardHead({ title, sub, action }: { title: string; sub?: string; action?: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-border px-4 py-3.5 sm:px-5">
      <div className="min-w-0">
        <h2 className="text-sm font-semibold">{title}</h2>
        {/* The Arabic name sits under the English one and needs its own
            direction, or the bidi algorithm reorders a mixed heading. */}
        {sub && <p className="mt-0.5 text-xs text-muted-foreground" dir="rtl">{sub}</p>}
      </div>
      {action}
    </div>
  );
}

export function Btn({
  variant = "primary", className, ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost";
}) {
  return (
    <button
      {...props}
      className={cn(
        "inline-flex min-h-9 items-center justify-center gap-1.5 rounded-md px-3 text-sm font-medium transition-colors disabled:pointer-events-none disabled:opacity-50",
        variant === "primary" && "text-white hover:opacity-90",
        variant === "secondary" && "border border-border bg-background hover:bg-accent",
        variant === "ghost" && "text-muted-foreground hover:bg-accent hover:text-foreground",
        className,
      )}
      style={variant === "primary" ? { background: "var(--burgundy)", ...props.style } : props.style}
    />
  );
}

export function TextInput({ className, ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={cn(
        "min-h-9 w-full rounded-md border border-input bg-background px-3 text-sm outline-none transition-shadow focus-visible:ring-2 focus-visible:ring-ring",
        className,
      )}
    />
  );
}

export function Picker({ className, children, ...props }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...props}
      className={cn(
        "min-h-9 w-full rounded-md border border-input bg-background px-2.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring",
        className,
      )}
    >
      {children}
    </select>
  );
}

export function Field({
  label, hint, htmlFor, children,
}: {
  label: string; hint?: string; htmlFor?: string; children: ReactNode;
}) {
  return (
    <div>
      <label className="mb-1.5 block text-sm font-medium" htmlFor={htmlFor}>{label}</label>
      {children}
      {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="px-5 py-12 text-center text-sm text-muted-foreground">{children}</p>;
}
