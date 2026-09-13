import { ArrowDown, ArrowUp, Plus, Sparkles, Trash2, X } from "lucide-react";
import { useMemo, useState } from "react";

import type { MenuItem } from "@/lib/api";
import { categoryName, categoryOptions } from "@/lib/categories";
import { formatEGP } from "@/lib/format";

/**
 * The choice-group editor, from Bad Ziggy.
 *
 * A bundle has any number of groups, each with a label the customer reads, its
 * own number of picks, and its own explicit options:
 *
 *     Choose your cookies   2 of 5
 *     Choose your drink     1 of 4
 *
 * Options are named products, not "a category", so a bundle does not quietly
 * gain an item when something is re-filed; "Add all from…" expands a category
 * once and stays editable. A surcharge sits on the option. Every rule the server
 * enforces is shown here before saving, in the server's words.
 */

interface GroupOptionDraft {
  productId: string;
  surcharge: string;
}

export interface ChoiceGroupDraft {
  label: string;
  labelAr: string;
  choose: string;
  allowRepeats: boolean;
  options: GroupOptionDraft[];
}

const BLANK_GROUP: ChoiceGroupDraft = {
  label: "",
  labelAr: "",
  choose: "1",
  allowRepeats: false,
  options: [],
};

function groupProblem(group: ChoiceGroupDraft): string | null {
  const label = group.label.trim() || "This choice";
  if (!group.label.trim()) return "Give this choice a name the customer will read.";
  const chosen = group.options.filter((option) => option.productId);
  if (!chosen.length) return `“${label}” has no options to choose from.`;
  const ids = chosen.map((option) => option.productId);
  if (new Set(ids).size !== ids.length) return `“${label}” lists the same product twice.`;
  const choose = Number(group.choose) || 0;
  if (choose < 1) return `“${label}” must ask for at least one.`;
  if (!group.allowRepeats && choose > ids.length) {
    return `“${label}” asks for ${choose} but offers only ${ids.length}. Add more options or allow repeats.`;
  }
  return null;
}

function OptionRow({
  option, index, group, items, onChange, onRemove,
}: {
  option: GroupOptionDraft;
  index: number;
  group: ChoiceGroupDraft;
  items: MenuItem[];
  onChange: (patch: Partial<GroupOptionDraft>) => void;
  onRemove: () => void;
}) {
  const taken = new Set(
    group.options.filter((_, i) => i !== index).map((other) => other.productId),
  );
  const choosable = items.filter(
    (item) => !item.isBundle && (item.id === option.productId || !taken.has(item.id)),
  );

  return (
    <div className="flex items-center gap-1.5">
      <select
        aria-label={`Option ${index + 1} product`}
        className="adm-input min-w-0 flex-1"
        value={option.productId}
        onChange={(event) => onChange({ productId: event.target.value })}
      >
        <option value="">Choose a product…</option>
        {choosable.map((item) => (
          <option key={item.id} value={item.id}>{item.name}</option>
        ))}
      </select>

      <div className="flex shrink-0 items-center gap-1">
        <span className="text-xs text-muted-foreground">+</span>
        <input
          aria-label={`Option ${index + 1} surcharge`}
          className="adm-input w-20 shrink-0 tabular-nums"
          type="number"
          min="0"
          step="1"
          placeholder="0"
          value={option.surcharge}
          onChange={(event) => onChange({ surcharge: event.target.value })}
        />
      </div>

      <button
        type="button"
        aria-label={`Remove option ${index + 1}`}
        title="Remove"
        className="px-1.5 py-1 text-destructive"
        onClick={onRemove}
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}

function GroupCard({
  group, index, total, items, onChange, onMove, onRemove,
}: {
  group: ChoiceGroupDraft;
  index: number;
  total: number;
  items: MenuItem[];
  onChange: (patch: Partial<ChoiceGroupDraft>) => void;
  onMove: (direction: -1 | 1) => void;
  onRemove: () => void;
}) {
  const [fillFrom, setFillFrom] = useState("");
  const problem = groupProblem(group);
  const chosen = group.options.filter((option) => option.productId).length;
  const choose = Number(group.choose) || 0;

  function fill(categoryId: string) {
    if (!categoryId) return;
    const already = new Set(group.options.map((option) => option.productId));
    const additions = items
      .filter((item) => item.category === categoryId && !item.isBundle && item.isAvailable !== false)
      .filter((item) => !already.has(item.id))
      .map((item) => ({ productId: item.id, surcharge: "" }));
    if (additions.length) onChange({ options: [...group.options, ...additions] });
    setFillFrom("");
  }

  return (
    <div className="space-y-2.5 rounded-lg border border-border bg-card p-3">
      <div className="flex items-start gap-1.5">
        <div className="grid min-w-0 flex-1 gap-1.5 sm:grid-cols-2">
          <input
            aria-label={`Choice ${index + 1} name`}
            className="adm-input font-medium"
            placeholder="Choose your cookies"
            maxLength={80}
            value={group.label}
            onChange={(event) => onChange({ label: event.target.value })}
          />
          <input
            aria-label={`Choice ${index + 1} name in Arabic`}
            className="adm-input"
            dir="rtl"
            placeholder="اختار الكوكيز"
            maxLength={80}
            value={group.labelAr}
            onChange={(event) => onChange({ labelAr: event.target.value })}
          />
        </div>
        <button
          type="button" aria-label="Move this choice up" title="Move up"
          className="px-1.5 py-2 text-muted-foreground hover:text-foreground disabled:opacity-30"
          disabled={index === 0}
          onClick={() => onMove(-1)}
        >
          <ArrowUp className="size-3.5" />
        </button>
        <button
          type="button" aria-label="Move this choice down" title="Move down"
          className="px-1.5 py-2 text-muted-foreground hover:text-foreground disabled:opacity-30"
          disabled={index === total - 1}
          onClick={() => onMove(1)}
        >
          <ArrowDown className="size-3.5" />
        </button>
        <button
          type="button" aria-label="Remove this choice" title="Remove this choice"
          className="px-1.5 py-2 text-destructive"
          onClick={onRemove}
        >
          <Trash2 className="size-3.5" />
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
        <label className="flex items-center gap-2">
          Customer picks
          <input
            aria-label={`Choice ${index + 1} how many`}
            className="adm-input w-16 tabular-nums"
            type="number"
            min="1"
            max="12"
            value={group.choose}
            onChange={(event) => onChange({ choose: event.target.value })}
          />
          <span className="text-muted-foreground">of {chosen || "—"}</span>
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="size-4 accent-primary"
            checked={group.allowRepeats}
            onChange={(event) => onChange({ allowRepeats: event.target.checked })}
          />
          Allow the same one twice
        </label>
      </div>

      <div className="space-y-1.5">
        {group.options.map((option, optionIndex) => (
          <OptionRow
            key={optionIndex}
            option={option}
            index={optionIndex}
            group={group}
            items={items}
            onChange={(patch) =>
              onChange({
                options: group.options.map((current, i) =>
                  i === optionIndex ? { ...current, ...patch } : current,
                ),
              })
            }
            onRemove={() => onChange({ options: group.options.filter((_, i) => i !== optionIndex) })}
          />
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1.5 text-xs hover:bg-accent"
          onClick={() => onChange({ options: [...group.options, { productId: "", surcharge: "" }] })}
        >
          <Plus className="size-3.5" /> Add option
        </button>

        <label className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
          <Sparkles className="size-3.5" aria-hidden />
          <select
            aria-label={`Fill choice ${index + 1} from a category`}
            className="adm-input w-auto py-1 text-xs"
            value={fillFrom}
            onChange={(event) => fill(event.target.value)}
          >
            <option value="">Add all from…</option>
            {categoryOptions().map((category) => (
              <option key={category.id} value={category.id}>{categoryName(category.id)}</option>
            ))}
          </select>
        </label>

        {!problem && choose > 0 && (
          <span className="ms-auto text-xs text-muted-foreground">
            {chosen === choose && !group.allowRepeats ? "One of everything" : `${chosen} to pick from`}
          </span>
        )}
      </div>

      {problem && <p role="alert" className="text-xs text-destructive">{problem}</p>}
    </div>
  );
}

export function ChoiceGroups({
  groups, onChange, items, basePrice,
}: {
  groups: ChoiceGroupDraft[];
  onChange: (groups: ChoiceGroupDraft[]) => void;
  items: MenuItem[];
  basePrice: number;
}) {
  // A range, because surcharges are optional upgrades: the cheapest pick of
  // every choice costs the base price, the dearest the top of the range.
  const range = useMemo(() => {
    let most = 0;
    for (const group of groups) {
      const picks = Math.max(1, Number(group.choose) || 1);
      const surcharges = group.options
        .filter((option) => option.productId)
        .map((option) => Number(option.surcharge) || 0)
        .sort((a, b) => b - a);
      if (!surcharges.length) continue;
      const dearest = group.allowRepeats
        ? Array.from({ length: picks }, () => surcharges[0] ?? 0)
        : surcharges.slice(0, picks);
      most += dearest.reduce((sum, value) => sum + value, 0);
    }
    return { from: basePrice, to: basePrice + most };
  }, [groups, basePrice]);

  const patch = (index: number, changes: Partial<ChoiceGroupDraft>) =>
    onChange(groups.map((group, i) => (i === index ? { ...group, ...changes } : group)));

  const move = (index: number, direction: -1 | 1) => {
    const next = [...groups];
    const target = index + direction;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target]!, next[index]!];
    onChange(next);
  };

  return (
    <div className="space-y-2.5">
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-[13px] font-medium text-foreground">What the customer chooses</p>
        {groups.length > 0 && (
          <p className="text-xs text-muted-foreground">
            {groups.length} choice{groups.length === 1 ? "" : "s"}
          </p>
        )}
      </div>

      {groups.length === 0 && (
        <p className="text-xs text-destructive">
          Add at least one choice — a bundle the customer cannot configure cannot be ordered.
        </p>
      )}

      {groups.map((group, index) => (
        <GroupCard
          key={index}
          group={group}
          index={index}
          total={groups.length}
          items={items}
          onChange={(changes) => patch(index, changes)}
          onMove={(direction) => move(index, direction)}
          onRemove={() => onChange(groups.filter((_, i) => i !== index))}
        />
      ))}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <button
          type="button"
          className="inline-flex items-center gap-1 rounded-md border border-border px-3 py-1.5 text-xs hover:bg-accent"
          onClick={() => onChange([...groups, { ...BLANK_GROUP }])}
        >
          <Plus className="size-3.5" /> Add another choice
        </button>

        {groups.length > 0 && (
          <p className="text-xs text-muted-foreground">
            Customer pays{" "}
            <span className="font-medium text-foreground">{formatEGP(range.from)}</span>
            {range.to > range.from && (
              <>
                {" – "}
                <span className="font-medium text-foreground">{formatEGP(range.to)}</span>
                {" depending on upgrades"}
              </>
            )}
          </p>
        )}
      </div>
    </div>
  );
}
