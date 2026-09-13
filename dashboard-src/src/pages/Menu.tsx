import { useEffect, useMemo, useState } from "react";
import { FolderPlus, Pencil, Plus, Search, Trash2 } from "lucide-react";
import { menuApi, type MenuItem } from "@/lib/api";
import { invalidateCategories, loadCategories } from "@/lib/categories";
import { Btn, Card, CardHead, Empty, Field, Picker, TextInput } from "@/components/menu-ui";
import { BundleFields } from "@/components/ProductFields";
import { ImageUpload } from "@/components/ImageUpload";
import type { ChoiceGroupDraft } from "@/components/ChoiceGroups";
import type { ComponentDraft } from "@/lib/productForm";
import {
  Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter,
  DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { formatEGP } from "@/lib/format";
import { effectivePrice } from "@shared/productPricing.mjs";

/**
 * The menu.
 *
 * Grouped rows with an editor dialog over them, so closing returns you to the
 * row you were on. The item settings are Bad Ziggy's — photo upload, fixed and
 * customer's-choice bundles, new and delete category — on Holland's bilingual
 * form: English and Arabic side by side on the same product, because they are
 * the same product.
 */

type Category = { id: string; name: string; nameAr: string };

type Draft = {
  id: string;
  category: string;
  name: string; nameAr: string;
  description: string; descriptionAr: string;
  note: string; noteAr: string;
  price: string;
  image: string;
  isAvailable: boolean;
  discountEnabled: boolean;
  discountType: "percent" | "fixed";
  discountValue: string;
  isBundle: boolean;
  bundleType: "fixed" | "choice";
  components: ComponentDraft[];
  groups: ChoiceGroupDraft[];
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
    image: item.image ?? "",
    isAvailable: item.isAvailable !== false,
    discountEnabled: !!item.discountEnabled,
    discountType: item.discountType ?? "percent",
    discountValue: String(item.discountValue ?? 0),
    isBundle: !!item.isBundle,
    bundleType: item.bundleType ?? "fixed",
    components: (item.components ?? []).map((component) => ({
      productId: component.productId,
      quantity: String(component.quantity),
    })),
    groups: (item.groups ?? []).map((group) => ({
      label: group.label,
      labelAr: group.labelAr ?? "",
      choose: String(group.choose),
      allowRepeats: !!group.allowRepeats,
      options: group.options.map((option) => ({
        productId: option.productId,
        surcharge: option.surcharge ? String(option.surcharge) : "",
      })),
    })),
  };
}

const BLANK: Draft = {
  id: "", category: "", name: "", nameAr: "", description: "", descriptionAr: "",
  note: "", noteAr: "", price: "", image: "", isAvailable: true,
  discountEnabled: false, discountType: "percent", discountValue: "",
  isBundle: false, bundleType: "fixed", components: [], groups: [],
};

function bodyFrom(draft: Draft): Partial<MenuItem> {
  const choice = draft.isBundle && draft.bundleType === "choice";
  return {
    category: draft.category,
    name: draft.name.trim(),
    nameAr: draft.nameAr.trim(),
    description: draft.description.trim(),
    descriptionAr: draft.descriptionAr.trim(),
    note: draft.note.trim(),
    noteAr: draft.noteAr.trim(),
    price: Number(draft.price),
    image: draft.image,
    isAvailable: draft.isAvailable,
    discountEnabled: draft.discountEnabled,
    discountType: draft.discountType,
    discountValue: Number(draft.discountValue) || 0,
    isBundle: draft.isBundle,
    bundleType: draft.bundleType,
    // A choice bundle has no contents and a fixed one has no groups.
    groups: choice
      ? draft.groups.map((group) => ({
          label: group.label.trim(),
          labelAr: group.labelAr.trim(),
          choose: Number(group.choose) || 1,
          allowRepeats: group.allowRepeats,
          options: group.options
            .filter((option) => option.productId)
            .map((option) => ({ productId: option.productId, surcharge: Number(option.surcharge) || 0 })),
        }))
      : [],
    components: draft.isBundle && !choice
      ? draft.components
          .filter((component) => component.productId)
          .map((component) => ({ productId: component.productId, quantity: Number(component.quantity) || 0 }))
      : [],
  };
}

export default function Menu() {
  const [items, setItems] = useState<MenuItem[] | null>(null);
  const [categories, setCategories] = useState<Category[]>([]);
  const [query, setQuery] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("");
  const [editing, setEditing] = useState<Draft | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [newCategory, setNewCategory] = useState<{ name: string; nameAr: string } | null>(null);
  const [savingCategory, setSavingCategory] = useState(false);
  const [deleting, setDeleting] = useState<{ id: string; name: string; count: number } | null>(null);
  const [confirmText, setConfirmText] = useState("");
  const [deletingBusy, setDeletingBusy] = useState(false);

  async function load() {
    const [products, cats] = await Promise.all([menuApi.list(), menuApi.categories()]);
    setItems(products);
    setCategories(cats);
  }

  useEffect(() => {
    load().catch(() => setError("Could not load the menu."));
    void loadCategories();
  }, []);

  async function saveCategory(draft: { name: string; nameAr: string }) {
    setSavingCategory(true);
    setError(null);
    try {
      await menuApi.createCategory(draft.name, draft.nameAr);
      invalidateCategories();
      await loadCategories();
      await load();
      setNewCategory(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not create the category.");
    } finally {
      setSavingCategory(false);
    }
  }

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

  async function removeCategory() {
    if (!deleting) return;
    setDeletingBusy(true);
    setError(null);
    try {
      const removed = await menuApi.removeCategory(deleting.id, deleting.count > 0);
      invalidateCategories();
      await loadCategories();
      await load();
      setDeleting(null);
      setConfirmText("");
      setNotice(removed > 0
        ? `Deleted “${deleting.name}” and ${removed} product${removed === 1 ? "" : "s"}.`
        : `Deleted “${deleting.name}”.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not delete the category.");
    } finally {
      setDeletingBusy(false);
    }
  }

  async function save(draft: Draft) {
    setSaving(true);
    setError(null);
    const body = bodyFrom(draft);
    try {
      if (creating) await menuApi.create({ ...body, id: draft.id.trim() });
      else await menuApi.update(draft.id, body);
      await load();
      close();
    } catch (caught) {
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
      <Dialog open={editing !== null} onOpenChange={(open) => { if (!open) close(); }}>
        <DialogContent className="adm-dialog-wide">
          {editing && (
            <ProductForm
              draft={editing}
              creating={creating}
              categories={categories}
              items={items ?? []}
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
        <Btn className="sm:ms-auto" variant="secondary" onClick={() => { setError(null); setNewCategory({ name: "", nameAr: "" }); }}>
          <FolderPlus className="size-4" /> New category
        </Btn>
        <Btn
          onClick={() => {
            setCreating(true);
            setEditing({ ...BLANK, category: categories[0]?.id ?? "" });
          }}
        >
          <Plus className="size-4" /> New product
        </Btn>
      </div>

      <Dialog open={newCategory !== null} onOpenChange={(open) => { if (!open) setNewCategory(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New category</DialogTitle>
            <DialogDescription>
              Groups products on the menu. The name can be changed later; the id it
              is filed under cannot, because products point at it.
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-3">
            <Field label="Name (English)" htmlFor="new-category-name">
              <TextInput
                id="new-category-name"
                autoFocus
                maxLength={120}
                value={newCategory?.name ?? ""}
                placeholder="Cookie Boxes"
                onChange={(event) => setNewCategory((current) => ({ nameAr: "", ...current, name: event.target.value }))}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && newCategory?.name.trim()) void saveCategory(newCategory);
                }}
              />
            </Field>
            <Field label="Name (Arabic)" htmlFor="new-category-name-ar" hint="Optional. Falls back to English on the site.">
              <TextInput
                id="new-category-name-ar"
                dir="rtl"
                maxLength={120}
                value={newCategory?.nameAr ?? ""}
                onChange={(event) => setNewCategory((current) => ({ name: "", ...current, nameAr: event.target.value }))}
              />
            </Field>
            {error && newCategory !== null && (
              <p className="text-sm text-destructive" role="alert">{error}</p>
            )}
          </DialogBody>
          <DialogFooter>
            <Btn variant="ghost" onClick={() => setNewCategory(null)}>Cancel</Btn>
            <Btn
              disabled={savingCategory || !newCategory?.name.trim()}
              onClick={() => newCategory && void saveCategory(newCategory)}
            >
              {savingCategory ? "Creating…" : "Create category"}
            </Btn>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* The one irreversible action on this screen, so it asks the operator to
          type the name when there is anything to lose. */}
      <Dialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDeleting(null);
            setConfirmText("");
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete “{deleting?.name}”?</DialogTitle>
            <DialogDescription>
              {deleting && deleting.count > 0 ? (
                <>
                  This also deletes the {deleting.count} product
                  {deleting.count === 1 ? "" : "s"} filed under it. It cannot be undone.
                </>
              ) : (
                <>This category is empty. Deleting it changes nothing else.</>
              )}
            </DialogDescription>
          </DialogHeader>

          <DialogBody className="space-y-3">
            {deleting && deleting.count > 0 && (
              <>
                <ul className="max-h-40 space-y-0.5 overflow-y-auto rounded-md border border-border bg-muted/30 p-2.5 text-sm">
                  {(items ?? [])
                    .filter((item) => (item.category ?? "") === deleting.id)
                    .map((item) => (
                      <li key={item.id} className="truncate">{item.name}</li>
                    ))}
                </ul>
                <p className="text-xs text-muted-foreground">
                  Past orders keep their line items — a receipt still reads correctly after the
                  product behind it is gone.
                </p>
                <Field label={`Type “${deleting.name}” to confirm`} htmlFor="confirm-delete">
                  <TextInput
                    id="confirm-delete"
                    autoFocus
                    autoComplete="off"
                    value={confirmText}
                    placeholder={deleting.name}
                    onChange={(event) => setConfirmText(event.target.value)}
                  />
                </Field>
              </>
            )}

            {error && deleting !== null && (
              <p role="alert" className="text-sm text-destructive">{error}</p>
            )}
          </DialogBody>

          <DialogFooter>
            <Btn variant="ghost" onClick={() => { setDeleting(null); setConfirmText(""); }}>
              Cancel
            </Btn>
            <Btn
              variant="danger"
              disabled={
                deletingBusy
                || (deleting !== null && deleting.count > 0 && confirmText.trim() !== deleting.name)
              }
              onClick={() => void removeCategory()}
            >
              {deletingBusy
                ? "Deleting…"
                : deleting && deleting.count > 0
                  ? `Delete category and ${deleting.count} product${deleting.count === 1 ? "" : "s"}`
                  : "Delete category"}
            </Btn>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {notice && (
        <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm" role="status">
          {notice}
        </p>
      )}

      {error && editing === null && newCategory === null && deleting === null && (
        <p className="text-sm text-destructive" role="alert">{error}</p>
      )}

      {!items ? (
        <Card><Empty>Loading…</Empty></Card>
      ) : shown.length === 0 && (query.trim() || categoryFilter) ? (
        <Card><Empty>Nothing matches that.</Empty></Card>
      ) : (
        categories
          // An empty category is shown, or "New category" would appear to do
          // nothing. Still hidden while searching, where it is only noise.
          .filter((category) => byCategory.has(category.id) || (!query.trim() && !categoryFilter))
          .map((category) => (
            <Card key={category.id}>
              <CardHead
                title={category.name}
                sub={category.nameAr || undefined}
                action={
                  <span className="flex items-center gap-2">
                    <span className="tabular-nums text-xs text-muted-foreground">
                      {byCategory.get(category.id)?.length ?? 0}
                    </span>
                    <Btn
                      variant="ghost"
                      aria-label={`Delete the ${category.name} category`}
                      title={`Delete the ${category.name} category`}
                      onClick={() => {
                        setConfirmText("");
                        setError(null);
                        setNotice(null);
                        setDeleting({
                          id: category.id,
                          name: category.name,
                          count: byCategory.get(category.id)?.length ?? 0,
                        });
                      }}
                    >
                      <Trash2 className="size-4" />
                    </Btn>
                  </span>
                }
              />
              {!byCategory.has(category.id) ? (
                <Empty>
                  Nothing in this category yet — add a product and file it under {category.name}.
                </Empty>
              ) : (
                <ul className="divide-y divide-border">
                  {byCategory.get(category.id)!.map((item) => {
                    const selling = effectivePrice(item);
                    const discounted = selling < item.price;
                    return (
                      <li key={item.id}
                        className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-accent/40 sm:px-5">
                        {item.image ? (
                          <img src={item.image} alt="" className="size-10 shrink-0 rounded-md object-cover" />
                        ) : null}
                        <div className="min-w-0 flex-1">
                          <p className="flex flex-wrap items-center gap-x-2 text-sm">
                            <span className="font-medium">{item.name}</span>
                            {item.nameAr && (
                              <span className="text-muted-foreground" dir="rtl">· {item.nameAr}</span>
                            )}
                            {item.isBundle && (
                              <span className="rounded bg-sky-100 px-1.5 py-0.5 text-xs text-sky-900">
                                {item.bundleType === "choice" ? "Choice bundle" : "Bundle"}
                              </span>
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
              )}
            </Card>
          ))
      )}
    </div>
  );
}

/**
 * The editor: fixed header, scrolling body, docked footer, so Save stays
 * reachable however long the form gets. Not a `<form>`, because that breaks the
 * dialog's grid; Enter still submits from the body's keydown.
 */
function ProductForm({
  draft, creating, categories, items, saving, error, onChange, onCancel, onSave,
}: {
  draft: Draft; creating: boolean;
  categories: Category[];
  /** The whole catalogue — a bundle draws its contents and options from here. */
  items: MenuItem[];
  saving: boolean; error: string | null;
  onChange: (draft: Draft) => void; onCancel: () => void; onSave: () => void;
}) {
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    onChange({ ...draft, [key]: value });
  // Save waits for a photo still uploading, or the product would save without it.
  const [uploading, setUploading] = useState(false);

  const valid = draft.name.trim() !== ""
    && draft.price.trim() !== ""
    && (!creating || draft.id.trim() !== "");

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
          if (event.key !== "Enter") return;
          const target = event.target as HTMLElement;
          if (target.tagName === "TEXTAREA" || target.tagName === "SELECT") return;
          event.preventDefault();
          if (valid && !saving && !uploading) onSave();
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

        <Field label="Photo" htmlFor="p-image">
          <ImageUpload id="p-image" value={draft.image}
            onChange={(path) => set("image", path)} onBusyChange={setUploading} />
        </Field>

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

        <BundleFields
          idPrefix="p"
          form={{
            isBundle: draft.isBundle,
            bundleType: draft.bundleType,
            components: draft.components,
            groups: draft.groups,
            basePrice: selling,
          }}
          onChange={(patch) => onChange({ ...draft, ...patch })}
          items={items}
          selfId={draft.id}
        />

        <label className="flex items-center gap-2.5 text-sm">
          <input type="checkbox" checked={draft.isAvailable}
            onChange={(event) => set("isAvailable", event.target.checked)} />
          Available to order
        </label>

        {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
      </DialogBody>

      <DialogFooter>
        <Btn type="button" variant="secondary" onClick={onCancel}>Cancel</Btn>
        <Btn type="button" disabled={saving || uploading || !valid} onClick={onSave}>
          {saving ? "Saving…" : "Save"}
        </Btn>
      </DialogFooter>
    </>
  );
}
