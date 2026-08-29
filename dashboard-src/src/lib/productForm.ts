import { discountProblem } from "@shared/productPricing.mjs";
import type { MenuItem } from "@/lib/api";
import { isProductCategory, type ProductCategory } from "@/lib/categories";

/**
 * The product form's own shape, shared by the Add card and the Edit dialog.
 *
 * Every field is a string because that is what an `<input>` holds: keeping
 * "85" as a string until the moment it is sent is what lets the admin clear
 * the box and type a new number, instead of the field snapping back to 0 the
 * instant it is empty.
 */

export interface ComponentDraft {
  productId: string;
  quantity: string;
}

export interface ProductDraft {
  name: string;
  nameAr: string;
  price: string;
  emoji: string;
  image: string;
  hoverImage: string;
  unit: string;
  category: ProductCategory | "";
  description: string;
  descriptionAr: string;
  order: string;
  isAvailable: boolean;
  isBundle: boolean;
  bundleType: "choice" | "fixed";
  bundleSize: string;
  bundleCategory: ProductCategory | "";
  components: ComponentDraft[];
  discountEnabled: boolean;
  discountType: "percent" | "fixed";
  discountValue: string;
}

export const emptyDraft: ProductDraft = {
  name: "",
  nameAr: "",
  price: "",
  emoji: "",
  image: "",
  hoverImage: "",
  unit: "cookie",
  category: "",
  description: "",
  descriptionAr: "",
  order: "0",
  isAvailable: true,
  isBundle: false,
  bundleType: "choice",
  bundleSize: "3",
  bundleCategory: "",
  components: [],
  discountEnabled: false,
  discountType: "percent",
  discountValue: "",
};

/**
 * An existing product, as the form holds it.
 *
 * A legacy category ("Signature", "") is dropped rather than shown as a
 * selected option that does not exist, so the admin is forced to pick a real
 * one — which is exactly what the save would otherwise fail on.
 */
export function draftFromItem(item: MenuItem): ProductDraft {
  return {
    name: item.name,
    nameAr: item.nameAr || "",
    price: String(item.price || ""),
    emoji: item.emoji || "",
    image: item.image || "",
    hoverImage: item.hoverImage || "",
    unit: item.unit || "cookie",
    category: (isProductCategory(item.category) ? item.category : "") as ProductCategory | "",
    description: item.description || "",
    descriptionAr: item.descriptionAr || "",
    order: String(item.order || 0),
    isAvailable: item.isAvailable !== false,
    isBundle: item.isBundle === true,
    bundleType: (item.bundleType === "fixed" ? "fixed" : "choice") as "choice" | "fixed",
    bundleSize: String(item.bundleSize || 3),
    bundleCategory: (isProductCategory(item.bundleCategory) ? item.bundleCategory : "") as ProductCategory | "",
    // Existing components are loaded so an edit does not silently wipe them.
    components: (item.components || []).map((component) => ({
      productId: component.productId,
      quantity: String(component.quantity),
    })),
    discountEnabled: item.discountEnabled === true,
    discountType: item.discountType === "fixed" ? "fixed" : "percent",
    discountValue: item.discountValue ? String(item.discountValue) : "",
  };
}

/**
 * Turns form strings into the API's shape. Fields belonging to the bundle kind
 * that is not selected are cleared, so an item that used to be a choice bundle
 * does not keep a stale size the storefront would still act on — and a fixed
 * one does not keep orphaned components. A switched-off discount is zeroed for
 * the same reason: a leftover value is one accidental toggle from being live.
 */
export function toPayload(form: ProductDraft) {
  const fixed = form.isBundle && form.bundleType === "fixed";
  const choice = form.isBundle && form.bundleType === "choice";
  return {
    ...form,
    price: Number(form.price),
    order: Number(form.order),
    bundleType: form.bundleType,
    bundleSize: choice ? Number(form.bundleSize) || 0 : 0,
    bundleCategory: choice ? form.bundleCategory : "",
    components: fixed
      ? form.components
          .filter((component) => component.productId)
          .map((component) => ({
            productId: component.productId,
            quantity: Number(component.quantity) || 0,
          }))
      : [],
    discountEnabled: form.discountEnabled,
    discountType: form.discountType,
    discountValue: form.discountEnabled ? Number(form.discountValue) || 0 : 0,
  };
}

/** The discount fields as the pricing helpers want them. */
export function pricingView(form: ProductDraft) {
  return {
    price: Number(form.price) || 0,
    discountEnabled: form.discountEnabled,
    discountType: form.discountType,
    discountValue: Number(form.discountValue) || 0,
  };
}

/**
 * Why this product cannot be saved yet, in words for the admin — or null.
 *
 * Caught here rather than as a 400 from the server, which would read as a
 * generic failure rather than telling them which field is missing. The server
 * enforces all of it again regardless; this only decides what they read.
 */
export function draftProblem(form: ProductDraft): string | null {
  if (!form.name.trim() || !form.price) return "Name and price are required.";
  if (!(Number(form.price) > 0)) return "Price has to be greater than zero.";
  if (!form.category) return "Choose a category — the storefront groups the menu by it.";

  if (form.isBundle && form.bundleType === "choice" && !form.bundleCategory) {
    return "Choose which category this bundle draws from.";
  }
  if (form.isBundle && form.bundleType === "fixed") {
    const filled = form.components.filter((component) => component.productId);
    if (filled.length === 0) return "Add at least one product to this bundle.";
    if (filled.some((component) => !(Number(component.quantity) > 0))) {
      return "Every component needs a quantity of at least 1.";
    }
  }

  return discountProblem(pricingView(form));
}
