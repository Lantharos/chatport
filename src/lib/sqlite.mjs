import Database from "better-sqlite3";
import fs from "node:fs";

export function openSqlite(path, { readonly = true } = {}) {
  if (!readonly && !fs.existsSync(path)) {
    const empty = new Database(path);
    empty.exec(`
      CREATE TABLE IF NOT EXISTS projection_projects (
        project_id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        workspace_root TEXT NOT NULL,
        scripts_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      );
      CREATE TABLE IF NOT EXISTS projection_threads (
        thread_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        title TEXT NOT NULL,
        branch TEXT,
        worktree_path TEXT,
        latest_turn_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      );
      CREATE TABLE IF NOT EXISTS projection_thread_messages (
        message_id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        turn_id TEXT,
        role TEXT NOT NULL,
        text TEXT NOT NULL,
        is_streaming INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS projection_thread_activities (
        activity_id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        turn_id TEXT,
        tone TEXT NOT NULL,
        kind TEXT NOT NULL,
        summary TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        sequence INTEGER
      );
      CREATE TABLE IF NOT EXISTS projection_turns (
        row_id INTEGER PRIMARY KEY AUTOINCREMENT,
        thread_id TEXT NOT NULL,
        turn_id TEXT,
        pending_message_id TEXT,
        assistant_message_id TEXT,
        state TEXT NOT NULL,
        requested_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        checkpoint_turn_count INTEGER,
        checkpoint_ref TEXT,
        checkpoint_status TEXT,
        checkpoint_files_json TEXT NOT NULL DEFAULT '[]',
        source_proposed_plan_thread_id TEXT,
        source_proposed_plan_id TEXT
      );
      CREATE TABLE IF NOT EXISTS projection_thread_sessions (
        thread_id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        provider_name TEXT,
        provider_session_id TEXT,
        provider_thread_id TEXT,
        active_turn_id TEXT,
        last_error TEXT,
        updated_at TEXT NOT NULL,
        runtime_mode TEXT NOT NULL DEFAULT 'full-access',
        provider_instance_id TEXT
      );
    `);
    empty.close();
  }
  const db = new Database(path, { readonly, fileMustExist: !readonly || fs.existsSync(path) });
  if (!readonly) db.pragma("journal_mode = WAL");
  return db;
}

export function rowsFromQuery(db, sql, params = []) {
  return db.prepare(sql).all(...params);
}

export function getValue(db, sql, params = []) {
  const row = db.prepare(sql).get(...params);
  return row ? Object.values(row)[0] : null;
}
