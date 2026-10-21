import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import multer from "multer";
import {
  createLoginLimiter,
  endSession,
  sessionUser,
  startSession,
  verifyPin,
} from "./auth.js";
import { createEventHub } from "./events.js";
import { ReceiptReadError } from "./receipt.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(here, "..", "public");

const MAX_PHOTOS_PER_RECEIPT = 5;
const MAX_TOTAL_CENTS = 100_000_000;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// The file's first bytes decide its type; the browser's claim is not trusted.
function sniffImage(buffer) {
  if (buffer.length < 12) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return { mime: "image/jpeg", ext: "jpg" };
  if (buffer.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) return { mime: "image/png", ext: "png" };
  if (buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") {
    return { mime: "image/webp", ext: "webp" };
  }
  if (buffer.toString("ascii", 0, 4) === "GIF8") return { mime: "image/gif", ext: "gif" };
  return null;
}

function text(value, { field, max, required = false }) {
  if (value === undefined || value === null) {
    if (required) throw new HttpError(400, `Falta ${field}.`);
    return undefined;
  }
  if (typeof value !== "string") throw new HttpError(400, `${field} no es válido.`);
  const trimmed = value.trim();
  if (required && !trimmed) throw new HttpError(400, `Falta ${field}.`);
  if (trimmed.length > max) throw new HttpError(400, `${field} es muy largo (máximo ${max} caracteres).`);
  return trimmed;
}

function cents(value) {
  if (!Number.isInteger(value) || value < 0 || value > MAX_TOTAL_CENTS) {
    throw new HttpError(400, "El total no es válido.");
  }
  return value;
}

function isoDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new HttpError(400, "La fecha no es válida.");
  }
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new HttpError(400, "La fecha no es válida.");
  }
  return value;
}

function idList(value, field) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((v) => !Number.isInteger(v))) {
    throw new HttpError(400, `${field} no es válido.`);
  }
  return value;
}

function routeId(req) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(404, "No existe.");
  return id;
}

export function createApp({ config, store, receiptReader }) {
  const app = express();
  const uploadsDir = path.join(config.dataDir, "uploads");
  fs.mkdirSync(uploadsDir, { recursive: true });
  const events = createEventHub();
  const loginLimiter = createLoginLimiter();
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  });
  const removeFiles = (files) => {
    for (const file of files) fs.rmSync(path.join(uploadsDir, file), { force: true });
  };

  app.disable("x-powered-by");
  if (config.trustProxy) app.set("trust proxy", 1);
  app.use((req, res, next) => {
    res.set({
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "same-origin",
      "X-Frame-Options": "DENY",
    });
    next();
  });
  app.use(express.json({ limit: "200kb" }));
  app.use(express.static(publicDir));

  // ---- no login needed ----

  app.get("/api/config", (req, res) => {
    res.json({
      users: store.listUsers(),
      currency: config.currency,
      locale: config.locale,
      receiptReader: receiptReader.available,
    });
  });

  app.post("/api/login", (req, res) => {
    if (loginLimiter.isBlocked(req.ip)) {
      throw new HttpError(429, "Demasiados intentos. Espera 15 minutos.");
    }
    const user = store.getUserWithPin(Number(req.body?.userId));
    if (!user || !verifyPin(req.body?.pin ?? "", user.pinHash)) {
      loginLimiter.recordFailure(req.ip);
      throw new HttpError(401, "El PIN no es correcto.");
    }
    loginLimiter.reset(req.ip);
    startSession(store, res, req, user.id);
    res.json({ user: { id: user.id, name: user.name } });
  });

  // Answers 200 either way so the app can check for a session without an error in the console.
  app.get("/api/me", (req, res) => res.json({ user: sessionUser(store, req) }));

  app.post("/api/logout", (req, res) => {
    endSession(store, req, res);
    res.json({ ok: true });
  });

  // ---- everything below needs a login ----

  app.use("/api", (req, res, next) => {
    const user = sessionUser(store, req);
    if (!user) throw new HttpError(401, "Inicia sesión.");
    req.user = user;
    next();
  });

  app.get("/api/events", (req, res) => events.subscribe(req, res));

  // ---- the list ----

  app.get("/api/items", (req, res) => res.json({ items: store.listPendingItems() }));

  app.post("/api/items", (req, res) => {
    const name = text(req.body?.name, { field: "el nombre", max: 80, required: true });
    const quantity = text(req.body?.quantity, { field: "la cantidad", max: 30 }) ?? "";
    const note = text(req.body?.note, { field: "la nota", max: 300 }) ?? "";
    const { item, duplicate } = store.addItem({ name, quantity, note, userId: req.user.id });
    if (!duplicate) events.broadcast({ topic: "items", by: req.user.name, text: `agregó ${item.name}` });
    res.status(duplicate ? 200 : 201).json({ item, duplicate });
  });

  app.patch("/api/items/:id", (req, res) => {
    const id = routeId(req);
    const changes = {
      name: text(req.body?.name, { field: "el nombre", max: 80 }),
      quantity: text(req.body?.quantity, { field: "la cantidad", max: 30 }),
      note: text(req.body?.note, { field: "la nota", max: 300 }),
      inCart: typeof req.body?.inCart === "boolean" ? req.body.inCart : undefined,
    };
    if (changes.name === "") throw new HttpError(400, "Falta el nombre.");
    const item = store.updateItem(id, changes);
    if (!item) throw new HttpError(404, "Esa cosa ya no está en la lista.");
    events.broadcast({ topic: "items", by: req.user.name });
    res.json({ item });
  });

  app.delete("/api/items/:id", (req, res) => {
    const id = routeId(req);
    const item = store.getPendingItem(id);
    if (!item || !store.deletePendingItem(id)) throw new HttpError(404, "Esa cosa ya no está en la lista.");
    events.broadcast({ topic: "items", by: req.user.name, text: `quitó ${item.name}` });
    res.json({ ok: true });
  });

  // ---- receipt photos ----

  app.post("/api/uploads", upload.single("photo"), (req, res) => {
    if (!req.file) throw new HttpError(400, "Falta la foto.");
    const type = sniffImage(req.file.buffer);
    if (!type) throw new HttpError(400, "La foto debe ser JPG, PNG, WEBP o GIF.");
    const id = crypto.randomUUID();
    const file = `${id}.${type.ext}`;
    fs.writeFileSync(path.join(uploadsDir, file), req.file.buffer);
    store.addUpload({ id, file, mime: type.mime, userId: req.user.id });
    res.status(201).json({ id });
  });

  app.get("/api/uploads/:id", (req, res) => {
    const found = store.getUpload(String(req.params.id));
    if (!found) throw new HttpError(404, "No existe.");
    res.set("Cache-Control", "private, max-age=31536000, immutable");
    res.type(found.mime).sendFile(path.join(uploadsDir, found.file));
  });

  app.post("/api/receipts/read", async (req, res) => {
    if (!receiptReader.available) throw new HttpError(409, "La lectura automática de facturas no está activada.");
    const ids = req.body?.uploadIds;
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_PHOTOS_PER_RECEIPT) {
      throw new HttpError(400, `Envía entre 1 y ${MAX_PHOTOS_PER_RECEIPT} fotos.`);
    }
    const images = ids.map((id) => {
      const found = store.getUpload(String(id));
      if (!found) throw new HttpError(400, "Una de las fotos ya no existe. Vuelve a tomarla.");
      return { mime: found.mime, data: fs.readFileSync(path.join(uploadsDir, found.file)) };
    });
    try {
      res.json({ receipt: await receiptReader.read(images, store.listPendingItems()) });
    } catch (error) {
      if (error instanceof ReceiptReadError) {
        console.warn("receipt read failed:", error.cause ?? error.message);
        throw new HttpError(502, error.message);
      }
      throw error;
    }
  });

  // ---- purchases and spending ----

  app.get("/api/purchases", (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    res.json({ purchases: store.listPurchases({ limit, offset }) });
  });

  app.post("/api/purchases", (req, res) => {
    const body = req.body ?? {};
    const receiptLines = {};
    if (body.receiptLines && typeof body.receiptLines === "object") {
      for (const [id, line] of Object.entries(body.receiptLines)) {
        if (typeof line === "string" && line.trim()) receiptLines[Number(id)] = line.trim().slice(0, 200);
      }
    }
    const uploadIds = Array.isArray(body.uploadIds) ? body.uploadIds.map(String).slice(0, MAX_PHOTOS_PER_RECEIPT) : [];
    for (const id of uploadIds) {
      const found = store.getUpload(id);
      if (!found || found.purchaseId) throw new HttpError(400, "Una de las fotos ya no está disponible.");
    }
    const receiptData =
      body.receipt && typeof body.receipt === "object" && JSON.stringify(body.receipt).length < 100_000
        ? body.receipt
        : null;

    const result = store.createPurchase({
      userId: req.user.id,
      store: text(body.store, { field: "el supermercado", max: 80 }) ?? "",
      purchasedOn: isoDate(body.purchasedOn),
      totalCents: cents(body.totalCents),
      currency: config.currency,
      note: text(body.note, { field: "la nota", max: 1000 }) ?? "",
      receiptData,
      reviewedItemIds: idList(body.reviewedItemIds, "La lista revisada"),
      boughtItemIds: idList(body.boughtItemIds, "La lista de comprados"),
      receiptLines,
      uploadIds,
    });
    events.broadcast({ topic: "items", by: req.user.name, text: "registró una compra" });
    events.broadcast({ topic: "purchases", by: req.user.name });
    res.status(201).json(result);
  });

  app.get("/api/purchases/:id", (req, res) => {
    const purchase = store.getPurchase(routeId(req));
    if (!purchase) throw new HttpError(404, "Esa compra no existe.");
    res.json({ purchase });
  });

  app.patch("/api/purchases/:id", (req, res) => {
    const id = routeId(req);
    if (!store.getPurchase(id)) throw new HttpError(404, "Esa compra no existe.");
    const body = req.body ?? {};
    const purchase = store.updatePurchase(id, {
      store: text(body.store, { field: "el supermercado", max: 80 }),
      note: text(body.note, { field: "la nota", max: 1000 }),
      purchasedOn: body.purchasedOn === undefined ? undefined : isoDate(body.purchasedOn),
      totalCents: body.totalCents === undefined ? undefined : cents(body.totalCents),
    });
    events.broadcast({ topic: "purchases", by: req.user.name });
    res.json({ purchase });
  });

  app.delete("/api/purchases/:id", (req, res) => {
    const files = store.deletePurchase(routeId(req));
    if (files === null) throw new HttpError(404, "Esa compra no existe.");
    removeFiles(files);
    events.broadcast({ topic: "purchases", by: req.user.name });
    res.json({ ok: true });
  });

  app.get("/api/summary", (req, res) => {
    res.json({ months: store.monthlyTotals(12), currency: config.currency });
  });

  app.use("/api", () => {
    throw new HttpError(404, "No existe.");
  });

  // eslint-disable-next-line no-unused-vars
  app.use((error, req, res, next) => {
    if (error instanceof multer.MulterError) {
      const message = error.code === "LIMIT_FILE_SIZE" ? "La foto es muy grande (máximo 10 MB)." : "No se pudo subir la foto.";
      return res.status(400).json({ error: message });
    }
    if (error.type === "entity.parse.failed" || error.type === "entity.too.large") {
      return res.status(400).json({ error: "La solicitud no es válida." });
    }
    const status = error.status ?? 500;
    if (status >= 500 && !(error instanceof HttpError)) console.error(error);
    res.status(status).json({ error: error instanceof HttpError ? error.message : "Algo falló en el servidor." });
  });

  // Photos taken for a purchase that was never saved are removed after two days.
  const sweepOrphans = () => {
    const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    removeFiles(store.deleteOrphanUploads(cutoff));
  };

  return { app, events, sweepOrphans };
}
