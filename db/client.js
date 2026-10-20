import { createClient } from "@libsql/client";

let client;

function getClient() {
  if (!process.env.TURSO_DATABASE_URL || !process.env.TURSO_AUTH_TOKEN) {
    throw new Error("TURSO_DATABASE_URL and TURSO_AUTH_TOKEN are required");
  }
  if (!client) {
    client = createClient({
      url: process.env.TURSO_DATABASE_URL,
      authToken: process.env.TURSO_AUTH_TOKEN,
      intMode: "number",
    });
  }
  return client;
}

function makeTag(target) {
  const sql = (strings, ...values) => {
    if (Array.isArray(strings)) return { __sqlList: true, values: strings };
    let statement = strings[0];
    const args = [];
    for (let i = 0; i < values.length; i += 1) {
      const value = values[i];
      if (value?.__sqlList) {
        statement += value.values.map(() => "?").join(", ");
        args.push(...value.values.map(normalizeValue));
      } else {
        statement += "?";
        args.push(normalizeValue(value));
      }
      statement += strings[i + 1];
    }
    statement = statement
      .replace(/::(?:uuid|integer|text|timestamptz)\b/gi, "")
      .replace(/\bnow\(\)/gi, "strftime('%Y-%m-%dT%H:%M:%fZ','now')")
      .replace(/\s+FOR UPDATE\b/gi, "");
    return target.execute({ sql: statement, args }).then((result) => result.rows.map((row) => {
      const normalized = { ...row };
      for (const key of ["ops_card", "extra_data", "details", "value"]) {
        if (typeof normalized[key] === "string") {
          try { normalized[key] = JSON.parse(normalized[key]); } catch { /* Keep malformed legacy values visible for repair. */ }
        }
      }
      return normalized;
    }));
  };

  sql.json = (value) => JSON.stringify(value);
  sql.list = (values) => ({ __sqlList: true, values });
  sql.begin = async (callback) => {
    const tx = await getClient().transaction("write");
    try {
      const result = await callback(makeTag(tx));
      await tx.commit();
      return result;
    } catch (error) {
      await tx.rollback();
      throw error;
    }
  };
  return sql;
}

function normalizeValue(value) {
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return new Uint8Array(value);
  return value;
}

export function database() {
  return makeTag(getClient());
}

export async function closeDatabase() {
  if (client) {
    await client.close();
    client = undefined;
  }
}

export function getDatabaseClient() {
  return getClient();
}
