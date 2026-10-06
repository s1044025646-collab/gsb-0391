/** SQLite 持久化：保存原始采样、参数版本与结果；重算创建新报告，不覆盖历史。 */
import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import type { YinParams, YinResult, YinError } from "./yin.js";

export const PARAMS_VERSION = "yin-int-v1";

export interface StoredWindow {
  id: number;
  sampleRate: number;
  samples: number[];
  createdAt: string;
}

export interface StoredReport {
  id: number;
  windowId: number;
  paramsVersion: string;
  params: YinParams;
  status: string;
  result: YinResult | YinError;
  createdAt: string;
}

export class Store {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS windows (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sample_rate REAL NOT NULL,
        samples TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS reports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        window_id INTEGER NOT NULL REFERENCES windows(id),
        params_version TEXT NOT NULL,
        params TEXT NOT NULL,
        status TEXT NOT NULL,
        result TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  }

  saveWindow(samples: number[], sampleRate: number): number {
    const r = this.db
      .prepare("INSERT INTO windows (sample_rate, samples) VALUES (?, ?)")
      .run(sampleRate, JSON.stringify(samples));
    return Number(r.lastInsertRowid);
  }

  getWindow(id: number): StoredWindow | null {
    const row = this.db.prepare("SELECT * FROM windows WHERE id = ?").get(id) as
      | { id: number; sample_rate: number; samples: string; created_at: string }
      | undefined;
    if (!row) return null;
    return { id: row.id, sampleRate: row.sample_rate, samples: JSON.parse(row.samples), createdAt: row.created_at };
  }

  saveReport(windowId: number, params: YinParams, result: YinResult | YinError): number {
    const r = this.db
      .prepare("INSERT INTO reports (window_id, params_version, params, status, result) VALUES (?, ?, ?, ?, ?)")
      .run(windowId, PARAMS_VERSION, JSON.stringify(params), result.status, JSON.stringify(result));
    return Number(r.lastInsertRowid);
  }

  getReport(id: number): StoredReport | null {
    const row = this.db.prepare("SELECT * FROM reports WHERE id = ?").get(id) as
      | { id: number; window_id: number; params_version: string; params: string; status: string; result: string; created_at: string }
      | undefined;
    if (!row) return null;
    return {
      id: row.id,
      windowId: row.window_id,
      paramsVersion: row.params_version,
      params: JSON.parse(row.params),
      status: row.status,
      result: JSON.parse(row.result),
      createdAt: row.created_at,
    };
  }

  listReports(limit = 50): Array<Omit<StoredReport, "result">> {
    const rows = this.db
      .prepare("SELECT id, window_id, params_version, params, status, created_at FROM reports ORDER BY id DESC LIMIT ?")
      .all(limit) as Array<{ id: number; window_id: number; params_version: string; params: string; status: string; created_at: string }>;
    return rows.map((r) => ({
      id: r.id,
      windowId: r.window_id,
      paramsVersion: r.params_version,
      params: JSON.parse(r.params),
      status: r.status,
      createdAt: r.created_at,
    }));
  }

  close(): void {
    this.db.close();
  }
}

export function defaultDbPath(): string {
  return path.join(process.cwd(), "data", "yin.db");
}
