import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { hashPin } from "../src/auth.js";
import { createStore, openDatabase } from "../src/db.js";
import { ReceiptReadError } from "../src/receipt.js";
import { createApp } from "../src/server.js";

// Smallest valid JPEG header is enough: the server only sniffs the first bytes.
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]);

function setup({ receiptReader } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lista-test-"));
  const db = openDatabase(dataDir);
  const store = createStore(db);
  store.syncUsers(
    [
      { name: "José", pin: "1234" },
      { name: "María", pin: "5678" },
    ],
    hashPin,
  );
  const config = { dataDir, currency: "DOP", locale: "es-DO", trustProxy: false };
  const reader = receiptReader ?? { available: false, read: async () => assert.fail("not configured") };
  const { app, events } = createApp({ config, store, receiptReader: reader });
  return { app, events, db, dataDir, store };
}

async function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
  });
}

// A tiny client that keeps the session cookie between calls.
function client(base) {
  let cookie = "";
  const call = async (method, url, body) => {
    const headers = cookie ? { cookie } : {};
    let payload;
    if (body instanceof FormData) payload = body;
    else if (body !== undefined) {
      headers["content-type"] = "application/json";
      payload = JSON.stringify(body);
    }
    const res = await fetch(base + url, { method, headers, body: payload });
    const setCookie = res.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.split(";")[0];
    const type = res.headers.get("content-type") ?? "";
    return { status: res.status, body: type.includes("json") ? await res.json() : await res.text() };
  };
  return {
    get: (url) => call("GET", url),
    post: (url, body) => call("POST", url, body),
    patch: (url, body) => call("PATCH", url, body),
    del: (url) => call("DELETE", url),
    async login(name, pin) {
      const { body } = await call("GET", "/api/config");
      const user = body.users.find((u) => u.name === name);
      return call("POST", "/api/login", { userId: user.id, pin });
    },
  };
}

describe("API", () => {
  let ctx;
  let server;
  let base;

  const start = async (options) => {
    ctx = setup(options);
    server = await listen(ctx.app);
    base = `http://127.0.0.1:${server.address().port}`;
  };
  const stop = () =>
    new Promise((resolve) => {
      ctx.events.close();
      server.close(() => {
        ctx.db.close();
        fs.rmSync(ctx.dataDir, { recursive: true, force: true });
        resolve();
      });
    });

  describe("login", () => {
    before(() => start());
    after(() => stop());

    it("refuses the list without a session", async () => {
      const c = client(base);
      assert.equal((await c.get("/api/items")).status, 401);
      const me = await c.get("/api/me");
      assert.equal(me.status, 200);
      assert.equal(me.body.user, null);
    });

    it("refuses a wrong PIN and accepts the right one", async () => {
      const c = client(base);
      assert.equal((await c.login("José", "0000")).status, 401);
      const ok = await c.login("José", "1234");
      assert.equal(ok.status, 200);
      assert.equal(ok.body.user.name, "José");
      assert.equal((await c.get("/api/me")).body.user.name, "José");
    });

    it("ends the session on logout", async () => {
      const c = client(base);
      await c.login("María", "5678");
      await c.post("/api/logout");
      assert.equal((await c.get("/api/items")).status, 401);
    });

    it("blocks an IP after repeated wrong PINs", async () => {
      const c = client(base);
      let last;
      for (let i = 0; i < 9; i++) last = await c.login("María", "0000");
      assert.equal(last.status, 429);
      assert.equal((await c.login("María", "5678")).status, 429);
    });
  });

  describe("shopping list", () => {
    let jose;
    let maria;
    before(() => start());
    after(() => stop());
    beforeEach(async () => {
      ctx.db.exec("DELETE FROM purchase_items; DELETE FROM items; DELETE FROM purchases;");
      jose = client(base);
      maria = client(base);
      await jose.login("José", "1234");
      await maria.login("María", "5678");
    });

    it("shares items between both people", async () => {
      const added = await jose.post("/api/items", { name: "Leche", quantity: "2", note: "la entera" });
      assert.equal(added.status, 201);
      const { body } = await maria.get("/api/items");
      assert.equal(body.items.length, 1);
      assert.deepEqual(
        { name: body.items[0].name, quantity: body.items[0].quantity, note: body.items[0].note, addedBy: body.items[0].addedBy },
        { name: "Leche", quantity: "2", note: "la entera", addedBy: "José" },
      );
    });

    it("does not add the same thing twice, ignoring case and accents", async () => {
      await jose.post("/api/items", { name: "Plátanos" });
      const again = await maria.post("/api/items", { name: "  platanos " });
      assert.equal(again.status, 200);
      assert.equal(again.body.duplicate, true);
      assert.equal(again.body.item.addedBy, "José");
      assert.equal((await jose.get("/api/items")).body.items.length, 1);
    });

    it("requires a name", async () => {
      assert.equal((await jose.post("/api/items", { name: "   " })).status, 400);
    });

    it("marks an item as in the cart and edits it", async () => {
      const { body } = await jose.post("/api/items", { name: "Pan" });
      const res = await maria.patch(`/api/items/${body.item.id}`, { inCart: true, quantity: "1 funda" });
      assert.equal(res.body.item.inCart, true);
      assert.equal(res.body.item.quantity, "1 funda");
    });

    it("deletes an item", async () => {
      const { body } = await jose.post("/api/items", { name: "Arroz" });
      assert.equal((await maria.del(`/api/items/${body.item.id}`)).status, 200);
      assert.equal((await jose.get("/api/items")).body.items.length, 0);
      assert.equal((await maria.del(`/api/items/${body.item.id}`)).status, 404);
    });
  });

  describe("purchases", () => {
    let jose;
    before(() => start());
    after(() => stop());
    beforeEach(async () => {
      ctx.db.exec("DELETE FROM purchase_items; DELETE FROM uploads; DELETE FROM items; DELETE FROM purchases;");
      jose = client(base);
      await jose.login("José", "1234");
    });

    const addItems = async (...names) => {
      const ids = [];
      for (const name of names) ids.push((await jose.post("/api/items", { name })).body.item.id);
      return ids;
    };

    it("removes bought items and keeps the missing ones on the list", async () => {
      const [leche, huevos, cafe] = await addItems("Leche", "Huevos", "Café");
      const res = await jose.post("/api/purchases", {
        store: "Supermercado Nacional",
        purchasedOn: "2026-10-18",
        totalCents: 245050,
        note: "No había café del que nos gusta",
        reviewedItemIds: [leche, huevos, cafe],
        boughtItemIds: [leche, huevos],
        receiptLines: { [leche]: "LECHE ENT RICA 1LT" },
      });
      assert.equal(res.status, 201);
      assert.deepEqual(res.body.missing, ["Café"]);

      const list = (await jose.get("/api/items")).body.items;
      assert.deepEqual(list.map((i) => [i.name, i.missedCount]), [["Café", 1]]);

      const detail = (await jose.get(`/api/purchases/${res.body.id}`)).body.purchase;
      assert.equal(detail.totalCents, 245050);
      assert.equal(detail.note, "No había café del que nos gusta");
      assert.equal(detail.createdBy, "José");
      assert.deepEqual(detail.bought.map((i) => i.name).sort(), ["Huevos", "Leche"]);
      assert.equal(detail.bought.find((i) => i.name === "Leche").receiptLine, "LECHE ENT RICA 1LT");
      assert.deepEqual(detail.missing.map((i) => i.name), ["Café"]);
    });

    it("counts how many trips an item has been missing", async () => {
      const [cafe] = await addItems("Café");
      for (const day of ["2026-10-01", "2026-10-08"]) {
        await jose.post("/api/purchases", {
          purchasedOn: day,
          totalCents: 1000,
          reviewedItemIds: [cafe],
          boughtItemIds: [],
        });
      }
      assert.equal((await jose.get("/api/items")).body.items[0].missedCount, 2);
    });

    it("leaves alone items added while the purchase was being reviewed", async () => {
      const [leche] = await addItems("Leche");
      const [late] = await addItems("Galletas");
      await jose.post("/api/purchases", {
        purchasedOn: "2026-10-18",
        totalCents: 5000,
        reviewedItemIds: [leche],
        boughtItemIds: [leche],
      });
      const list = (await jose.get("/api/items")).body.items;
      assert.deepEqual(list.map((i) => [i.id, i.missedCount]), [[late, 0]]);
    });

    it("validates the total and the date", async () => {
      const bad = [
        { purchasedOn: "2026-10-18", totalCents: -5 },
        { purchasedOn: "2026-10-18", totalCents: 12.5 },
        { purchasedOn: "2026-02-30", totalCents: 100 },
        { purchasedOn: "ayer", totalCents: 100 },
      ];
      for (const body of bad) assert.equal((await jose.post("/api/purchases", body)).status, 400, JSON.stringify(body));
    });

    it("adds up spending per month", async () => {
      for (const [purchasedOn, totalCents] of [
        ["2026-09-03", 100000],
        ["2026-10-01", 250000],
        ["2026-10-15", 50050],
      ]) {
        await jose.post("/api/purchases", { purchasedOn, totalCents });
      }
      const { months } = (await jose.get("/api/summary")).body;
      assert.deepEqual(months, [
        { month: "2026-10", totalCents: 300050, purchases: 2 },
        { month: "2026-09", totalCents: 100000, purchases: 1 },
      ]);
    });

    it("edits and deletes a purchase", async () => {
      const { id } = (await jose.post("/api/purchases", { purchasedOn: "2026-10-18", totalCents: 100 })).body;
      const edited = await jose.patch(`/api/purchases/${id}`, { note: "Faltó el pan", totalCents: 200 });
      assert.equal(edited.body.purchase.note, "Faltó el pan");
      assert.equal(edited.body.purchase.totalCents, 200);
      assert.equal((await jose.del(`/api/purchases/${id}`)).status, 200);
      assert.equal((await jose.get(`/api/purchases/${id}`)).status, 404);
    });

    it("stores receipt photos and attaches them to the purchase", async () => {
      const form = new FormData();
      form.append("photo", new Blob([JPEG], { type: "image/jpeg" }), "factura.jpg");
      const uploaded = await jose.post("/api/uploads", form);
      assert.equal(uploaded.status, 201);

      const { id } = (
        await jose.post("/api/purchases", {
          purchasedOn: "2026-10-18",
          totalCents: 100,
          uploadIds: [uploaded.body.id],
        })
      ).body;
      const detail = (await jose.get(`/api/purchases/${id}`)).body.purchase;
      assert.deepEqual(detail.photoIds, [uploaded.body.id]);

      const photo = await fetch(`${base}/api/uploads/${uploaded.body.id}`);
      assert.equal(photo.status, 401, "photos need a login");

      // A photo already attached cannot be reused for another purchase.
      const reuse = await jose.post("/api/purchases", {
        purchasedOn: "2026-10-18",
        totalCents: 100,
        uploadIds: [uploaded.body.id],
      });
      assert.equal(reuse.status, 400);

      await jose.del(`/api/purchases/${id}`);
      assert.equal(fs.readdirSync(path.join(ctx.dataDir, "uploads")).length, 0, "photo file removed");
    });

    it("refuses files that are not images", async () => {
      const form = new FormData();
      form.append("photo", new Blob(["<script>alert(1)</script>"], { type: "image/jpeg" }), "x.jpg");
      assert.equal((await jose.post("/api/uploads", form)).status, 400);
    });

    it("says the receipt reader is off when there is no API key", async () => {
      assert.equal((await jose.get("/api/config")).body.receiptReader, false);
      assert.equal((await jose.post("/api/receipts/read", { uploadIds: ["x"] })).status, 409);
    });
  });

  describe("reading a receipt", () => {
    let jose;
    let seen;
    let outcome;
    before(() =>
      start({
        receiptReader: {
          available: true,
          async read(images, items) {
            seen = { images, items };
            if (outcome instanceof Error) throw outcome;
            return outcome;
          },
        },
      }),
    );
    after(() => stop());

    it("sends the photos and the current list to the reader", async () => {
      jose = client(base);
      await jose.login("José", "1234");
      await jose.post("/api/items", { name: "Leche" });
      const form = new FormData();
      form.append("photo", new Blob([JPEG], { type: "image/jpeg" }), "factura.jpg");
      const { id } = (await jose.post("/api/uploads", form)).body;

      outcome = { isReceipt: true, totalCents: 1234, matches: {} };
      const res = await jose.post("/api/receipts/read", { uploadIds: [id] });
      assert.equal(res.status, 200);
      assert.equal(res.body.receipt.totalCents, 1234);
      assert.equal(seen.images[0].mime, "image/jpeg");
      assert.deepEqual(seen.items.map((i) => i.name), ["Leche"]);
    });

    it("turns a reader failure into a readable message", async () => {
      const form = new FormData();
      form.append("photo", new Blob([JPEG], { type: "image/jpeg" }), "factura.jpg");
      const { id } = (await jose.post("/api/uploads", form)).body;
      outcome = new ReceiptReadError("OpenRouter está ocupado.");
      const res = await jose.post("/api/receipts/read", { uploadIds: [id] });
      assert.equal(res.status, 502);
      assert.equal(res.body.error, "OpenRouter está ocupado.");
    });
  });
});
