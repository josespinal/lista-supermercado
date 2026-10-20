import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseUsers } from "../src/config.js";
import { nameKey } from "../src/db.js";
import { createReceiptReader, parseModelJson, ReceiptReadError, sanitizeReceipt } from "../src/receipt.js";

const items = [
  { id: 1, name: "Leche", quantity: "" },
  { id: 2, name: "Café", quantity: "1 lb" },
];

const answer = {
  is_receipt: true,
  store: "Sirena",
  date: "2026-10-19",
  total: 100,
  currency: "DOP",
  lines: [],
  matches: [{ item_id: 1, bought: true, receipt_line: "LECHE" }],
};

// A stand-in for fetch that answers with the given responses, in order, and
// remembers every request.
function fakeFetch(...responses) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return next;
  };
  fn.calls = calls;
  return fn;
}

const completion = (content, finishReason = "stop") =>
  new Response(JSON.stringify({ choices: [{ finish_reason: finishReason, message: { role: "assistant", content } }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const reader = (fetch) => createReceiptReader({ apiKey: "sk-or-test", model: "google/gemini-3.8-flash", fetch, retryDelayMs: 0 });
const photo = [{ mime: "image/jpeg", data: Buffer.from("abc") }];

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
      { is_receipt: false, store: "", date: "18/10/2026", total: -3, currency: "RD$", lines: "nada", matches: null },
      items,
    );
    assert.deepEqual(
      { store: result.store, date: result.date, totalCents: result.totalCents, currency: result.currency },
      { store: null, date: null, totalCents: null, currency: null },
    );
    assert.deepEqual(result.lines, []);
    assert.deepEqual(result.matches, {});
  });
});

describe("parseModelJson", () => {
  it("reads plain JSON and JSON wrapped in a code fence", () => {
    assert.deepEqual(parseModelJson('{"a":1}'), { a: 1 });
    assert.deepEqual(parseModelJson('```json\n{"a":1}\n```'), { a: 1 });
  });

  it("refuses text that is not a JSON object", () => {
    assert.throws(() => parseModelJson("No puedo leer esto."), SyntaxError);
    assert.throws(() => parseModelJson("[1,2]"), SyntaxError);
  });
});

describe("createReceiptReader", () => {
  it("is off without an API key", async () => {
    const off = createReceiptReader({});
    assert.equal(off.available, false);
    await assert.rejects(off.read([], []), ReceiptReadError);
  });

  it("sends the list and the photos to OpenRouter and sanitizes the answer", async () => {
    const fetch = fakeFetch(completion(JSON.stringify(answer)));
    const result = await reader(fetch).read(photo, items);

    const [{ url, init, body }] = fetch.calls;
    assert.equal(url, "https://openrouter.ai/api/v1/chat/completions");
    assert.equal(init.headers.Authorization, "Bearer sk-or-test");
    assert.equal(body.model, "google/gemini-3.8-flash");
    assert.equal(body.response_format.type, "json_schema");
    assert.equal(body.response_format.json_schema.strict, true);
    assert.equal(body.provider.require_parameters, true);
    const [text, image] = body.messages[1].content;
    assert.equal(text.type, "text", "OpenRouter recommends the text before the images");
    assert.match(text.text, /"name":"Café"/);
    assert.equal(image.image_url.url, `data:image/jpeg;base64,${Buffer.from("abc").toString("base64")}`);

    assert.equal(result.totalCents, 10000);
    assert.equal(result.matches[1].bought, true);
  });

  it("tries once more when OpenRouter is busy", async () => {
    const fetch = fakeFetch(new Response("busy", { status: 503 }), completion(JSON.stringify(answer)));
    const result = await reader(fetch).read(photo, items);
    assert.equal(fetch.calls.length, 2);
    assert.equal(result.store, "Sirena");
  });

  it("explains a missing credit balance", async () => {
    const fetch = fakeFetch(new Response('{"error":{"code":402}}', { status: 402 }));
    await assert.rejects(reader(fetch).read(photo, items), (error) => {
      assert.ok(error instanceof ReceiptReadError);
      assert.match(error.message, /crédito/);
      return true;
    });
  });

  it("names the model when OpenRouter cannot serve it", async () => {
    const fetch = fakeFetch(new Response('{"error":{"code":404}}', { status: 404 }));
    await assert.rejects(reader(fetch).read(photo, items), /google\/gemini-3\.8-flash/);
  });

  it("reports a cut-off answer and an answer that is not JSON", async () => {
    await assert.rejects(reader(fakeFetch(completion('{"is_receipt": tr', "length"))).read(photo, items), /muy larga/);
    await assert.rejects(reader(fakeFetch(completion("Lo siento."))).read(photo, items), /No se pudo entender/);
  });

  it("reports a network failure after one retry", async () => {
    const fetch = fakeFetch(new TypeError("fetch failed"), new TypeError("fetch failed"));
    await assert.rejects(reader(fetch).read(photo, items), /No se pudo conectar con OpenRouter/);
    assert.equal(fetch.calls.length, 2);
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
