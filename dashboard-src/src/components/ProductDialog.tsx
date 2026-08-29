import { useMemo, useState } from "react";
import { Loader2, Tag } from "lucide-react";
import {
  Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import ImagePicker from "@/components/ImagePicker";
import {
  BundleFields, CategoryField, Field, ItemThumb, useFieldIds,
} from "@/components/ProductFields";
import type { MenuItem } from "@/lib/api";
import { CATEGORY_LABELS, isProductCategory } from "@/lib/categories";
import { formatEGP } from "@/lib/format";
import {
  draftFromItem, draftProblem, pricingView, toPayload, type ProductDraft,
} from "@/lib/productForm";
import {
  discountAmount, discountPercentOff, effectivePrice, hasDiscount,
} from "@shared/productPricing.mjs";

/**
 * Editing one product, in a panel over the dashboard.
 *
 * This used to be an inline form that replaced the product card in the grid:
 * fifteen unlabelled inputs squeezed into a third of a row, with the card's own
 * photo and name gone the moment editing began, so the admin could not see
 * which product they were editing while they edited it. The panel gets the room
 * to label every field and to keep the product identified at the top.
 *
 * The dialog is mounted per product (`key` on the caller) so the draft is built
 * from the item once, on open, and there is no stale state to reset on close.
 */

/** The dashboard's own money format, so the dialog quotes prices the way every
 *  other screen does — piastres shown only when there are some. */
const EGP = formatEGP;

/** Regular price, discount switch, and what the customer ends up paying. */
function DiscountSection({
  form, patch, id,
}: {
  form: ProductDraft;
  patch: (next: Partial<ProductDraft>) => void;
  id: (name: string) => string;
}) {
  const pricing = pricingView(form);
  const regular = pricing.price;
  const on = form.discountEnabled;
  // Deliberately computed with the same helper the storefront and the checkout
  // use, so the number quoted here is the number that will be charged.
  const pays = effectivePrice(pricing);
  const live = hasDiscount(pricing);

  return (
    <section className="rounded-lg border border-border p-3.5">
      <div className="flex items-center justify-between gap-3">
        <span className="flex items-center gap-2 text-sm font-semibold">
          <Tag className="size-4 text-muted-foreground" aria-hidden /> Discount
        </span>
        <label className="flex cursor-pointer items-center gap-2 text-[13px]">
          <input
            type="checkbox"
            className="size-4 accent-primary"
            checked={on}
            onChange={(e) => patch({ discountEnabled: e.target.checked })}
          />
          Enable discount
        </label>
      </div>

      <p className="mt-2 text-[13px] text-muted-foreground">
        Regular price <span className="font-medium text-foreground">{EGP(regular)}</span>
      </p>

      {on && (
        <div className="mt-3 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Discount type" htmlFor={id("discount-type")}>
              <select
                id={id("discount-type")}
                className="adm-input"
                value={form.discountType}
                onChange={(e) => patch({ discountType: e.target.value as "percent" | "fixed" })}
              >
                <option value="percent">Percentage</option>
                <option value="fixed">Fixed amount</option>
              </select>
            </Field>
            <Field
              label={form.discountType === "percent" ? "Discount (%)" : "Discount (EGP)"}
              htmlFor={id("discount-value")}
            >
              <input
                id={id("discount-value")}
                className="adm-input"
                type="number"
                min="0"
                step={form.discountType === "percent" ? "1" : "0.01"}
                max={form.discountType === "percent" ? "99" : undefined}
                value={form.discountValue}
                onChange={(e) => patch({ discountValue: e.target.value })}
              />
            </Field>
          </div>

          {/* The answer to "what will this actually cost", updated as they
              type. aria-live so it is not a change only sighted users notice. */}
          {/* Wraps as a whole rather than mid-figure: at 390px an unwrapped row
              broke "85 EGP" across two lines, which is not a price. */}
          <div
            className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 rounded-md bg-muted/50 px-3 py-2.5"
            aria-live="polite"
          >
            <span className="whitespace-nowrap text-[13px] text-muted-foreground">Customer pays</span>
            {live ? (
              <span className="flex flex-wrap items-baseline gap-2">
                <span className="whitespace-nowrap text-[13px] text-muted-foreground line-through">
                  {EGP(regular)}
                </span>
                <span className="whitespace-nowrap text-base font-semibold">{EGP(pays)}</span>
                <span className="whitespace-nowrap rounded-full bg-primary/15 px-2 py-0.5 text-[11px] font-semibold">
                  {discountPercentOff(pricing)}% OFF
                </span>
              </span>
            ) : (
              <span className="text-[13px] text-muted-foreground">
                Enter a discount to see the sale price
              </span>
            )}
          </div>
          {live && (
            <p className="text-[11.5px] text-muted-foreground">
              {EGP(discountAmount(pricing))} off every one sold. The storefront, the cart and the
              order total all use this price.
            </p>
          )}
        </div>
      )}
    </section>
  );
}

export default function ProductDialog({
  item, items, open, onOpenChange, onSave,
}: {
  item: MenuItem;
  /** The whole catalogue — a fixed bundle draws its components from here. */
  items: MenuItem[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Must throw on failure; the dialog stays open and reports it. */
  onSave: (values: ReturnType<typeof toPayload>) => Promise<void>;
}) {
  const id = useFieldIds();
  const initial = useMemo(() => draftFromItem(item), [item]);
  const [form, setForm] = useState<ProductDraft>(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  // Shown instead of the normal footer once a close is attempted with unsaved
  // edits. An inline question rather than window.confirm, which is a browser
  // dialog on top of a dialog and cannot be styled or tested properly.
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  const patch = (next: Partial<ProductDraft>) => {
    setForm((prev) => ({ ...prev, ...next }));
    setError("");
  };

  // Compared against the draft the dialog opened with, so re-typing a value
  // back to what it was counts as unchanged and closes without asking.
  const dirty = useMemo(
    () => JSON.stringify(form) !== JSON.stringify(initial),
    [form, initial],
  );

  /** Radix asks to close on ×, Escape, and a click outside. */
  function requestClose(next: boolean) {
    if (next) return onOpenChange(true);
    if (saving) return;
    if (dirty) {
      setConfirmDiscard(true);
      return;
    }
    onOpenChange(false);
  }

  async function handleSave() {
    if (saving) return;
    const problem = draftProblem(form);
    if (problem) {
      setError(problem);
      return;
    }
    setSaving(true);
    setError("");
    try {
      await onSave(toPayload(form));
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save the product.");
    } finally {
      setSaving(false);
    }
  }

  const preview = pricingView(form);
  const onSale = hasDiscount(preview);

  return (
    <Dialog open={open} onOpenChange={requestClose}>
      <DialogContent
        aria-describedby={undefined}
        // Saving is a network round trip; letting Escape or a stray click
        // dismiss the panel mid-flight would hide whether it worked.
        onEscapeKeyDown={(event) => saving && event.preventDefault()}
        onInteractOutside={(event) => saving && event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>Edit {item.name}</DialogTitle>
          {/* Which product this is, without scrolling: photo, price, category.
              The inline form it replaced hid all three behind itself. */}
          <div className="mt-2.5 flex items-center gap-3">
            <ItemThumb item={{ ...item, image: form.image, emoji: form.emoji }} />
            <div className="min-w-0 flex-1">
              {/* Only the Arabic name is dir="rtl". Wrapping the separator in
                  it too moved the "·" to the far side of the name, so the two
                  names ran together with a dot dangling after them. */}
              <p className="truncate text-sm font-medium">
                {form.name || item.name}
                {form.nameAr && (
                  <span className="font-normal text-muted-foreground">
                    {" · "}<span dir="rtl">{form.nameAr}</span>
                  </span>
                )}
              </p>
              <p className="text-[13px]">
                {onSale ? (
                  <>
                    <span className="text-muted-foreground line-through">{EGP(preview.price)}</span>{" "}
                    <span className="font-semibold">{EGP(effectivePrice(preview))}</span>
                  </>
                ) : (
                  <span className="text-muted-foreground">{EGP(preview.price)}</span>
                )}
              </p>
              <p className="text-[12px] text-muted-foreground">
                {isProductCategory(form.category)
                  ? CATEGORY_LABELS[form.category]
                  : "No category yet"}
              </p>
            </div>
          </div>
        </DialogHeader>

        <DialogBody className="space-y-4">
          <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
            <Field label="Product name" htmlFor={id("name")}>
              <input
                id={id("name")}
                className="adm-input"
                value={form.name}
                onChange={(e) => patch({ name: e.target.value })}
              />
            </Field>
            <Field label="Arabic name" htmlFor={id("nameAr")} hint="Optional — shown when the shop is in Arabic.">
              <input
                id={id("nameAr")}
                className="adm-input"
                dir="rtl"
                value={form.nameAr}
                onChange={(e) => patch({ nameAr: e.target.value })}
              />
            </Field>
            <Field label="Price" htmlFor={id("price")} hint="The regular price, before any discount.">
              <div className="flex items-center gap-2">
                <input
                  id={id("price")}
                  className="adm-input"
                  type="number"
                  min="1"
                  value={form.price}
                  onChange={(e) => patch({ price: e.target.value })}
                />
                <span className="shrink-0 text-[13px] text-muted-foreground">EGP</span>
              </div>
            </Field>
            <Field label="Unit" htmlFor={id("unit")} hint="What one of these is — “cookie”, “tin (7 servings)”.">
              <input
                id={id("unit")}
                className="adm-input"
                value={form.unit}
                onChange={(e) => patch({ unit: e.target.value })}
              />
            </Field>
            <CategoryField
              id={id("category")}
              label="Category"
              value={form.category}
              onChange={(category) => patch({ category })}
              hint="Required — the storefront groups the menu by it."
            />
            <Field label="Sort order" htmlFor={id("order")} hint="Lower numbers come first on the menu.">
              <input
                id={id("order")}
                className="adm-input"
                type="number"
                min="0"
                value={form.order}
                onChange={(e) => patch({ order: e.target.value })}
              />
            </Field>
          </div>

          <Field label="Main photo" hint="Upload, drag and drop, or paste a URL.">
            <ImagePicker
              value={form.image}
              onChange={(image) => patch({ image })}
              fallback={form.emoji || "🍪"}
            />
          </Field>

          <Field
            label="Hover / alternate photo"
            hint="Optional — shown on hover, and the card alternates with the main photo every 5s."
          >
            <ImagePicker
              value={form.hoverImage}
              onChange={(hoverImage) => patch({ hoverImage })}
              fallback="✨"
            />
          </Field>

          <Field
            label="Emoji fallback"
            htmlFor={id("emoji")}
            hint="Shown wherever there is no photo."
            className="sm:max-w-[180px]"
          >
            <input
              id={id("emoji")}
              className="adm-input"
              maxLength={2}
              value={form.emoji}
              onChange={(e) => patch({ emoji: e.target.value })}
            />
          </Field>

          <Field label="Description" htmlFor={id("description")}>
            <textarea
              id={id("description")}
              className="adm-input min-h-[80px] resize-y"
              rows={3}
              value={form.description}
              onChange={(e) => patch({ description: e.target.value })}
            />
          </Field>

          <Field label="Arabic description" htmlFor={id("descriptionAr")} hint="Optional.">
            <textarea
              id={id("descriptionAr")}
              className="adm-input min-h-[80px] resize-y"
              dir="rtl"
              rows={3}
              value={form.descriptionAr}
              onChange={(e) => patch({ descriptionAr: e.target.value })}
            />
          </Field>

          <DiscountSection form={form} patch={patch} id={id} />

          <BundleFields
            idPrefix={id("bundle")}
            form={form}
            onChange={(next) => patch(next)}
            items={items}
            selfId={item.id}
          />

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="size-4 accent-primary"
              checked={form.isAvailable}
              onChange={(e) => patch({ isAvailable: e.target.checked })}
            />
            Available in the storefront
          </label>
          <p className="-mt-2 text-[11.5px] text-muted-foreground">
            Turn this off to show the product as sold out. It stays on the menu; it just cannot be ordered.
          </p>
        </DialogBody>

        {error && (
          <p className="border-t border-border px-5 py-2.5 text-[13px] text-destructive" role="alert">
            {error}
          </p>
        )}

        <DialogFooter>
          {confirmDiscard ? (
            <>
              <span className="me-auto self-center text-[13px] text-muted-foreground">
                Discard your changes?
              </span>
              <Button variant="secondary" onClick={() => setConfirmDiscard(false)}>
                Keep editing
              </Button>
              <Button variant="destructive" onClick={() => onOpenChange(false)}>
                Discard
              </Button>
            </>
          ) : (
            <>
              <Button variant="secondary" disabled={saving} onClick={() => requestClose(false)}>
                Cancel
              </Button>
              <Button onClick={handleSave} disabled={saving} className="gap-2">
                {saving && <Loader2 className="size-4 animate-spin" aria-hidden />}
                {saving ? "Saving…" : "Save changes"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
