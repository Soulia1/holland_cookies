import { useEffect, useId, useState } from "react";
import { ArrowDown, ArrowUp, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { MenuItem } from "@/lib/api";
import {
  CATEGORY_LABELS, categoryOptions, loadCategories, type ProductCategory,
} from "@/lib/categories";
import type { ComponentDraft } from "@/lib/productForm";

/**
 * The product form's parts, shared by the Add card on the Menu page and the
 * Edit dialog. One definition, so a field added to the catalogue cannot end up
 * on only one of the two ways to reach it.
 */

/**
 * A labelled row.
 *
 * Every field gets a real `<label>` rather than a placeholder standing in for
 * one: a placeholder disappears the moment anyone types, so the form used to
 * read as a column of numbers with no way to tell which was the price and which
 * the sort order. `hint` carries the explanation that used to be crammed into
 * the placeholder.
 */
export function Field({
  label, htmlFor, hint, children, className = "",
}: {
  label: string;
  htmlFor?: string;
  hint?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={className}>
      <label className="mb-1.5 block text-[13px] font-medium text-foreground" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {hint && <p className="mt-1 text-[11.5px] leading-snug text-muted-foreground">{hint}</p>}
    </div>
  );
}

/** The controlled vocabulary, as a select. Free text let "cookie" and "Cookie"
 *  become separate categories, silently emptying bundle pickers.
 *
 *  The options come from the database rather than a constant — Holland's
 *  categories are editable, so the list has to be whatever is actually there. */
export function CategoryField({
  id, label, value, onChange, hint, allowEmpty = true,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: ProductCategory | "") => void;
  hint?: string;
  allowEmpty?: boolean;
}) {
  const [options, setOptions] = useState(categoryOptions);

  // The module requests the list on import, so this usually resolves against a
  // warm cache and never renders an empty select.
  useEffect(() => {
    void loadCategories().then(() => setOptions(categoryOptions()));
  }, []);

  return (
    <Field label={label} htmlFor={id} hint={hint}>
      <select
        id={id}
        className="adm-input"
        value={value}
        onChange={(e) => onChange(e.target.value as ProductCategory | "")}
      >
        {allowEmpty && <option value="">Choose a category…</option>}
        {options.map((category) => (
          <option key={category.id} value={category.id}>{category.name}</option>
        ))}
      </select>
    </Field>
  );
}

/** Editor for a fixed bundle's contents: which products, and how many of each. */
export function ComponentEditor({
  components, onChange, items, selfId,
}: {
  components: ComponentDraft[];
  onChange: (next: ComponentDraft[]) => void;
  items: MenuItem[];
  selfId?: string;
}) {
  // A bundle cannot contain another bundle (the server rejects it too — that is
  // how cycles are prevented), so those are not offered here.
  const choosable = items.filter((item) => !item.isBundle && item.id !== selfId);
  const chosen = new Set(components.map((component) => component.productId).filter(Boolean));

  const patch = (index: number, next: Partial<ComponentDraft>) =>
    onChange(components.map((component, i) => (i === index ? { ...component, ...next } : component)));

  const move = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= components.length) return;
    const next = [...components];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  };

  const total = components.reduce((sum, component) => sum + (Number(component.quantity) || 0), 0);

  return (
    <div className="space-y-2">
      <p className="text-[13px] font-medium text-foreground">What is inside this bundle</p>

      {components.length === 0 && (
        <p className="text-xs text-destructive">
          Add at least one product — a bundle with nothing in it cannot be ordered.
        </p>
      )}

      {components.map((component, index) => (
        <div key={index} className="flex items-center gap-1.5">
          <select
            aria-label={`Component ${index + 1} product`}
            className="adm-input min-w-0 flex-1"
            value={component.productId}
            onChange={(e) => patch(index, { productId: e.target.value })}
          >
            <option value="">Choose a product…</option>
            {choosable
              // Keep this row's own selection listed; hide ones already used
              // elsewhere so a duplicate cannot be built in the first place.
              .filter((item) => item.id === component.productId || !chosen.has(item.id))
              .map((item) => (
                <option key={item.id} value={item.id}>{item.name}</option>
              ))}
          </select>
          <input
            aria-label={`Component ${index + 1} quantity`}
            className="adm-input w-16 shrink-0"
            type="number"
            min="1"
            max="50"
            value={component.quantity}
            onChange={(e) => patch(index, { quantity: e.target.value })}
          />
          <button
            type="button" aria-label="Move up" title="Move up"
            className="px-1.5 py-1 text-muted-foreground hover:text-foreground disabled:opacity-30"
            disabled={index === 0} onClick={() => move(index, -1)}
          >
            <ArrowUp className="w-3.5 h-3.5" />
          </button>
          <button
            type="button" aria-label="Move down" title="Move down"
            className="px-1.5 py-1 text-muted-foreground hover:text-foreground disabled:opacity-30"
            disabled={index === components.length - 1} onClick={() => move(index, 1)}
          >
            <ArrowDown className="w-3.5 h-3.5" />
          </button>
          <button
            type="button" aria-label="Remove component" title="Remove"
            className="px-1.5 py-1 text-destructive"
            onClick={() => onChange(components.filter((_, i) => i !== index))}
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      ))}

      <div className="flex items-center justify-between">
        <Button
          type="button" size="sm" variant="outline"
          onClick={() => onChange([...components, { productId: "", quantity: "1" }])}
        >
          <Plus className="w-3.5 h-3.5" /> Add product
        </Button>
        {total > 0 && (
          <span className="text-xs text-muted-foreground">{total} item{total === 1 ? "" : "s"} per bundle</span>
        )}
      </div>
    </div>
  );
}

export interface BundleShape {
  isBundle: boolean;
  bundleType: "choice" | "fixed";
  bundleSize: string;
  bundleCategory: ProductCategory | "";
  components: ComponentDraft[];
}

/** Bundle toggle, the kind of bundle, and whichever fields that kind needs. */
export function BundleFields({
  idPrefix, form, onChange, items, selfId,
}: {
  idPrefix: string;
  form: BundleShape;
  onChange: (patch: Partial<BundleShape>) => void;
  items: MenuItem[];
  selfId?: string;
}) {
  const size = Number(form.bundleSize) || 0;
  const available = form.bundleCategory
    ? items.filter((i) => i.category === form.bundleCategory && i.isAvailable !== false && !i.isBundle).length
    : 0;
  // Legal — repeats are allowed — but usually means the wrong category was picked.
  const thin = form.bundleCategory && available > 0 && available < size;

  return (
    <div className="space-y-2 rounded-lg border border-border p-3">
      <label className="flex items-center gap-2 text-sm font-medium">
        <input
          type="checkbox"
          className="size-4 accent-primary"
          checked={form.isBundle}
          onChange={(e) => onChange({ isBundle: e.target.checked })}
        />
        This is a bundle
      </label>

      {form.isBundle && (
        <div className="space-y-3 pt-1">
          <div className="flex flex-col gap-1.5">
            {([
              ["fixed", "Fixed — I decide what is inside"],
              ["choice", "Customer's choice — they pick from a category"],
            ] as const).map(([value, label]) => (
              <label key={value} className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  className="size-4 accent-primary"
                  name={`${idPrefix}-bundle-type`}
                  checked={form.bundleType === value}
                  onChange={() => onChange({ bundleType: value })}
                />
                {label}
              </label>
            ))}
          </div>

          {form.bundleType === "fixed" ? (
            <ComponentEditor
              components={form.components}
              onChange={(components) => onChange({ components })}
              items={items}
              selfId={selfId}
            />
          ) : (
            <div className="space-y-2">
              <Field label="How many items does the customer choose?" htmlFor={`${idPrefix}-size`}>
                <input
                  id={`${idPrefix}-size`}
                  className="adm-input"
                  type="number"
                  min="1"
                  max="12"
                  value={form.bundleSize}
                  onChange={(e) => onChange({ bundleSize: e.target.value })}
                />
              </Field>
              <CategoryField
                id={`${idPrefix}-bundle-category`}
                label="They choose from this category"
                value={form.bundleCategory}
                onChange={(bundleCategory) => onChange({ bundleCategory })}
              />
              {form.bundleCategory && available === 0 && (
                <p className="text-xs text-destructive">
                  No available items in “{CATEGORY_LABELS[form.bundleCategory]}” — the picker would be empty.
                </p>
              )}
              {thin && (
                <p className="text-xs text-muted-foreground">
                  Only {available} item{available === 1 ? "" : "s"} in “{CATEGORY_LABELS[form.bundleCategory as ProductCategory]}”
                  {" "}for a bundle of {size}. Fine if customers can repeat choices.
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** A product's photo, or its emoji stand-in. */
export function ItemThumb({ item, className = "size-12" }: { item: MenuItem; className?: string }) {
  if (item.image) {
    return <img src={item.image} alt="" className={`${className} shrink-0 rounded-md object-cover`} />;
  }
  return (
    <div className={`${className} flex shrink-0 items-center justify-center rounded-md bg-muted/40 text-2xl`}>
      {item.emoji || "🍪"}
    </div>
  );
}

/** Generates the ids a group of fields needs without the caller inventing them. */
export function useFieldIds(): (name: string) => string {
  const base = useId();
  return (name: string) => `${base}-${name}`;
}
