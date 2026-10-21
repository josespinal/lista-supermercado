import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  pin_hash TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS purchases (
  id INTEGER PRIMARY KEY,
  store TEXT NOT NULL DEFAULT '',
  purchased_on TEXT NOT NULL,
  total_cents INTEGER NOT NULL,
  currency TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  receipt_json TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  name_key TEXT NOT NULL,
  quantity TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  added_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL,
  in_cart INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'bought')),
  purchase_id INTEGER REFERENCES purchases(id) ON DELETE SET NULL,
  missed_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS items_status ON items(status);

-- What happened to each list item on a given trip. The name is copied so the
-- history still reads well after the item itself is edited or deleted.
CREATE TABLE IF NOT EXISTS purchase_items (
  purchase_id INTEGER NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,
  item_id INTEGER REFERENCES items(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  quantity TEXT NOT NULL DEFAULT '',
  outcome TEXT NOT NULL CHECK (outcome IN ('bought', 'missing')),
  receipt_line TEXT
);
CREATE INDEX IF NOT EXISTS purchase_items_purchase ON purchase_items(purchase_id);

-- Receipt photos. purchase_id stays NULL until the purchase is saved; orphans
-- are swept by deleteOrphanUploads().
CREATE TABLE IF NOT EXISTS uploads (
  id TEXT PRIMARY KEY,
  file TEXT NOT NULL,
  mime TEXT NOT NULL,
  purchase_id INTEGER REFERENCES purchases(id) ON DELETE CASCADE,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL
);
`;

// node:sqlite ships with Node, so nothing has to be compiled on the server.
// This thin layer gives it the few conveniences the store relies on: plain
// row objects, numeric ids, and transaction(fn).
class Db {
  constructor(file) {
    this.raw = new DatabaseSync(file);
  }

  exec(sql) {
    this.raw.exec(sql);
  }

  prepare(sql) {
    const statement = this.raw.prepare(sql);
    return {
      run: (...params) => {
        const { changes, lastInsertRowid } = statement.run(...params);
        return { changes: Number(changes), lastInsertRowid: Number(lastInsertRowid) };
      },
      get: (...params) => {
        const row = statement.get(...params);
        return row ? { ...row } : undefined;
      },
      all: (...params) => statement.all(...params).map((row) => ({ ...row })),
    };
  }

  transaction(fn) {
    return (...args) => {
      this.raw.exec("BEGIN");
      try {
        const result = fn(...args);
        this.raw.exec("COMMIT");
        return result;
      } catch (error) {
        this.raw.exec("ROLLBACK");
        throw error;
      }
    };
  }

  close() {
    this.raw.close();
  }
}

export function openDatabase(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new Db(path.join(dataDir, "lista.db"));
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA);
  return db;
}

// "  Leche   ENTERA " and "leche entera" are the same item; so are "Plátanos" and "platanos".
export function nameKey(name) {
  return name
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

const now = () => new Date().toISOString();

export function createStore(db) {
  const itemColumns = `
    i.id, i.name, i.quantity, i.note, i.in_cart AS inCart, i.missed_count AS missedCount,
    i.created_at AS createdAt, i.added_by AS addedById, u.name AS addedBy`;

  const getPendingItem = db.prepare(
    `SELECT ${itemColumns} FROM items i LEFT JOIN users u ON u.id = i.added_by
     WHERE i.id = ? AND i.status = 'pending'`,
  );

  const store = {
    // ---- users and sessions ----

    syncUsers(users, hashPin) {
      const upsert = db.prepare(
        `INSERT INTO users (name, pin_hash, active) VALUES (?, ?, 1)
         ON CONFLICT(name) DO UPDATE SET pin_hash = excluded.pin_hash, active = 1`,
      );
      db.transaction(() => {
        db.prepare("UPDATE users SET active = 0").run();
        for (const { name, pin } of users) upsert.run(name, hashPin(pin));
      })();
    },

    listUsers() {
      return db.prepare("SELECT id, name FROM users WHERE active = 1 ORDER BY id").all();
    },

    getUserWithPin(id) {
      return db.prepare("SELECT id, name, pin_hash AS pinHash FROM users WHERE id = ? AND active = 1").get(id);
    },

    createSession(tokenHash, userId) {
      db.prepare("INSERT INTO sessions (token_hash, user_id, created_at) VALUES (?, ?, ?)").run(tokenHash, userId, now());
    },

    getSessionUser(tokenHash) {
      return db
        .prepare(
          `SELECT u.id, u.name FROM sessions s JOIN users u ON u.id = s.user_id
           WHERE s.token_hash = ? AND u.active = 1`,
        )
        .get(tokenHash);
    },

    deleteSession(tokenHash) {
      db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash);
    },

    // ---- the shopping list ----

    listPendingItems() {
      return db
        .prepare(
          `SELECT ${itemColumns} FROM items i LEFT JOIN users u ON u.id = i.added_by
           WHERE i.status = 'pending'
           ORDER BY i.in_cart, i.missed_count > 0 DESC, i.id DESC`,
        )
        .all()
        .map(toItem);
    },

    getPendingItem(id) {
      const row = getPendingItem.get(id);
      return row ? toItem(row) : null;
    },

    // Returns { item, duplicate }. When the item is already on the list it is
    // returned as is, so two people adding "leche" don't end up with two lines.
    addItem({ name, quantity = "", note = "", userId }) {
      const key = nameKey(name);
      const existing = db.prepare("SELECT id FROM items WHERE status = 'pending' AND name_key = ?").get(key);
      if (existing) return { item: store.getPendingItem(existing.id), duplicate: true };
      const { lastInsertRowid } = db
        .prepare(
          `INSERT INTO items (name, name_key, quantity, note, added_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(name.trim(), key, quantity.trim(), note.trim(), userId, now());
      return { item: store.getPendingItem(lastInsertRowid), duplicate: false };
    },

    updateItem(id, changes) {
      const sets = [];
      const values = [];
      if (changes.name !== undefined) {
        sets.push("name = ?", "name_key = ?");
        values.push(changes.name.trim(), nameKey(changes.name));
      }
      if (changes.quantity !== undefined) {
        sets.push("quantity = ?");
        values.push(changes.quantity.trim());
      }
      if (changes.note !== undefined) {
        sets.push("note = ?");
        values.push(changes.note.trim());
      }
      if (changes.inCart !== undefined) {
        sets.push("in_cart = ?");
        values.push(changes.inCart ? 1 : 0);
      }
      if (sets.length > 0) {
        db.prepare(`UPDATE items SET ${sets.join(", ")} WHERE id = ? AND status = 'pending'`).run(...values, id);
      }
      return store.getPendingItem(id);
    },

    deletePendingItem(id) {
      return db.prepare("DELETE FROM items WHERE id = ? AND status = 'pending'").run(id).changes > 0;
    },

    // ---- receipt photos ----

    addUpload({ id, file, mime, userId }) {
      db.prepare("INSERT INTO uploads (id, file, mime, created_by, created_at) VALUES (?, ?, ?, ?, ?)").run(
        id,
        file,
        mime,
        userId,
        now(),
      );
    },

    getUpload(id) {
      return db.prepare("SELECT id, file, mime, purchase_id AS purchaseId FROM uploads WHERE id = ?").get(id);
    },

    // Photos that were taken but never attached to a saved purchase.
    deleteOrphanUploads(olderThanIso) {
      const rows = db
        .prepare("SELECT id, file FROM uploads WHERE purchase_id IS NULL AND created_at < ?")
        .all(olderThanIso);
      db.prepare("DELETE FROM uploads WHERE purchase_id IS NULL AND created_at < ?").run(olderThanIso);
      return rows.map((r) => r.file);
    },

    // ---- purchases ----

    // Saves a trip to the supermarket. Only the items the shopper reviewed are
    // settled: the bought ones leave the list, the rest stay on it as "missing"
    // so they are not forgotten next time. Items added while the review was
    // open are left alone.
    createPurchase({
      userId,
      store: storeName = "",
      purchasedOn,
      totalCents,
      currency,
      note = "",
      receiptData = null,
      reviewedItemIds,
      boughtItemIds,
      receiptLines = {},
      uploadIds = [],
    }) {
      return db.transaction(() => {
        const { lastInsertRowid: purchaseId } = db
          .prepare(
            `INSERT INTO purchases (store, purchased_on, total_cents, currency, note, receipt_json, created_by, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            storeName.trim(),
            purchasedOn,
            totalCents,
            currency,
            note.trim(),
            receiptData ? JSON.stringify(receiptData) : null,
            userId,
            now(),
          );

        const reviewed = new Set(reviewedItemIds);
        const bought = new Set(boughtItemIds);
        const pending = db.prepare("SELECT id, name, quantity FROM items WHERE status = 'pending'").all();
        const record = db.prepare(
          `INSERT INTO purchase_items (purchase_id, item_id, name, quantity, outcome, receipt_line)
           VALUES (?, ?, ?, ?, ?, ?)`,
        );
        const markBought = db.prepare(
          "UPDATE items SET status = 'bought', in_cart = 0, purchase_id = ? WHERE id = ?",
        );
        const markMissing = db.prepare(
          "UPDATE items SET in_cart = 0, missed_count = missed_count + 1 WHERE id = ?",
        );

        const missing = [];
        for (const item of pending) {
          if (!reviewed.has(item.id)) continue;
          const line = receiptLines[item.id] ?? null;
          if (bought.has(item.id)) {
            markBought.run(purchaseId, item.id);
            record.run(purchaseId, item.id, item.name, item.quantity, "bought", line);
          } else {
            markMissing.run(item.id);
            record.run(purchaseId, item.id, item.name, item.quantity, "missing", null);
            missing.push(item.name);
          }
        }

        const attach = db.prepare("UPDATE uploads SET purchase_id = ? WHERE id = ? AND purchase_id IS NULL");
        for (const uploadId of uploadIds) attach.run(purchaseId, uploadId);

        return { id: Number(purchaseId), missing };
      })();
    },

    listPurchases({ limit = 50, offset = 0 } = {}) {
      return db
        .prepare(
          `SELECT p.id, p.store, p.purchased_on AS purchasedOn, p.total_cents AS totalCents,
                  p.currency, p.note, u.name AS createdBy,
                  (SELECT COUNT(*) FROM purchase_items pi WHERE pi.purchase_id = p.id AND pi.outcome = 'bought') AS boughtCount,
                  (SELECT COUNT(*) FROM purchase_items pi WHERE pi.purchase_id = p.id AND pi.outcome = 'missing') AS missingCount,
                  (SELECT COUNT(*) FROM uploads up WHERE up.purchase_id = p.id) AS photoCount
           FROM purchases p LEFT JOIN users u ON u.id = p.created_by
           ORDER BY p.purchased_on DESC, p.id DESC
           LIMIT ? OFFSET ?`,
        )
        .all(limit, offset);
    },

    getPurchase(id) {
      const purchase = db
        .prepare(
          `SELECT p.id, p.store, p.purchased_on AS purchasedOn, p.total_cents AS totalCents,
                  p.currency, p.note, p.receipt_json AS receiptJson, p.created_at AS createdAt,
                  u.name AS createdBy
           FROM purchases p LEFT JOIN users u ON u.id = p.created_by
           WHERE p.id = ?`,
        )
        .get(id);
      if (!purchase) return null;
      const { receiptJson, ...rest } = purchase;
      const items = db
        .prepare(
          `SELECT item_id AS itemId, name, quantity, outcome, receipt_line AS receiptLine
           FROM purchase_items WHERE purchase_id = ? ORDER BY outcome, name`,
        )
        .all(id);
      const photos = db.prepare("SELECT id FROM uploads WHERE purchase_id = ? ORDER BY created_at").all(id);
      return {
        ...rest,
        receipt: receiptJson ? JSON.parse(receiptJson) : null,
        bought: items.filter((i) => i.outcome === "bought"),
        missing: items.filter((i) => i.outcome === "missing"),
        photoIds: photos.map((p) => p.id),
      };
    },

    updatePurchase(id, changes) {
      const columns = { store: "store", purchasedOn: "purchased_on", totalCents: "total_cents", note: "note" };
      const sets = [];
      const values = [];
      for (const [key, column] of Object.entries(columns)) {
        if (changes[key] === undefined) continue;
        sets.push(`${column} = ?`);
        values.push(typeof changes[key] === "string" ? changes[key].trim() : changes[key]);
      }
      if (sets.length > 0) db.prepare(`UPDATE purchases SET ${sets.join(", ")} WHERE id = ?`).run(...values, id);
      return store.getPurchase(id);
    },

    // Returns the photo files to remove from disk, or null when there was no such purchase.
    deletePurchase(id) {
      return db.transaction(() => {
        const files = db.prepare("SELECT file FROM uploads WHERE purchase_id = ?").all(id).map((r) => r.file);
        const { changes } = db.prepare("DELETE FROM purchases WHERE id = ?").run(id);
        return changes > 0 ? files : null;
      })();
    },

    // Spending per calendar month, newest first.
    monthlyTotals(months = 12) {
      return db
        .prepare(
          `SELECT substr(purchased_on, 1, 7) AS month, SUM(total_cents) AS totalCents, COUNT(*) AS purchases
           FROM purchases GROUP BY month ORDER BY month DESC LIMIT ?`,
        )
        .all(months);
    },
  };

  return store;
}

function toItem(row) {
  return { ...row, inCart: row.inCart === 1 };
}
