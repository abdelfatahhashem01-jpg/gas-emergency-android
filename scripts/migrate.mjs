import { readdir, readFile } from "node:fs/promises";
import { database, getDatabaseClient, closeDatabase } from "../db/client.js";

const sql = database();
try {
  await sql`CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')))`;
  const directory = new URL("../db/migrations/", import.meta.url);
  const names = (await readdir(directory)).filter((name) => /^\d+_[\w-]+\.sql$/.test(name)).sort();
  for (const name of names) {
    const applied = await sql`SELECT 1 FROM schema_migrations WHERE name = ${name}`;
    if (applied.length) continue;
    const migration = await readFile(new URL(name, directory), "utf8");
    const statements = migration.split(";").map((part) => part.trim()).filter(Boolean);
    const tx = await getDatabaseClient().transaction("write");
    try {
      for (const statement of statements) await tx.execute(statement);
      await tx.execute({ sql: "INSERT INTO schema_migrations (name) VALUES (?) ON CONFLICT(name) DO NOTHING", args: [name] });
      await tx.commit();
    } catch (error) {
      await tx.rollback();
      throw error;
    }
    console.log(`Applied ${name}`);
  }
  console.log("Database migrations complete.");
} finally {
  await closeDatabase();
}
