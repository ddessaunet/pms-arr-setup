// jobs/stack-api/store.ts — what stack-api keeps between restarts, in SQLite
// (/opt/appdata/stack-api/stack-api.sqlite):
//
//   kv        this install's Plex client identifier
//   pins      the PINs this process asked plex.tv for, so a poll for any other
//             id is refused (and when, so an old one expires here too)
//   sessions  signed-in browsers: the SHA-256 of the cookie, never the cookie,
//             and never a Plex token
//   releases  the last release search per title ('radarr:148'), summarised
//             (request-doctor.ts), so a search's answer outlives a restart
//
// Times are epoch milliseconds, from the caller's clock.

import { Database } from 'bun:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import type { ReleaseSummary } from '../../stack/lib/request-doctor.ts';

export interface Session {
  accountId: number;
  username: string;
  created: number;
  expires: number;
  lastSeen: number;
}

/** The stored form of a session cookie's value. */
export const sessionHash = (token: string) => createHash('sha256').update(token).digest('hex');

export class Store {
  readonly db: Database;

  constructor(path: string) {
    this.db = new Database(path, { create: true, strict: true });
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS pins (id INTEGER PRIMARY KEY, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (
        hash TEXT PRIMARY KEY,
        account_id INTEGER NOT NULL,
        username TEXT NOT NULL,
        created INTEGER NOT NULL,
        expires INTEGER NOT NULL,
        last_seen INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS releases (key TEXT PRIMARY KEY, searched_at INTEGER NOT NULL, summary TEXT NOT NULL);
    `);
  }

  close(): void {
    this.db.close();
  }

  /** This install's X-Plex-Client-Identifier: made once, then kept, as plex.tv lists it as a device. */
  clientId(): string {
    const row = this.db.query<{ value: string }, []>(`SELECT value FROM kv WHERE key = 'plexClientId'`).get();
    if (row) return row.value;
    const id = randomUUID();
    this.db.query(`INSERT INTO kv (key, value) VALUES ('plexClientId', ?)`).run(id);
    return id;
  }

  addPin(id: number, now: number): void {
    this.db.query(`INSERT OR REPLACE INTO pins (id, created) VALUES (?, ?)`).run(id, now);
  }

  /** When this process asked for the PIN; null when it never did. */
  pinCreated(id: number): number | null {
    return (
      this.db.query<{ created: number }, [number]>(`SELECT created FROM pins WHERE id = ?`).get(id)?.created ?? null
    );
  }

  dropPin(id: number): void {
    this.db.query(`DELETE FROM pins WHERE id = ?`).run(id);
  }

  addSession(token: string, account: { id: number; username: string }, now: number, ttlMs: number): void {
    this.db
      .query(`INSERT INTO sessions (hash, account_id, username, created, expires, last_seen) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(sessionHash(token), account.id, account.username, now, now + ttlMs, now);
  }

  /** The session a cookie value opens, unless it expired. */
  session(token: string, now: number): Session | null {
    const row = this.db
      .query<
        { account_id: number; username: string; created: number; expires: number; last_seen: number },
        [string, number]
      >(`SELECT account_id, username, created, expires, last_seen FROM sessions WHERE hash = ? AND expires > ?`)
      .get(sessionHash(token), now);
    if (!row) return null;
    return {
      accountId: row.account_id,
      username: row.username,
      created: row.created,
      expires: row.expires,
      lastSeen: row.last_seen,
    };
  }

  touchSession(token: string, now: number): void {
    this.db.query(`UPDATE sessions SET last_seen = ? WHERE hash = ?`).run(now, sessionHash(token));
  }

  dropSession(token: string): void {
    this.db.query(`DELETE FROM sessions WHERE hash = ?`).run(sessionHash(token));
  }

  putReleases(key: string, summary: ReleaseSummary): void {
    this.db
      .query(`INSERT OR REPLACE INTO releases (key, searched_at, summary) VALUES (?, ?, ?)`)
      .run(key, summary.searchedAt, JSON.stringify(summary));
  }

  /** The last search's summary for a title, unless it is older than `since`. */
  releases(key: string, since: number): ReleaseSummary | null {
    const row = this.db
      .query<{ summary: string }, [string, number]>(`SELECT summary FROM releases WHERE key = ? AND searched_at > ?`)
      .get(key, since);
    return row ? (JSON.parse(row.summary) as ReleaseSummary) : null;
  }

  /** Expired sessions and PINs older than pinTtlMs. */
  prune(now: number, pinTtlMs: number): void {
    this.db.query(`DELETE FROM sessions WHERE expires <= ?`).run(now);
    this.db.query(`DELETE FROM pins WHERE created <= ?`).run(now - pinTtlMs);
  }
}
