// Reads receipt photos through OpenRouter (https://openrouter.ai), which gives
// one API for many models. Any model that accepts images and structured
// outputs works; pick it with OPENROUTER_MODEL.

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

const nullable = (type) => ({ type: [type, "null"] });

// Strict JSON schema: every property required, no extra keys.
const RECEIPT_SCHEMA = {
  type: "object",
  properties: {
    is_receipt: { type: "boolean" },
    store: nullable("string"),
    date: nullable("string"),
    total: nullable("number"),
    currency: nullable("string"),
    lines: {
      type: "array",
      items: {
        type: "object",
        properties: {
          description: { type: "string" },
          quantity: nullable("number"),
          amount: nullable("number"),
        },
        required: ["description", "quantity", "amount"],
        additionalProperties: false,
      },
    },
    matches: {
      type: "array",
      items: {
        type: "object",
        properties: {
          item_id: { type: "number" },
          bought: { type: "boolean" },
          receipt_line: nullable("string"),
        },
        required: ["item_id", "bought", "receipt_line"],
        additionalProperties: false,
      },
    },
  },
  required: ["is_receipt", "store", "date", "total", "currency", "lines", "matches"],
  additionalProperties: false,
};

const SYSTEM_PROMPT = `You read photos of supermarket receipts for a household's shared shopping-list app. Several photos are parts of one long receipt, in order. Receipts are usually in Spanish, often from the Dominican Republic, with abbreviated product names such as "LECHE ENT RICA 1LT" or "PLAT VERDE LB".

Extract:
- store: the store name as printed, or null.
- date: the purchase date as YYYY-MM-DD, or null if it is not visible.
- total: the final amount paid, after taxes (ITBIS) and discounts, as a number. Null if it is not visible.
- currency: the ISO 4217 code (DOP for RD$ amounts), or null.
- lines: every product line, with the description as printed, the quantity if shown, and the line amount.

Then compare the receipt with the shopping list the user sends. Return one entry in matches for every list item. Set bought to true only when a receipt line is clearly that product; brand and size may differ, and a generic entry like "leche" matches any milk. Put that line's description in receipt_line. When you are unsure, set bought to false: the item then stays on the list for the next trip, and a person reviews every answer before it is saved.

If the photos do not show a receipt or cannot be read, set is_receipt to false, leave lines and the other fields empty or null, and mark every list item as not bought.

Answer only with the JSON object.`;

export class ReceiptReadError extends Error {}

// Turns the model's answer into something the app can trust: unknown item ids
// are dropped, amounts become integer cents, malformed dates become null.
export function sanitizeReceipt(parsed, items) {
  const listIds = new Set(items.map((i) => i.id));
  const matches = {};
  for (const m of Array.isArray(parsed.matches) ? parsed.matches : []) {
    if (!m || !listIds.has(m.item_id) || matches[m.item_id]) continue;
    const line = typeof m.receipt_line === "string" ? m.receipt_line.trim() : "";
    matches[m.item_id] = { bought: m.bought === true, receiptLine: line || null };
  }
  const toCents = (n) => (typeof n === "number" && Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null);
  const str = (v) => (typeof v === "string" ? v.trim() : "");
  return {
    isReceipt: parsed.is_receipt === true,
    store: str(parsed.store) || null,
    date: /^\d{4}-\d{2}-\d{2}$/.test(str(parsed.date)) ? str(parsed.date) : null,
    totalCents: toCents(parsed.total),
    currency: /^[A-Za-z]{3}$/.test(str(parsed.currency)) ? str(parsed.currency).toUpperCase() : null,
    lines: (Array.isArray(parsed.lines) ? parsed.lines : [])
      .filter((l) => l && str(l.description))
      .slice(0, 300)
      .map((l) => ({
        description: str(l.description),
        quantity: typeof l.quantity === "number" && Number.isFinite(l.quantity) ? l.quantity : null,
        amountCents: toCents(l.amount),
      })),
    matches,
  };
}

// Some models wrap JSON in ```json fences even when asked not to.
export function parseModelJson(content) {
  const text = Array.isArray(content)
    ? content.map((part) => (typeof part === "string" ? part : part?.text ?? "")).join("")
    : String(content ?? "");
  const unfenced = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const parsed = JSON.parse(unfenced);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new SyntaxError("not an object");
  return parsed;
}

function describeStatus(status, model) {
  if (status === 401 || status === 403) return "La clave de OpenRouter no es válida. Revisa OPENROUTER_API_KEY en el servidor.";
  if (status === 402) return "No hay crédito en la cuenta de OpenRouter. Recarga crédito y vuelve a intentar.";
  if (status === 404) {
    return `El modelo «${model}» no está disponible en OpenRouter o no lee fotos con respuesta en JSON. Cambia OPENROUTER_MODEL.`;
  }
  if (status === 413) return "Las fotos son muy grandes. Prueba con menos fotos.";
  if (status === 429) return "OpenRouter está ocupado. Espera un minuto y vuelve a intentar.";
  if (status === 400) return "OpenRouter no aceptó la foto. Prueba con otra foto más clara.";
  return "No se pudo leer la factura. Llena los datos a mano.";
}

const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);

export function createReceiptReader({ apiKey, model, fetch: fetchImpl = globalThis.fetch, retryDelayMs = 2000 } = {}) {
  if (!apiKey) {
    return {
      available: false,
      async read() {
        throw new ReceiptReadError("La lectura automática de facturas no está activada.");
      },
    };
  }

  async function post(body) {
    for (let attempt = 1; ; attempt++) {
      let res;
      try {
        res = await fetchImpl(OPENROUTER_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(180_000),
        });
      } catch (error) {
        if (attempt < 2) {
          await new Promise((r) => setTimeout(r, retryDelayMs));
          continue;
        }
        const message =
          error?.name === "TimeoutError"
            ? "La lectura tardó demasiado. Vuelve a intentar o llena los datos a mano."
            : "No se pudo conectar con OpenRouter. Revisa la conexión del servidor.";
        throw new ReceiptReadError(message, { cause: error });
      }
      if (res.ok) return res.json();
      if (RETRYABLE.has(res.status) && attempt < 2) {
        await new Promise((r) => setTimeout(r, retryDelayMs));
        continue;
      }
      const detail = await res.text().catch(() => "");
      throw new ReceiptReadError(describeStatus(res.status, model), {
        cause: new Error(`OpenRouter ${res.status}: ${detail.slice(0, 500)}`),
      });
    }
  }

  return {
    available: true,
    // images: [{ mime, data: Buffer }], items: [{ id, name, quantity }]
    async read(images, items) {
      const list = items.map(({ id, name, quantity }) => ({ id, name, quantity: quantity || undefined }));
      const data = await post({
        model,
        temperature: 0,
        max_tokens: 8000,
        // Only route to providers that honour the JSON schema.
        provider: { require_parameters: true },
        response_format: {
          type: "json_schema",
          json_schema: { name: "receipt", strict: true, schema: RECEIPT_SCHEMA },
        },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content: [
              { type: "text", text: `Lista de compras:\n${JSON.stringify(list)}` },
              ...images.map((img) => ({
                type: "image_url",
                image_url: { url: `data:${img.mime};base64,${img.data.toString("base64")}` },
              })),
            ],
          },
        ],
      });

      if (data?.error) {
        throw new ReceiptReadError(describeStatus(data.error.code, model), {
          cause: new Error(`OpenRouter error: ${JSON.stringify(data.error).slice(0, 500)}`),
        });
      }
      const choice = data?.choices?.[0];
      if (choice?.finish_reason === "length") {
        throw new ReceiptReadError("La factura es muy larga para leerla de una vez. Llena los datos a mano.");
      }
      let parsed;
      try {
        parsed = parseModelJson(choice?.message?.content);
      } catch (error) {
        throw new ReceiptReadError("No se pudo entender la respuesta del modelo. Vuelve a intentar o llena los datos a mano.", {
          cause: error,
        });
      }
      return sanitizeReceipt(parsed, items);
    },
  };
}
