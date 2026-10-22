export type SeedProfileName = "small" | "quick" | "demo" | "full";

export interface SeedProfile {
  name: SeedProfileName;
  regions: number;
  sellers: number;
  categories: number;
  products: number;
  customers: number;
  orders: number;
  itemsPerOrder: number;
}

export const SEED_PROFILES: Record<SeedProfileName, SeedProfile> = {
  /** All tables, ~1k rows — fast local dev */
  small: {
    name: "small",
    regions: 5,
    sellers: 25,
    categories: 20,
    products: 150,
    customers: 80,
    orders: 120,
    itemsPerOrder: 3,
  },
  /** Smoke / CI — ~250k rows */
  quick: {
    name: "quick",
    regions: 10,
    sellers: 200,
    categories: 50,
    products: 20_000,
    customers: 5_000,
    orders: 30_000,
    itemsPerOrder: 3,
  },
  /** ~1.2M rows */
  demo: {
    name: "demo",
    regions: 25,
    sellers: 2_000,
    categories: 200,
    products: 150_000,
    customers: 50_000,
    orders: 200_000,
    itemsPerOrder: 3,
  },
  /** ~3.9M rows (default) */
  full: {
    name: "full",
    regions: 50,
    sellers: 10_000,
    categories: 500,
    products: 500_000,
    customers: 200_000,
    orders: 800_000,
    itemsPerOrder: 3,
  },
};

export function resolveSeedProfile(): SeedProfile {
  const raw = (process.env.SEED_PROFILE ?? "full").toLowerCase();
  if (raw in SEED_PROFILES) return SEED_PROFILES[raw as SeedProfileName]!;
  console.warn(`Unknown SEED_PROFILE=${raw}, using full`);
  return SEED_PROFILES.full;
}
