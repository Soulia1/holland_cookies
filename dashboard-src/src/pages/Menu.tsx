import { useEffect, useMemo, useState } from "react";
import { Pencil, Plus, Search, Trash2 } from "lucide-react";
import { menuApi, type MenuItem } from "@/lib/api";
import { Btn, Card, CardHead, Empty, Field, Picker, TextInput } from "@/components/menu-ui";
import {
  Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter,
  DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { formatEGP } from "@/lib/format";
import { effectivePrice } from "@shared/productPricing.mjs";

/**
 * The menu.
 *
 * Deliberately Holland's own layout rather than the card grid the rest of this
 * dashboard was ported with: a hundred and five products across seventeen
 * categories reads far better as grouped rows than as a wall of tiles, and this
 * shop's catalogue is a *list* — most of its items have no photograph, so a
 * card is mostly empty frame.
 *
 * The editor is a dialog over that list rather than a page replacing it, so
 * closing returns you to the row you were on instead of the top of the menu.
 *
 * It is bilingual on one form: English and Arabic name and description side by
 * side on the same product, because they are the same product. The alternative
 * — a language switch at the top, or two product rows — is what produces a
 * catalogue where somebody changed the price in English and not in Arabic. The
 * Arabic inputs carry `dir="rtl"` individually rather than the form being
 * flipped: the admin is working in English, and only those fields hold Arabic.
 */

type Draft = {
  id: string;
  category: string;
  name: string; nameAr: string;
  description: string; descriptionAr: string;
  note: string; noteAr: string;
  price: string;
  isAvailable: boolean;
  discountEnabled: boolean;
  discountType: "percent" | "fixed";
  discountValue: string;
};

function draftFrom(item: MenuItem): Draft {
  return {
    id: item.id,
    category: item.category ?? "",
    name: item.name,
    nameAr: item.nameAr ?? "",
    description: item.description ?? "",
    descriptionAr: item.descriptionAr ?? "",
    note: item.note ?? "",
    noteAr: item.noteAr ?? "",
    // `price` from the API is the REGULAR price. Editing the discounted one
    // would bake the current discount in and then discount it again on save.
    price: String(item.price),
    isAvailable: item.isAvailable !== false,
    discountEnabled: !!item.discountEnabled,
    discountType: item.discountType ?? "percent",
    discountValue: String(item.discountValue ?? 0),
  };
}

const BLANK: Draft = {
  id: "", category: "", name: "", nameAr: "", description: "", descriptionAr: "",
  note: "", noteAr: "", price: "", isAvailable: true,
  discountEnabled: false, discountType: "percent", discountValue: "",
};

export default function Menu() {
  const [items, setItems] = useState<MenuItem[] | null>(null);
  const [categories, setCategories] = useState<{ id: string; name: string; nameAr: string }[]>([]);
  const [query, setQuery] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("");
  const [editing, setEditing] = useState<Draft | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function load() {
    const [products, cats] = await Promise.all([menuApi.list(), menuApi.categories()]);
    setItems(products);
    setCategories(cats);
  }

  useEffect(() => { load().catch(() => setError("Could not load the menu.")); }, []);

  const shown = useMemo(() => {
    if (!items) return [];
    const needle = query.trim().toLowerCase();
    return items.filter((item) => {
      if (categoryFilter && item.category !== categoryFilter) return false;
      if (!needle) return true;
      return item.name.toLowerCase().includes(needle)
        || (item.nameAr ?? "").includes(needle)
        || item.id.includes(needle);
    });
  }, [items, query, categoryFilter]);

  const byCategory = useMemo(() => {
    const map = new Map<string, MenuItem[]>();
    for (const item of shown) {
      const key = item.category ?? "";
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(item);
    }
    return map;
  }, [shown]);

  function close() {
    setEditing(null);
    setCreating(false);
    setError(null);
  }

  async function save(draft: Draft) {
    setSaving(true);
    setError(null);
    const body: Partial<MenuItem> = {
      category: draft.category,
      name: draft.name.trim(),
      nameAr: draft.nameAr.trim(),
      description: draft.description.trim(),
      descriptionAr: draft.descriptionAr.trim(),
      note: draft.note.trim(),
      noteAr: draft.noteAr.trim(),
      price: Number(draft.price),
      isAvailable: draft.isAvailable,
      discountEnabled: draft.discountEnabled,
      discountType: draft.discountType,
      discountValue: Number(draft.discountValue) || 0,
    };
    try {
      if (creating) await menuApi.create({ ...body, id: draft.id.trim() });
      else await menuApi.update(draft.id, body);
      await load();
      close();
    } catch (caught) {
      // The server validates the discount against the patch merged over the
      // stored product — the only view where "raise the discount today, cut the
      // price tomorrow" is visible. Its message is more precise than a guess,
      // and the dialog stays open so the admin can fix the field.
      setError(caught instanceof Error ? caught.message : "Could not save.");
    } finally {
      setSaving(false);
    }
  }

  async function remove(item: MenuItem) {
    if (!window.confirm(`Delete ${item.name}? This cannot be undone.`)) return;
    try {
      await menuApi.remove(item.id);
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not delete.");
    }
  }

  return (
    <div className="space-y-4">
      {/* Radix drives the open state from `editing`, so Escape, the backdrop and
          the close button all route through one `onOpenChange` — and the focus
          trap, the scroll lock and focus return come with it rather than being
          rebuilt by hand. */}
      <Dialog open={editing !== null} onOpenChange={(open) => { if (!open) close(); }}>
        <DialogContent className="adm-dialog-wide">
          {editing && (
            <ProductForm
              draft={editing}
              creating={creating}
              categories={categories}
              saving={saving}
              error={error}
              onChange={setEditing}
              onCancel={close}
              onSave={() => save(editing)}
            />
          )}
        </DialogContent>
      </Dialog>

      <div className="flex flex-col gap-2.5 sm:flex-row">
        <div className="relative sm:max-w-sm sm:flex-1">
          <Search className="pointer-events-none absolute start-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <TextInput value={query} onChange={(event) => setQuery(event.target.value)}
            placeholder="Search products" aria-label="Search products" className="ps-8.5" />
        </div>
        <Picker value={categoryFilter} onChange={(event) => setCategoryFilter(event.target.value)}
          aria-label="Filter by category" className="sm:w-56">
          <option value="">All categories</option>
          {categories.map((category) => (
            <option key={category.id} value={category.id}>{category.name}</option>
          ))}
        </Picker>
        <Btn
          className="sm:ms-auto"
          onClick={() => {
            setCreating(true);
            setEditing({ ...BLANK, category: categories[0]?.id ?? "" });
          }}
        >
          <Plus className="size-4" /> New product
        </Btn>
      </div>

      {/* Only shown here when no dialog is open; inside one it belongs beside
          the field that caused it. */}
      {error && editing === null && (
        <p className="text-sm text-destructive" role="alert">{error}</p>
      )}

      {!items ? (
        <Card><Empty>Loading…</Empty></Card>
      ) : shown.length === 0 ? (
        <Card><Empty>Nothing matches that.</Empty></Card>
      ) : (
        categories
          .filter((category) => byCategory.has(category.id))
          .map((category) => (
            <Card key={category.id}>
              <CardHead
                title={category.name}
                sub={category.nameAr || undefined}
                action={
                  <span className="tabular-nums text-xs text-muted-foreground">
                    {byCategory.get(category.id)!.length}
                  </span>
                }
              />
              <ul className="divide-y divide-border">
                {byCategory.get(category.id)!.map((item) => {
                  const selling = effectivePrice(item);
                  const discounted = selling < item.price;
                  return (
                    <li key={item.id}
                      className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-accent/40 sm:px-5">
                      <div className="min-w-0 flex-1">
                        <p className="flex flex-wrap items-center gap-x-2 text-sm">
                          <span className="font-medium">{item.name}</span>
                          {/* Only the Arabic name is dir=rtl — wrapping the whole
                              row would move the price to the other side. */}
                          {item.nameAr && (
                            <span className="text-muted-foreground" dir="rtl">· {item.nameAr}</span>
                          )}
                          {item.isAvailable === false && (
                            <span className="rounded bg-rose-100 px-1.5 py-0.5 text-xs text-rose-900">
                              Sold out
                            </span>
                          )}
                        </p>
                        {item.note && (
                          <p className="text-xs text-muted-foreground">{item.note}</p>
                        )}
                      </div>

                      <div className="shrink-0 text-right">
                        {discounted ? (
                          <>
                            <span className="tabular-nums text-sm font-semibold text-emerald-700">
                              {formatEGP(selling)}
                            </span>
                            <span className="tabular-nums block text-xs text-muted-foreground line-through">
                              {formatEGP(item.price)}
                            </span>
                          </>
                        ) : (
                          <span className="tabular-nums text-sm font-semibold">
                            {formatEGP(item.price)}
                          </span>
                        )}
                      </div>

                      <div className="flex shrink-0 gap-1">
                        <Btn variant="ghost" aria-label={`Edit ${item.name}`}
                          onClick={() => { setCreating(false); setEditing(draftFrom(item)); }}>
                          <Pencil className="size-4" />
                        </Btn>
                        <Btn variant="ghost" aria-label={`Delete ${item.name}`}
                          onClick={() => remove(item)}>
                          <Trash2 className="size-4" />
                        </Btn>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </Card>
          ))
      )}
    </div>
  );
}

/**
 * The editor.
 *
 * Three rows — fixed header, scrolling body, docked footer — so Save stays
 * reachable however long the form gets and however short the phone is.
 *
 * Deliberately not a `<form>`: the dialog's three rows are grid children of
 * `.adm-dialog`, and wrapping them in a form element breaks that grid. Enter
 * still submits, because the handler is on the body's keydown rather than on a
 * form's onSubmit.
 */
function ProductForm({
  draft, creating, categories, saving, error, onChange, onCancel, onSave,
}: {
  draft: Draft; creating: boolean;
  categories: { id: string; name: string; nameAr: string }[];
  saving: boolean; error: string | null;
  onChange: (draft: Draft) => void; onCancel: () => void; onSave: () => void;
}) {
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    onChange({ ...draft, [key]: value });

  const valid = draft.name.trim() !== ""
    && draft.price.trim() !== ""
    && (!creating || draft.id.trim() !== "");

  // Previewed with the same arithmetic the server and the storefront use — one
  // implementation, in @shared/productPricing.mjs — so the admin sees the real
  // selling price before saving rather than after.
  const price = Number(draft.price) || 0;
  const selling = effectivePrice({
    price,
    discountEnabled: draft.discountEnabled,
    discountType: draft.discountType,
    discountValue: Number(draft.discountValue) || 0,
  });

  return (
    <>
      <DialogHeader>
        <DialogTitle>{creating ? "New product" : draft.name}</DialogTitle>
        <DialogDescription>
          {creating
            ? "Both languages live on one product — there is no second row to keep in step."
            : draft.id}
        </DialogDescription>
      </DialogHeader>

      <DialogBody
        className="space-y-4"
        onKeyDown={(event) => {
          // Enter submits, except from a textarea and except while a save is
          // already in flight.
          if (event.key !== "Enter") return;
          if ((event.target as HTMLElement).tagName === "TEXTAREA") return;
          event.preventDefault();
          if (valid && !saving) onSave();
        }}
      >
        {creating && (
          <Field label="Product id" htmlFor="p-id"
            hint="Lowercase letters, numbers and hyphens. Permanent — cart lines and past orders key on it.">
            <TextInput id="p-id" value={draft.id} required
              onChange={(event) => set("id", event.target.value)} />
          </Field>
        )}

        <Field label="Category" htmlFor="p-cat">
          <Picker id="p-cat" value={draft.category}
            onChange={(event) => set("category", event.target.value)}>
            {categories.map((category) => (
              <option key={category.id} value={category.id}>{category.name}</option>
            ))}
          </Picker>
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name (English)" htmlFor="p-name">
            <TextInput id="p-name" value={draft.name} required
              onChange={(event) => set("name", event.target.value)} />
          </Field>
          <Field label="Name (Arabic)" htmlFor="p-name-ar"
            hint="Optional. Falls back to English on the site.">
            <TextInput id="p-name-ar" dir="rtl" value={draft.nameAr}
              onChange={(event) => set("nameAr", event.target.value)} />
          </Field>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Description (English)" htmlFor="p-desc">
            <TextInput id="p-desc" value={draft.description}
              onChange={(event) => set("description", event.target.value)} />
          </Field>
          <Field label="Description (Arabic)" htmlFor="p-desc-ar">
            <TextInput id="p-desc-ar" dir="rtl" value={draft.descriptionAr}
              onChange={(event) => set("descriptionAr", event.target.value)} />
          </Field>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Note (English)" htmlFor="p-note"
            hint="Packaging or size, as printed — “Foil tray”, “14 inch”.">
            <TextInput id="p-note" value={draft.note}
              onChange={(event) => set("note", event.target.value)} />
          </Field>
          <Field label="Note (Arabic)" htmlFor="p-note-ar">
            <TextInput id="p-note-ar" dir="rtl" value={draft.noteAr}
              onChange={(event) => set("noteAr", event.target.value)} />
          </Field>
        </div>

        <hr className="border-border" />

        <Field label="Price (EGP)" htmlFor="p-price"
          hint="The regular price. A discount is configured separately and never overwrites this.">
          <TextInput id="p-price" type="number" min="0" step="0.01" required
            className="tabular-nums" value={draft.price}
            onChange={(event) => set("price", event.target.value)} />
        </Field>

        <label className="flex items-center gap-2.5 text-sm">
          <input type="checkbox" checked={draft.discountEnabled}
            onChange={(event) => set("discountEnabled", event.target.checked)} />
          Discount this product
        </label>

        {draft.discountEnabled && (
          <>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Type" htmlFor="p-dtype">
                <Picker id="p-dtype" value={draft.discountType}
                  onChange={(event) =>
                    set("discountType", event.target.value as "percent" | "fixed")}>
                  <option value="percent">Percentage off</option>
                  <option value="fixed">Fixed amount off</option>
                </Picker>
              </Field>
              <Field label={draft.discountType === "percent" ? "Percent off" : "Amount off (EGP)"}
                htmlFor="p-dvalue">
                <TextInput id="p-dvalue" type="number" min="0" step="0.01" className="tabular-nums"
                  value={draft.discountValue}
                  onChange={(event) => set("discountValue", event.target.value)} />
              </Field>
            </div>
            <p className="rounded-md bg-muted px-3 py-2.5 text-sm">
              Sells for <span className="tabular-nums font-semibold">{formatEGP(selling)}</span>
              {selling < price && (
                <span className="tabular-nums text-muted-foreground">
                  {" "}instead of {formatEGP(price)}
                </span>
              )}
            </p>
          </>
        )}

        <label className="flex items-center gap-2.5 text-sm">
          <input type="checkbox" checked={draft.isAvailable}
            onChange={(event) => set("isAvailable", event.target.checked)} />
          Available to order
        </label>

        {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
      </DialogBody>

      <DialogFooter>
        <Btn type="button" variant="secondary" onClick={onCancel}>Cancel</Btn>
        <Btn type="button" disabled={saving || !valid} onClick={onSave}>
          {saving ? "Saving…" : "Save"}
        </Btn>
      </DialogFooter>
    </>
  );
}
