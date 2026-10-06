import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { YinResult } from "./yin.js";

export interface WindowRow { id: number; sampleRate: number; length: number; createdAt: string; }
export interface ReportRow { id: number; windowId: number | null; createdAt: string; status: string; }

export class Store {
  private db: DatabaseSync;
  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS windows (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sample_rate REAL NOT NULL,
        samples TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS reports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        window_id INTEGER,
        params TEXT NOT NULL,
        param_version TEXT NOT NULL,
        result TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  }
  saveWindow(sampleRate: number, samples: number[]): number {
    const r = this.db.prepare("INSERT INTO windows (sample_rate, samples) VALUES (?, ?)")
      .run(sampleRate, JSON.stringify(samples));
    return Number(r.lastInsertRowid);
  }
  getWindow(id: number): { sampleRate: number; samples: number[] } | null {
    const row = this.db.prepare("SELECT sample_rate, samples FROM windows WHERE id = ?").get(id) as
      | { sample_rate: number; samples: string } | undefined;
    if (!row) return null;
    return { sampleRate: row.sample_rate, samples: JSON.parse(row.samples) };
  }
  saveReport(windowId: number | null, params: object, result: YinResult): number {
    const r = this.db.prepare(
      "INSERT INTO reports (window_id, params, param_version, result) VALUES (?, ?, ?, ?)"
    ).run(windowId, JSON.stringify(params), result.paramVersion, JSON.stringify(result));
    return Number(r.lastInsertRowid);
  }
  getReport(id: number): { windowId: number | null; params: unknown; result: YinResult; createdAt: string } | null {
    const row = this.db.prepare("SELECT window_id, params, result, created_at FROM reports WHERE id = ?").get(id) as
      | { window_id: number | null; params: string; result: string; created_at: string } | undefined;
    if (!row) return null;
    return { windowId: row.window_id, params: JSON.parse(row.params), result: JSON.parse(row.result), createdAt: row.created_at };
  }
  listReports(limit = 50): ReportRow[] {
    const rows = this.db.prepare(
      "SELECT id, window_id, created_at, json_extract(result, '$.status') AS status FROM reports ORDER BY id DESC LIMIT ?"
    ).all(limit) as unknown as { id: number; window_id: number | null; created_at: string; status: string }[];
    return rows.map(r => ({ id: r.id, windowId: r.window_id, createdAt: r.created_at, status: r.status }));
  }
  close() { this.db.close(); }
}
