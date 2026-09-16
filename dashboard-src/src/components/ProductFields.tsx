import { ArrowDown, ArrowUp, Plus, X } from "lucide-react";
import type { MenuItem } from "@/lib/api";
import type { ComponentDraft } from "@/lib/productForm";
import { ChoiceGroups, type ChoiceGroupDraft } from "@/components/ChoiceGroups";
import { Btn, Picker, TextInput } from "@/components/menu-ui";

/** A fixed bundle's contents: which products, and how many of each. */
function ComponentEditor({
  components, onChange, items, selfId,
}: {
  components: ComponentDraft[];
  onChange: (next: ComponentDraft[]) => void;
  items: MenuItem[];
  selfId?: string;
}) {
  // A bundle cannot contain another bundle, or a product with options (its line
  // has nowhere to say which one); the server refuses both too.
  const choosable = items.filter((item) => !item.isBundle && !item.choices?.length && item.id !== selfId);
  const chosen = new Set(components.map((component) => component.productId).filter(Boolean));

  const patch = (index: number, next: Partial<ComponentDraft>) =>
    onChange(components.map((component, i) => (i === index ? { ...component, ...next } : component)));

  const move = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= components.length) return;
    const next = [...components];
    [next[index], next[target]] = [next[target]!, next[index]!];
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
          <Picker
            aria-label={`Component ${index + 1} product`}
            className="min-w-0 flex-1"
            value={component.productId}
            onChange={(e) => patch(index, { productId: e.target.value })}
          >
            <option value="">Choose a product…</option>
            {choosable
              .filter((item) => item.id === component.productId || !chosen.has(item.id))
              .map((item) => (
                <option key={item.id} value={item.id}>{item.name}</option>
              ))}
          </Picker>
          <TextInput
            aria-label={`Component ${index + 1} quantity`}
            className="w-16 shrink-0 tabular-nums"
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
        <Btn
          type="button" variant="secondary"
          onClick={() => onChange([...components, { productId: "", quantity: "1" }])}
        >
          <Plus className="w-3.5 h-3.5" /> Add product
        </Btn>
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
  components: ComponentDraft[];
  groups: ChoiceGroupDraft[];
  /** The bundle's own price, for the range the editor shows. */
  basePrice: number;
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
              ["choice", "Customer's choice — they pick from options"],
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
            <ChoiceGroups
              groups={form.groups}
              onChange={(groups) => onChange({ groups })}
              items={items.filter((item) => item.id !== selfId)}
              basePrice={form.basePrice}
            />
          )}
        </div>
      )}
    </div>
  );
}
