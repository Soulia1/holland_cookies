export declare const SHOP_TIME_ZONE: string;
export declare function endOfShopDay(date: string): string | null;
export declare function shopDateOf(iso: string): string;
export declare function shopDays(days: number, nowMs?: number): { dates: string[]; start: string };
