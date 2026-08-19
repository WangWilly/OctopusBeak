/**
 * Cathay compatibility adapter.
 *
 * Canonical SQLite ownership lives in canonical-source-store.ts so every
 * integration shares one schema, migration chain, writer queue, and snapshot
 * implementation. Keep this module as the stable Cathay import path.
 */
export * from "./canonical-source-store.ts";
