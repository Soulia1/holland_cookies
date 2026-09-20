import { describe, expect, it } from "vitest";
import { localized } from "./i18n";

/**
 * The compiler already proves the Arabic dictionary has every English key with
 * every English shape — that is what `Translations` is for, and it is a
 * stronger guarantee than a test could give.
 *
 * What it cannot prove is that the Arabic is *Arabic*. A copy-pasted English
 * value satisfies the type perfectly and ships an English button to a customer
 * reading Arabic, which is exactly the failure the type was meant to prevent.
 * So this file checks the one thing the type system cannot see: that the two
 * dictionaries actually differ, everywhere they should.
 */

// Imported through the module's private shape rather than re-exported from it:
// the dictionary is an implementation detail of the provider and nothing in the
// app should be reading it directly.
const mod = (await import("./i18n")) as any;

/** Values that are intentionally identical in both languages. */
const SHARED_BY_DESIGN = new Set([
  // Written in their own language on purpose — the point of the switcher is
  // that someone who cannot read the current language can still find theirs.
  "langEnglish",
  "langArabic",
  // An order reference, shown as an example of what to type. References are
  // issued as `HC-1001` in both languages, so translating the placeholder
  // would be showing the customer a format that does not exist.
  "trReferencePlaceholder",
  // An area beside its delivery price — a name, a dash and a figure, both of
  // which are already localized by the time they arrive here. There is no word
  // in it to translate, and inventing a different separator for Arabic would be
  // a difference for this test's benefit rather than a reader's.
  "ckAreaOption",
]);

function dictionaries() {
  // The dictionary is module-private, so it is reached through the context
  // value the provider builds. Rendering React here would need a DOM for no
  // benefit; the two objects are plain data.
  const en = mod.__dictionaries?.en;
  const ar = mod.__dictionaries?.ar;
  return { en, ar };
}

describe("localized", () => {
  it("prefers Arabic when it exists", () => {
    expect(localized("ar", "Vanilla", "فانيليا")).toBe("فانيليا");
  });

  it("falls back to English when the Arabic has not been transcribed yet", () => {
    // The state most of the menu is in until the printed sheets are read: an
    // English product name inside an Arabic page, which is a blemish, rather
    // than an empty gap, which is a bug.
    expect(localized("ar", "Despacito", undefined)).toBe("Despacito");
    expect(localized("ar", "Despacito", "")).toBe("Despacito");
  });

  it("never returns Arabic to an English reader", () => {
    expect(localized("en", "Vanilla", "فانيليا")).toBe("Vanilla");
  });

  it("returns an empty string rather than undefined when there is nothing", () => {
    expect(localized("ar", undefined, undefined)).toBe("");
  });
});

describe("the Arabic dictionary", () => {
  const { en, ar } = dictionaries();

  it("is exposed for testing", () => {
    expect(en, "i18n must export __dictionaries for this suite").toBeTruthy();
    expect(ar).toBeTruthy();
  });

  it("covers every English key", () => {
    expect(Object.keys(ar).sort()).toEqual(Object.keys(en).sort());
  });

  it("has no value left in English", () => {
    const untranslated = Object.keys(en).filter((key) => {
      if (SHARED_BY_DESIGN.has(key)) return false;
      const a = en[key];
      const b = ar[key];
      if (typeof a === "function") return String(a("x")) === String(b("x"));
      return a === b;
    });
    expect(untranslated).toEqual([]);
  });

  it("writes its strings in Arabic script", () => {
    const arabic = /[؀-ۿ]/;
    const notArabic = Object.keys(ar).filter((key) => {
      if (SHARED_BY_DESIGN.has(key)) return false;
      const value = ar[key];
      const text = typeof value === "function" ? String(value("عينة")) : String(value);
      // A value made only of digits, punctuation or a brand name has no letters
      // to be in the wrong script.
      if (!/\p{L}/u.test(text)) return false;
      return !arabic.test(text);
    });
    expect(notArabic).toEqual([]);
  });

  it("keeps every function key callable in both languages", () => {
    for (const key of Object.keys(en)) {
      if (typeof en[key] !== "function") continue;
      expect(typeof ar[key], `${key} must be a function in Arabic too`).toBe("function");
      // Called with both shapes the dictionary uses, so a key that takes a
      // number is not silently satisfied by one that ignores its argument.
      expect(String(ar[key](1))).not.toBe("");
      expect(String(ar[key]("عينة"))).not.toBe("");
    }
  });
});
