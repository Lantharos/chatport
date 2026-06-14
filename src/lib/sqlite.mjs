import Database from "better-sqlite3";

export function openSqlite(path, { readonly = true } = {}) {
  const db = new Database(path, { readonly, fileMustExist: true });
  db.pragma("journal_mode = WAL");
  return db;
}

export function rowsFromQuery(db, sql, params = []) {
  return db.prepare(sql).all(...params);
}

export function getValue(db, sql, params = []) {
  const row = db.prepare(sql).get(...params);
  return row ? Object.values(row)[0] : null;
}
