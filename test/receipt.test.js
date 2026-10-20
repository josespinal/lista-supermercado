import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseUsers } from "../src/config.js";
import { nameKey } from "../src/db.js";
import { createReceiptReader, ReceiptReadError, sanitizeReceipt } from "../src/receipt.js";

const items = [
  { id: 1, name: "Leche", quantity: "" },
  { id: 2, name: "Café", quantity: "1 lb" },
];

describe("sanitizeReceipt", () => {
  it("keeps only list items it knows and converts money to cents", () => {
    const result = sanitizeReceipt(
      {
        is_receipt: true,
        store: " Supermercado Bravo ",
        date: "2026-10-18",
        total: 2450.5,
        currency: "dop",
        lines: [{ description: "LECHE ENT RICA 1LT", quantity: 1, amount: 95.25 }],
        matches: [
          { item_id: 1, bought: true, receipt_line: "LECHE ENT RICA 1LT" },
          { item_id: 2, bought: false, receipt_line: null },
          { item_id: 99, bought: true, receipt_line: "PAN" },
          { item_id: 1, bought: false, receipt_line: null },
        ],
      },
      items,
    );
    assert.equal(result.store, "Supermercado Bravo");
    assert.equal(result.totalCents, 245050);
    assert.equal(result.currency, "DOP");
    assert.equal(result.lines[0].amountCents, 9525);
    assert.deepEqual(result.matches, {
      1: { bought: true, receiptLine: "LECHE ENT RICA 1LT" },
      2: { bought: false, receiptLine: null },
    });
  });

  it("drops values that are not usable", () => {
    const result = sanitizeReceipt(
      { is_receipt: false, store: "", date: "18/10/2026", total: -3, currency: "RD$", lines: [], matches: [] },
      items,
    );
    assert.deepEqual(
      { store: result.store, date: result.date, totalCents: result.totalCents, currency: result.currency },
      { store: null, date: null, totalCents: null, currency: null },
    );
  });
});

describe("createReceiptReader", () => {
  it("is off without an API key", async () => {
    const reader = createReceiptReader({});
    assert.equal(reader.available, false);
    await assert.rejects(reader.read([], []), ReceiptReadError);
  });

  it("asks Claude with the photos and the list, and sanitizes the answer", async () => {
    let request;
    const fake = {
      beta: {
        messages: {
          async parse(params) {
            request = params;
            return {
              stop_reason: "end_turn",
              parsed_output: {
                is_receipt: true,
                store: "Sirena",
                date: "2026-10-19",
                total: 100,
                currency: "DOP",
                lines: [],
                matches: [{ item_id: 1, bought: true, receipt_line: "LECHE" }],
              },
            };
          },
        },
      },
    };
    const reader = createReceiptReader({ client: fake, model: "claude-opus-5-5", effort: "medium" });
    const result = await reader.read([{ mime: "image/jpeg", data: Buffer.from("abc") }], items);

    assert.equal(request.model, "claude-opus-5-5");
    assert.equal(request.output_config.effort, "medium");
    const [image, listText] = request.messages[0].content;
    assert.equal(image.source.data, Buffer.from("abc").toString("base64"));
    assert.match(listText.text, /"name":"Café"/);
    assert.equal(result.totalCents, 10000);
    assert.equal(result.matches[1].bought, true);
  });

  it("reports a refusal as a readable error", async () => {
    const fake = { beta: { messages: { parse: async () => ({ stop_reason: "refusal", parsed_output: null }) } } };
    const reader = createReceiptReader({ client: fake, model: "m", effort: "medium" });
    await assert.rejects(reader.read([], items), ReceiptReadError);
  });
});

describe("helpers", () => {
  it("parses the USERS setting", () => {
    assert.deepEqual(parseUsers("José:1234, María : 5678"), [
      { name: "José", pin: "1234" },
      { name: "María", pin: "5678" },
    ]);
    assert.throws(() => parseUsers("José:12"), /PIN/);
    assert.throws(() => parseUsers("José"), /Nombre:PIN/);
  });

  it("treats names with different case, accents and spaces as the same", () => {
    assert.equal(nameKey("  Plátanos   MADUROS "), nameKey("platanos maduros"));
  });
});
