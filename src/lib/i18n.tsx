import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

/**
 * Language, translations, and direction.
 *
 * A dictionary and sixty lines of context rather than an i18n library. This
 * project has form for declining libraries — no router, no smooth-scroll
 * helper, no icon font — and the reasoning is the same each time: what the
 * library is really selling is the boring parts underneath, and here those are
 * persistence, direction, and not shipping a half-translated page. All three
 * are handled below, and they are the whole job. Two languages, no plurals
 * beyond what a function key can express, no locale negotiation, no lazy
 * namespaces.
 *
 * **The type is the audit.** `Translations` is derived from the English
 * dictionary, so `ar` must satisfy exactly the same keys with exactly the same
 * shapes. A string added to English and forgotten in Arabic is a build failure,
 * not a customer in Cairo reading an English button. That is the mechanism that
 * makes "translate every visible string" enforceable rather than aspirational —
 * and it is why the dictionary is one object rather than two files that can
 * quietly drift apart.
 *
 * Direction is applied to the document in `index.html`, before the first paint;
 * see the comment there. This module owns the *state* and re-applies it on
 * change, but it is deliberately not the first thing to apply it.
 */

export type Lang = "en" | "ar";

const STORAGE_KEY = "holland-lang";

/**
 * Arabic web fonts, requested only for an Arabic reader.
 *
 * The Latin faces this site is built on — Playfair Display, Hanken Grotesk,
 * Poppins — contain no Arabic glyphs, so Arabic text falls back to whatever the
 * operating system offers: Segoe UI on Windows, Geeza Pro on iOS. The layout
 * would still be correct and the brand would still be gone. Amiri is the serif
 * standing in for Playfair; Cairo carries body and headline weights against
 * Hanken Grotesk and Poppins.
 *
 * The same href is in index.html for a visitor who arrives already in Arabic.
 * This path covers the visitor who switches at runtime, and the shared id is
 * what stops the two from both appending it.
 */
const ARABIC_FONTS_ID = "arabic-fonts";
const ARABIC_FONTS_HREF =
  "https://fonts.googleapis.com/css2?family=Amiri:wght@400;700&family=Cairo:wght@400;600;700;800&display=swap";

function ensureArabicFonts(): void {
  if (typeof document === "undefined") return;
  if (document.getElementById(ARABIC_FONTS_ID)) return;
  const link = document.createElement("link");
  link.id = ARABIC_FONTS_ID;
  link.rel = "stylesheet";
  link.href = ARABIC_FONTS_HREF;
  document.head.appendChild(link);
}

/**
 * The dictionary.
 *
 * The Arabic is Egyptian colloquial rather than Modern Standard — the register
 * the shop's customers actually speak, and the one Scooby's storefront is
 * written in. An MSA translation of a bakery's buttons reads like a bank.
 *
 * Product *names* are not in here. They live on the menu data beside the item
 * they name, because a name belongs to its product rather than to the interface
 * — see `nameAr` in data/menu.ts.
 */
const translations = {
  en: {
    // — Chrome ————————————————————————————————————————————————
    skipToMenu: "Skip to menu",
    brandHome: "Holland Cookies, back to top",
    navPrimary: "Primary",
    navMobile: "Mobile",
    navMenu: "Menu",
    navCraft: "Our Craft",
    navOrderNow: "Order Now",
    navOpenMenu: "Open menu",
    navCloseMenu: "Close menu",
    langSwitch: "Change language",
    langEnglish: "English",
    langArabic: "العربية",

    // — Hero ——————————————————————————————————————————————————
    heroTitleLine1: "Your Cookie Party",
    heroTitleLine2: "Starts Here!",
    heroSub:
      "Gather your friends and family around the warmest pan in Cairo. Hand-stuffed with molten chocolate, baked to order and delivered hot.",
    heroCta: "View Our Menu",
    heroPanAlt:
      "A thick chocolate chip cookie pie in an aluminium pan, its surface pooled with melted milk chocolate.",

    // — Best sellers ———————————————————————————————————————————
    bestTag: "The menu",
    bestTitle: "Best sellers",
    bestSub: "Three bakes we make every single day. Pans serve two to four — or one, honestly.",
    bestCta: "See the full menu",
    railPrev: "Previous products",
    railNext: "More products",

    // — Our craft ——————————————————————————————————————————————
    craftTag: "Our craft",
    craftTitle: "Dutch heart, Cairo oven.",
    craftBody:
      "Holland Cookies started with one stubborn idea: a cookie should be thick enough to need a fork and warm enough to pull apart. Everything is folded by hand in small batches, baked in individual pans, and never left to sit.",
    craftStep1Title: "Mixed by hand",
    craftStep1Body: "Small batches, real butter, no shortcuts, every morning.",
    craftStep2Title: "Stuffed generously",
    craftStep2Body: "A molten core of chocolate sealed inside every pan.",
    craftStep3Title: "Baked to order",
    craftStep3Body: "Out of the oven and into your box while still warm.",
    craftBoxAlt:
      "Three cookie pies in silver pans arranged in a white bakery box, seen from above.",

    // — Menu page ——————————————————————————————————————————————
    menuEyebrow: "Holland Cookies",
    menuTitle: "The Menu",
    menuWord: "Menu",
    menuCategoriesLabel: "Menu categories",
    menuSectionsLabel: (group: string) => `Sections in ${group}`,
    menuItemCount: (count: number) => (count === 1 ? "1 item" : `${count} items`),
    menuPriceFrom: (price: string) => `from ${price}`,
    menuPagerLabel: "Nearby categories",
    menuPrevCategory: "Previous",
    menuNextCategory: "Next",
    menuDetailClose: "Close",
    menuDetailOpen: (name: string) => `${name} — see details`,

    // — Cart ———————————————————————————————————————————————————
    addToCart: "Add to cart",
    addToCartNamed: (name: string) => `Add ${name} to cart`,
    cartOpen: "Open cart",
    cartTitle: "Your cart",
    cartClose: "Close cart",
    cartEmptyTitle: "Your cart is empty",
    cartEmptyBody: "Pick something warm from the menu — we bake it after you order.",
    cartEmptyCta: "Browse the menu",
    cartPieces: (n: number) => (n === 1 ? "1 piece" : `${n} pieces`),
    cartIncrease: (name: string) => `One more ${name}`,
    cartDecrease: (name: string) => `One fewer ${name}`,
    cartRemove: (name: string) => `Remove ${name}`,
    cartClear: "Clear cart",
    cartEach: "each",
    cartSubtotal: "Subtotal",
    ckTotal: "Total",
    cartCheckout: "Checkout",
    // Says what happens next, on the screen where the customer decides whether
    // to continue. Cash on delivery is the only method, so promising anything
    // about a card here would be a lie.
    cartHandoffNote: "Pay cash when your order arrives. Delivery is added at checkout.",
    cartAdded: (name: string) => `${name} added to your cart`,
    currency: "EGP",
    // Prices are whole pounds on the printed sheets; the .00 is the house style.
    price: (amount: number) => `${amount}.00 EGP`,


    // — Checkout ———————————————————————————————————————————————
    ckTitle: "Checkout",
    ckBackToCart: "Back to cart",
    ckSummary: "Your order",
    ckYourDetails: "Your details",
    ckFirstName: "First name",
    ckLastName: "Last name",
    ckPhone: "Phone",
    ckPhoneHint: "We message this number to confirm your order.",
    ckEmail: "Email",
    ckEmailOptional: "Optional — for your receipt.",
    ckHowTitle: "How would you like it?",
    ckDelivery: "Delivery",
    ckPickup: "Pickup",
    ckPickupNote: "Collect from Nasr City. Nothing to pay for delivery.",
    ckArea: "Area",
    ckAreaPlaceholder: "Choose your area",
    ckAddress: "Street address",
    ckBuilding: "Building",
    ckFloor: "Floor",
    ckApartment: "Apartment",
    ckLandmark: "Landmark",
    ckNotes: "Notes for the kitchen",
    ckNotesPlaceholder: "Anything we should know?",
    ckPromo: "Discount code",
    ckPromoApply: "Apply",
    ckPromoApplied: (code: string) => `${code} applied`,
    ckPromoRemove: "Remove",
    ckPayment: "Payment",
    ckPayCash: "Cash on delivery",
    ckPayCashNote: "Pay the driver when your order arrives.",
    // Pickup has no driver and nothing is delivered, so "cash on delivery"
    // is simply the wrong sentence — the customer pays at the counter.
    ckPayPickup: "Cash on pickup",
    ckPayPickupNote: "Pay at the counter when you collect.",
    ckPayCard: "Card",
    ckPayCardSoon: "Card payment is coming soon.",
    ckPlaceOrder: "Place order",
    ckPlacing: "Placing your order...",
    ckEmptyTitle: "There is nothing to check out",
    ckEmptyBody: "Your cart is empty. Pick something from the menu first.",
    ckPriceChanged: "Prices changed while you were checking out. Your total is now shown below — review it and try again.",
    ckClosed: "We are not taking orders at the moment. Please try again later.",
    ckGenericError: "We could not place your order. Please try again.",
    ckRequired: "This field is required.",

    // — Order confirmation & tracking ———————————————————————————
    okTitle: "Order placed!",
    rpPrinting: "Printing your receipt",
    rpComplete: "Order complete",
    rpTotalPaid: "TOTAL DUE",
    rpOrder: "Order",
    rpPaidWith: "Paying with",
    rpDate: "Date",
    okThanks: (name: string) => `Thanks, ${name} — we are on it.`,
    okReference: "Your reference",
    okNext: "We will message you on WhatsApp to confirm. Keep your reference safe.",
    okTrack: "Track this order",
    okContinue: "Back to the menu",
    trTitle: "Track your order",
    trIntro: "Enter your reference and the phone number you ordered with.",
    trReference: "Order reference",
    trReferencePlaceholder: "HC-1001",
    trPhone: "Phone number",
    trSubmit: "Find my order",
    trSearching: "Looking...",
    trNotFound: "We could not find an order with that reference and phone number.",
    trPlacedOn: "Placed on",
    trDeliveringTo: "Delivering to",
    trPickupFrom: "Pickup from the shop",
    trBadgeDelivery: "Delivering",
    trBadgePickup: "Pickup",
    trTotal: "Total",
    trAgain: "Track another order",
    trCancelledHelp: "Message us on WhatsApp if that is unexpected.",
    trNoSteps: "This order has no tracking information yet.",
    trProgress: "Progress",
    stPending: "Received",
    stConfirmed: "Confirmed",
    stBaking: "Baking",
    stOutForDelivery: "On its way",
    stCompleted: "Completed",
    stCancelled: "Cancelled",

    // — Account ————————————————————————————————————————————————
    acTitle: "Your orders",
    acIntro: "Enter your phone number and any one of your order references to see everything you have ordered.",
    acReference: "Any order reference",
    acWhyReference: "We ask for a reference so nobody else can look up your orders with just your number.",
    acPhone: "Phone number",
    acSubmit: "Show my orders",
    acNone: "We have no orders for that number yet.",
    acOrders: (n: number) => (n === 1 ? "1 order" : `${n} orders`),
    acView: "View",

    // — Account ————————————————————————————————————————————————
    acSignInTitle: "Sign in",
    acSignInIntro: "We email you a six-digit code. No password to remember.",
    acEmail: "Email address",
    acSendCode: "Email me a code",
    acSending: "Sending...",
    acCodeTitle: "Check your email",
    acCodeIntro: (email: string) => `We sent a six-digit code to ${email}.`,
    acCode: "Six-digit code",
    acVerify: "Sign in",
    acVerifying: "Checking...",
    acResend: "Send another code",
    acResendIn: (seconds: number) => `Send another code in ${seconds}s`,
    acWrongEmail: "Use a different email",
    acDevNotice:
      "No mail provider is connected yet, so the code was printed to the server log instead of being emailed.",
    acLinked: (n: number) =>
      n === 1 ? "We found 1 earlier order and added it to your account."
        : `We found ${n} earlier orders and added them to your account.`,
    acSignedInAs: "Signed in as",
    acSignOut: "Sign out",
    acProfile: "Your details",
    acFullName: "Full name",
    acProfilePhone: "Phone",
    acProfileArea: "Usual area",
    acProfileAddress: "Usual address",
    acSaveProfile: "Save details",
    acSavingProfile: "Saving...",
    acProfileSaved: "Saved.",
    acProfileHint: "We use these to fill in your next checkout.",
    acHistory: "Order history",
    acHistoryEmpty: "You have not ordered yet.",
    acGuestTitle: "Track an order without signing in",
    acGuestIntro: "Enter your reference and the phone number you ordered with.",
    // — Footer —————————————————————————————————————————————————
    footEmailLabel: "Email address",
    footEmailPlaceholder: "Email address",
    footSubscribe: "Subscribe",
    footConsent:
      "Sign up for new bakes and seasonal boxes. We only email when there is something worth opening.",
    footNavigate: "Navigate",
    footSocials: "Socials",
    footContact: "Contact",
    footHome: "Home",
    footMenu: "Menu",
    footCraft: "Our craft",
    footAddress:
      "27/19 Mohamed El-Moqrif St., off Hassan El-Mamoun — next to BIM Market, Nasr City",
    footHours: "Daily · 11:00 – 01:00",
    footCopyright: (year: number) => `© ${year} Holland Cookies. Baked fresh, always.`,
  },

  ar: {
    // — Chrome ————————————————————————————————————————————————
    skipToMenu: "تخطَّ إلى المنيو",
    brandHome: "هولاند كوكيز، ارجع لفوق",
    navPrimary: "الرئيسية",
    navMobile: "الموبايل",
    navMenu: "المنيو",
    navCraft: "صنعتنا",
    navOrderNow: "اطلب دلوقتي",
    navOpenMenu: "افتح القائمة",
    navCloseMenu: "اقفل القائمة",
    langSwitch: "غيّر اللغة",
    langEnglish: "English",
    langArabic: "العربية",

    // — Hero ——————————————————————————————————————————————————
    heroTitleLine1: "بارتي الكوكيز",
    heroTitleLine2: "بتبدأ من هنا!",
    heroSub:
      "لمّ أصحابك وعيلتك حوالين أدفى صاج في القاهرة. محشي بالإيد بشوكولاتة سايحة، بنخبزه بعد ما تطلب وبيوصلك سخن.",
    heroCta: "شوف المنيو",
    heroPanAlt: "صاج كوكيز تخين بالشوكولاتة، سطحه مغطى ببرك من الشوكولاتة باللبن السايحة.",

    // — Best sellers ———————————————————————————————————————————
    bestTag: "المنيو",
    bestTitle: "الأكتر طلبًا",
    bestSub: "تلات حاجات بنخبزهم كل يوم. الصاج يكفي اتنين لأربعة — أو واحد، وإحنا مش هنتكلم.",
    bestCta: "شوف المنيو كامل",
    railPrev: "المنتجات السابقة",
    railNext: "منتجات تانية",

    // — Our craft ——————————————————————————————————————————————
    craftTag: "صنعتنا",
    craftTitle: "قلب هولندي، فرن قاهري.",
    craftBody:
      "هولاند كوكيز بدأت بفكرة واحدة عنيدة: الكوكيز لازم تبقى تخينة لدرجة إنك تحتاج شوكة، ودافية لدرجة إنها تتقسم بإيدك. كل حاجة بتتعجن بالإيد على دفعات صغيرة، وبتتخبز في صواج مستقلة، وعمرها ما بتستنى.",
    craftStep1Title: "بتتعجن بالإيد",
    craftStep1Body: "دفعات صغيرة، زبدة حقيقية، من غير طرق مختصرة، كل صبح.",
    craftStep2Title: "محشية على الآخر",
    craftStep2Body: "قلب من الشوكولاتة السايحة مقفول جوه كل صاج.",
    craftStep3Title: "بتتخبز بعد ما تطلب",
    craftStep3Body: "من الفرن للبوكس بتاعك وهي لسه دافية.",
    craftBoxAlt: "تلات صواج كوكيز مرصوصة في بوكس مخبوزات أبيض، من فوق.",

    // — Menu page ——————————————————————————————————————————————
    menuEyebrow: "هولاند كوكيز",
    menuTitle: "المنيو",
    menuWord: "المنيو",
    menuCategoriesLabel: "أقسام المنيو",
    menuSectionsLabel: (group: string) => `أقسام ${group}`,
    // Arabic counts four ways, not two. Egyptian colloquial, matching the rest
    // of this dictionary: one, a dual, a small plural for three to ten, and the
    // singular again above that. Category sizes here run from two to seventeen,
    // so every one of those branches is reachable.
    menuItemCount: (count: number) => {
      if (count === 1) return "صنف واحد";
      if (count === 2) return "صنفين";
      if (count <= 10) return `${count} أصناف`;
      return `${count} صنف`;
    },
    menuPriceFrom: (price: string) => `يبدأ من ${price}`,
    menuPagerLabel: "أقسام قريبة",
    menuPrevCategory: "السابق",
    menuNextCategory: "التالي",
    menuDetailClose: "إقفل",
    menuDetailOpen: (name: string) => `${name} — شوف التفاصيل`,

    // — Cart ———————————————————————————————————————————————————
    addToCart: "ضيف للسلة",
    addToCartNamed: (name: string) => `ضيف ${name} للسلة`,
    cartOpen: "افتح السلة",
    cartTitle: "سلّتك",
    cartClose: "اقفل السلة",
    cartEmptyTitle: "سلّتك فاضية",
    cartEmptyBody: "اختار حاجة دافية من المنيو — بنخبزها بعد ما تطلب.",
    cartEmptyCta: "اتفرج على المنيو",
    // Arabic counts in ones, twos, a few (3–10) and many. English needs two
    // forms and Arabic needs four, which is precisely why these keys are
    // functions rather than strings with a number glued on the front.
    cartPieces: (n: number) =>
      n === 1 ? "قطعة واحدة" : n === 2 ? "قطعتين" : n <= 10 ? `${n} قطع` : `${n} قطعة`,
    cartIncrease: (name: string) => `زوّد ${name} واحدة`,
    cartDecrease: (name: string) => `قلّل ${name} واحدة`,
    cartRemove: (name: string) => `شيل ${name}`,
    cartClear: "فضّي السلة",
    cartEach: "للقطعة",
    cartSubtotal: "المجموع",
    ckTotal: "الإجمالي",
    cartCheckout: "إتمام الطلب",
    cartHandoffNote: "هتدفع كاش لما الطلب يوصلك. التوصيل بيتحسب عند إتمام الطلب.",
    cartAdded: (name: string) => `${name} اتضافت لسلّتك`,
    currency: "ج.م",
    price: (amount: number) => `${amount}.00 ج.م`,


    // — Checkout ———————————————————————————————————————————————
    ckTitle: "إتمام الطلب",
    ckBackToCart: "ارجع للسلة",
    ckSummary: "طلبك",
    ckYourDetails: "بياناتك",
    ckFirstName: "الاسم الأول",
    ckLastName: "اسم العيلة",
    ckPhone: "رقم الموبايل",
    ckPhoneHint: "هنبعتلك على الرقم ده عشان نأكد الطلب.",
    ckEmail: "البريد الإلكتروني",
    ckEmailOptional: "اختياري — عشان نبعتلك الفاتورة.",
    ckHowTitle: "عايز تستلمه إزاي؟",
    ckDelivery: "توصيل",
    ckPickup: "استلام من المحل",
    ckPickupNote: "هتستلم من مدينة نصر. مفيش رسوم توصيل.",
    ckArea: "المنطقة",
    ckAreaPlaceholder: "اختار منطقتك",
    ckAddress: "العنوان",
    ckBuilding: "رقم العمارة",
    ckFloor: "الدور",
    ckApartment: "الشقة",
    ckLandmark: "علامة مميزة",
    ckNotes: "ملاحظات للمطبخ",
    ckNotesPlaceholder: "فيه حاجة تحب تقولهالنا؟",
    ckPromo: "كود الخصم",
    ckPromoApply: "فعّل",
    ckPromoApplied: (code: string) => `${code} اتفعّل`,
    ckPromoRemove: "شيل",
    ckPayment: "الدفع",
    ckPayCash: "كاش عند التوصيل",
    ckPayCashNote: "هتدفع للسواق لما الطلب يوصلك.",
    ckPayPickup: "كاش عند الاستلام",
    ckPayPickupNote: "هتدفع عند الكاشير لما تيجي تستلم.",
    ckPayCard: "بالكارت",
    ckPayCardSoon: "الدفع بالكارت جاي قريب.",
    ckPlaceOrder: "أكد الطلب",
    ckPlacing: "بنسجل طلبك...",
    ckEmptyTitle: "مفيش حاجة تتطلب",
    ckEmptyBody: "سلّتك فاضية. اختار حاجة من المنيو الأول.",
    ckPriceChanged: "الأسعار اتغيرت وإنت بتكمل الطلب. الإجمالي الجديد تحت — راجعه وحاول تاني.",
    ckClosed: "مش بنستقبل طلبات دلوقتي. حاول كمان شوية.",
    ckGenericError: "معرفناش نسجل طلبك. حاول تاني.",
    ckRequired: "الخانة دي مطلوبة.",

    // — Order confirmation & tracking ———————————————————————————
    okTitle: "الطلب اتسجل!",
    rpPrinting: "بنطبع الإيصال",
    rpComplete: "الطلب اكتمل",
    rpTotalPaid: "الإجمالي المستحق",
    rpOrder: "رقم الطلب",
    rpPaidWith: "الدفع",
    rpDate: "التاريخ",
    okThanks: (name: string) => `شكرًا يا ${name} — إحنا بدأنا.`,
    okReference: "رقم طلبك",
    okNext: "هنبعتلك على واتساب نأكد الطلب. خلي بالك من رقم الطلب.",
    okTrack: "تابع الطلب",
    okContinue: "ارجع للمنيو",
    trTitle: "تابع طلبك",
    trIntro: "اكتب رقم الطلب ورقم الموبايل اللي طلبت بيه.",
    trReference: "رقم الطلب",
    trReferencePlaceholder: "HC-1001",
    trPhone: "رقم الموبايل",
    trSubmit: "دوّر على طلبي",
    trSearching: "بندوّر...",
    trNotFound: "ملقيناش طلب برقم الطلب ورقم الموبايل دول.",
    trPlacedOn: "اتطلب يوم",
    trDeliveringTo: "التوصيل إلى",
    trPickupFrom: "الاستلام من المحل",
    trBadgeDelivery: "في التوصيل",
    trBadgePickup: "استلام",
    trTotal: "الإجمالي",
    trAgain: "تابع طلب تاني",
    trCancelledHelp: "لو ده مش متوقع، كلمنا على واتساب.",
    trNoSteps: "لسه مفيش تفاصيل لتتبع الطلب ده.",
    trProgress: "الحالة",
    stPending: "وصلنا",
    stConfirmed: "اتأكد",
    stBaking: "في الفرن",
    stOutForDelivery: "في الطريق",
    stCompleted: "اتسلّم",
    stCancelled: "اتلغى",

    // — Account ————————————————————————————————————————————————
    acTitle: "طلباتك",
    acIntro: "اكتب رقم موبايلك وأي رقم طلب من طلباتك عشان تشوف كل اللي طلبته.",
    acReference: "أي رقم طلب",
    acWhyReference: "بنطلب رقم طلب عشان محدش تاني يقدر يشوف طلباتك برقم موبايلك بس.",
    acPhone: "رقم الموبايل",
    acSubmit: "وريني طلباتي",
    acNone: "لسه مفيش طلبات على الرقم ده.",
    acOrders: (n: number) =>
      n === 1 ? "طلب واحد" : n === 2 ? "طلبين" : n <= 10 ? `${n} طلبات` : `${n} طلب`,
    acView: "شوف",

    // — Account ————————————————————————————————————————————————
    acSignInTitle: "تسجيل الدخول",
    acSignInIntro: "هنبعتلك كود من ٦ أرقام على الإيميل. من غير باسورد تحفظه.",
    acEmail: "البريد الإلكتروني",
    acSendCode: "ابعتلي الكود",
    acSending: "بنبعت...",
    acCodeTitle: "بص على إيميلك",
    acCodeIntro: (email: string) => `بعتنا كود من ٦ أرقام على ${email}.`,
    acCode: "الكود",
    acVerify: "ادخل",
    acVerifying: "بنتأكد...",
    acResend: "ابعت كود تاني",
    acResendIn: (seconds: number) => `ابعت كود تاني بعد ${seconds} ثانية`,
    acWrongEmail: "استخدم إيميل تاني",
    acDevNotice: "لسه مفيش خدمة إيميل متوصلة، فالكود اتكتب في سجل السيرفر بدل ما يتبعت.",
    acLinked: (n: number) =>
      n === 1 ? "لقينا طلب واحد قديم وضفناه لحسابك."
        : n === 2 ? "لقينا طلبين قدام وضفناهم لحسابك."
        : `لقينا ${n} طلبات قديمة وضفناهم لحسابك.`,
    acSignedInAs: "داخل باسم",
    acSignOut: "تسجيل الخروج",
    acProfile: "بياناتك",
    acFullName: "الاسم بالكامل",
    acProfilePhone: "رقم الموبايل",
    acProfileArea: "منطقتك المعتادة",
    acProfileAddress: "عنوانك المعتاد",
    acSaveProfile: "احفظ البيانات",
    acSavingProfile: "بنحفظ...",
    acProfileSaved: "اتحفظ.",
    acProfileHint: "بنستخدمها عشان نملالك الطلب الجاي.",
    acHistory: "طلباتك السابقة",
    acHistoryEmpty: "لسه مطلبتش حاجة.",
    acGuestTitle: "تابع طلبك من غير تسجيل دخول",
    acGuestIntro: "اكتب رقم الطلب ورقم الموبايل اللي طلبت بيه.",
    // — Footer —————————————————————————————————————————————————
    footEmailLabel: "البريد الإلكتروني",
    footEmailPlaceholder: "البريد الإلكتروني",
    footSubscribe: "اشترك",
    footConsent:
      "اشترك عشان توصلك المخبوزات الجديدة وبوكسات المواسم. مبنبعتش إيميل غير لما يكون فيه حاجة تستاهل إنك تفتحها.",
    footNavigate: "روابط",
    footSocials: "السوشيال",
    footContact: "اتصل بينا",
    footHome: "الرئيسية",
    footMenu: "المنيو",
    footCraft: "صنعتنا",
    footAddress: "٢٧/١٩ ش محمد المقرِّف، من حسن المأمون — جنب بيم ماركت، مدينة نصر",
    footHours: "يوميًا · ١١:٠٠ ص – ١:٠٠ ص",
    footCopyright: (year: number) => `© ${year} هولاند كوكيز. مخبوز طازة، دايمًا.`,
  },
} as const;

/**
 * The contract every language must satisfy, derived from English.
 *
 * `ar` is checked against this by the annotation on `DICTIONARIES` below rather
 * than by a cast — which is the difference between the compiler proving the
 * Arabic is complete and us asserting that it is.
 */
export type Translations = {
  readonly [K in keyof (typeof translations)["en"]]: (typeof translations)["en"][K] extends (
    ...args: infer A
  ) => string
    ? (...args: A) => string
    : string;
};

const DICTIONARIES: Record<Lang, Translations> = translations;

/**
 * The raw dictionaries, for the test suite only.
 *
 * The type system proves the Arabic is *complete*; it cannot prove the Arabic
 * is in Arabic — a copy-pasted English value type-checks perfectly. The suite
 * in i18n.test.ts checks that, and it needs the two objects side by side to do
 * it. Named with the underscore prefix because nothing in the application
 * should read a dictionary directly: components take strings from `useLang`.
 */
export const __dictionaries = translations;

interface LangContextValue {
  lang: Lang;
  setLang: (lang: Lang) => void;
  toggleLang: () => void;
  /** `"rtl"` in Arabic. Exposed for the few places that must branch on it. */
  dir: "rtl" | "ltr";
  t: Translations;
}

const LangContext = createContext<LangContextValue | null>(null);

/**
 * The language the document is already in.
 *
 * Read from `<html lang>` rather than from storage, because the inline script
 * in index.html has already done the reading and the deciding — including the
 * private-mode fallback. Taking its answer rather than repeating its logic
 * means there is one place where "which language is this" is decided, and React
 * cannot disagree with the document it is mounting into.
 */
function initialLang(): Lang {
  if (typeof document === "undefined") return "en";
  return document.documentElement.lang === "ar" ? "ar" : "en";
}

/**
 * Put the document in a language *now*, rather than after the next paint.
 *
 * `dir` is what decides where every box on the page sits, so anything that
 * measures layout when the language changes reads the wrong direction if the
 * attribute is still sitting in an effect. And the provider's effect is
 * guaranteed to be late for exactly the components that care: a child's effects
 * run before its parent's, so a page that re-measures itself on `lang` does so
 * while the labels are already Arabic and the document is still `ltr`.
 *
 * The menu's travelling indicator is what caught it. Switching to Arabic left
 * it measured at the pill's left-to-right position — 939px from the pill it was
 * measured for — with the active label, coloured white to sit on it, stranded
 * unreadable on the page background. Nothing re-measured afterwards, because
 * nothing resized: only the direction had changed.
 *
 * Called from the setter for the same reason the font request below is, and
 * left in the effect too, which is what puts the document in the right
 * direction on first mount.
 */
function applyDocumentLanguage(lang: Lang) {
  document.documentElement.lang = lang;
  document.documentElement.dir = lang === "ar" ? "rtl" : "ltr";
}

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(initialLang);

  useEffect(() => {
    applyDocumentLanguage(lang);
    if (lang === "ar") ensureArabicFonts();
    try {
      localStorage.setItem(STORAGE_KEY, lang);
    } catch {
      // Private mode. The language still works for this visit, it just will not
      // be remembered — strictly better than failing to switch at all.
    }
  }, [lang]);

  // The font request is fired from the setter as well as the effect, so it goes
  // out with the click rather than after the render it is needed for. Without
  // it the switch paints one frame of Arabic in a system fallback face.
  const setLang = useCallback((next: Lang) => {
    if (next === "ar") ensureArabicFonts();
    applyDocumentLanguage(next);
    setLangState(next);
  }, []);

  // Routed through `setLang` rather than repeating its work in a state updater.
  // An updater has to be pure — React is free to call it twice — and this one
  // was already reaching outside itself to request fonts.
  const toggleLang = useCallback(() => {
    setLang(lang === "ar" ? "en" : "ar");
  }, [lang, setLang]);

  const value = useMemo<LangContextValue>(
    () => ({
      lang,
      setLang,
      toggleLang,
      dir: lang === "ar" ? "rtl" : "ltr",
      t: DICTIONARIES[lang],
    }),
    [lang, setLang, toggleLang],
  );

  return <LangContext.Provider value={value}>{children}</LangContext.Provider>;
}

export function useLang(): LangContextValue {
  const context = useContext(LangContext);
  if (!context) throw new Error("useLang must be used inside a LanguageProvider");
  return context;
}

/**
 * Pick the localized value of a *content* field, falling back to English.
 *
 * The fallback is the point. Interface strings are complete by construction —
 * the compiler enforces it — but content comes from the menu data and, later,
 * from a database an admin types into. A product whose Arabic name has not been
 * written yet must show its English name inside an otherwise Arabic page, not a
 * blank space where the name goes.
 */
export function localized(lang: Lang, en: string | undefined, ar?: string): string {
  return (lang === "ar" && ar) || en || "";
}
