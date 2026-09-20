/**
 * The delivery areas the shop starts with: Greater Cairo, by governorate.
 *
 * One list, imported by the seed (which writes it into a shop that has never
 * been configured) and by the dashboard's Settings page (whose "Cairo & Giza"
 * button fills the editor with it). A second copy would drift, and the copy
 * that drifted would be the one an existing shop got.
 *
 * **Ids are stable and are what orders store.** `area` on an order is one of
 * these ids, and the dashboard and the receipt look the name up from it — so
 * renaming an area in the dashboard is safe and *re-ided* one is not: every
 * order already placed to it would lose its name. Nothing here is derived from
 * the display text at runtime for that reason.
 *
 * The list is the districts and satellite cities a Cairo shop actually delivers
 * to, not the full administrative division of two governorates: an Egyptian
 * customer looking for "Haram" wants to find it in a menu they can read, and
 * forty-odd entries is already the point at which it has to be grouped.
 * `city` is what that grouping is drawn from.
 *
 * What is deliberately absent: Obour, Shorouk's neighbours in Qalyubia, and the
 * rest of Greater Cairo that belongs to a third governorate. The shop asked for
 * Cairo and Giza, and an area list is a promise to drive there.
 */

/** Governorate ids, so the two names are written once. */
export const CAIRO = 'Cairo';
export const GIZA = 'Giza';

/** @type {{ id: string, name: string, nameAr: string, city: string, cityAr: string }[]} */
export const CAIRO_AREAS = [
  { id: 'nasr-city', name: 'Nasr City', nameAr: 'مدينة نصر' },
  { id: 'heliopolis', name: 'Heliopolis', nameAr: 'مصر الجديدة' },
  { id: 'sheraton', name: 'Sheraton', nameAr: 'شيراتون' },
  { id: 'nozha', name: 'Nozha', nameAr: 'النزهة' },
  { id: 'new-cairo', name: 'New Cairo', nameAr: 'القاهرة الجديدة' },
  { id: 'el-rehab', name: 'Al Rehab', nameAr: 'الرحاب' },
  { id: 'madinaty', name: 'Madinaty', nameAr: 'مدينتي' },
  { id: 'el-shorouk', name: 'El Shorouk', nameAr: 'الشروق' },
  { id: 'maadi', name: 'Maadi', nameAr: 'المعادي' },
  { id: 'mokattam', name: 'Mokattam', nameAr: 'المقطم' },
  { id: 'downtown', name: 'Downtown', nameAr: 'وسط البلد' },
  { id: 'garden-city', name: 'Garden City', nameAr: 'جاردن سيتي' },
  { id: 'zamalek', name: 'Zamalek', nameAr: 'الزمالك' },
  { id: 'manial', name: 'Manial', nameAr: 'المنيل' },
  { id: 'sayeda-zeinab', name: 'Sayeda Zeinab', nameAr: 'السيدة زينب' },
  { id: 'abbassia', name: 'Abbassia', nameAr: 'العباسية' },
  { id: 'shubra', name: 'Shubra', nameAr: 'شبرا' },
  { id: 'zeitoun', name: 'Zeitoun', nameAr: 'الزيتون' },
  { id: 'ain-shams', name: 'Ain Shams', nameAr: 'عين شمس' },
  { id: 'el-matareya', name: 'El Matareya', nameAr: 'المطرية' },
  { id: 'el-marg', name: 'El Marg', nameAr: 'المرج' },
  { id: 'el-salam-city', name: 'El Salam City', nameAr: 'مدينة السلام' },
  { id: 'helwan', name: 'Helwan', nameAr: 'حلوان' },
  { id: '15-may-city', name: '15th of May City', nameAr: 'مدينة ١٥ مايو' },
].map((area) => ({ ...area, city: CAIRO, cityAr: 'القاهرة' }));

/** @type {{ id: string, name: string, nameAr: string, city: string, cityAr: string }[]} */
export const GIZA_AREAS = [
  { id: 'mohandessin', name: 'Mohandessin', nameAr: 'المهندسين' },
  { id: 'dokki', name: 'Dokki', nameAr: 'الدقي' },
  { id: 'agouza', name: 'Agouza', nameAr: 'العجوزة' },
  { id: 'giza', name: 'Giza', nameAr: 'الجيزة' },
  { id: 'haram', name: 'Haram', nameAr: 'الهرم' },
  { id: 'faisal', name: 'Faisal', nameAr: 'فيصل' },
  { id: 'hadayek-el-ahram', name: 'Hadayek El Ahram', nameAr: 'حدائق الأهرام' },
  { id: 'bulaq-dakrour', name: 'Bulaq El Dakrour', nameAr: 'بولاق الدكرور' },
  { id: 'imbaba', name: 'Imbaba', nameAr: 'إمبابة' },
  { id: 'warraq', name: 'Warraq', nameAr: 'الوراق' },
  { id: 'sheikh-zayed', name: 'Sheikh Zayed', nameAr: 'الشيخ زايد' },
  { id: '6-october', name: '6th of October', nameAr: 'السادس من أكتوبر' },
  { id: 'hadayek-october', name: 'October Gardens', nameAr: 'حدائق أكتوبر' },
].map((area) => ({ ...area, city: GIZA, cityAr: 'الجيزة' }));

/**
 * Cairo first, then Giza, each in roughly the order a courier would think of
 * them rather than alphabetically — the select shows them in this order and an
 * alphabetical list puts Abbassia above Nasr City, which is not how anyone
 * picks their own neighbourhood.
 */
export const DEFAULT_AREAS = [...CAIRO_AREAS, ...GIZA_AREAS];

/**
 * The areas, split into the groups the checkout select renders as `<optgroup>`s.
 *
 * Areas with no `city` — anything typed in the dashboard before this field
 * existed — come back in one unlabelled group at the end rather than being
 * dropped. A delivery area that stops being offered because of a missing label
 * is an order the shop does not get.
 */
export function areasByCity(areas) {
  const groups = [];
  const index = new Map();
  for (const area of Array.isArray(areas) ? areas : []) {
    const key = area?.city || '';
    if (!index.has(key)) {
      const group = { city: key, cityAr: area?.cityAr || '', areas: [] };
      index.set(key, group);
      groups.push(group);
    }
    index.get(key).areas.push(area);
  }
  // An unlabelled group last, whatever order the areas arrived in.
  return groups.sort((a, b) => Number(!a.city) - Number(!b.city));
}
