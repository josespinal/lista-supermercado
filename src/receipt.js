import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import * as z from "zod/v4";

const ReceiptSchema = z.object({
  is_receipt: z.boolean(),
  store: z.string().nullable(),
  date: z.string().nullable(),
  total: z.number().nullable(),
  currency: z.string().nullable(),
  lines: z.array(
    z.object({
      description: z.string(),
      quantity: z.number().nullable(),
      amount: z.number().nullable(),
    }),
  ),
  matches: z.array(
    z.object({
      item_id: z.number(),
      bought: z.boolean(),
      receipt_line: z.string().nullable(),
    }),
  ),
});

const SYSTEM_PROMPT = `You read photos of supermarket receipts for a household's shared shopping-list app. Several photos are parts of one long receipt, in order. Receipts are usually in Spanish, often from the Dominican Republic, with abbreviated product names such as "LECHE ENT RICA 1LT" or "PLAT VERDE LB".

Extract:
- store: the store name as printed, or null.
- date: the purchase date as YYYY-MM-DD, or null if it is not visible.
- total: the final amount paid, after taxes (ITBIS) and discounts, as a number. Null if it is not visible.
- currency: the ISO 4217 code (DOP for RD$ amounts), or null.
- lines: every product line, with the description as printed, the quantity if shown, and the line amount.

Then compare the receipt with the shopping list the user sends. Return one entry in matches for every list item. Set bought to true only when a receipt line is clearly that product; brand and size may differ, and a generic entry like "leche" matches any milk. Put that line's description in receipt_line. When you are unsure, set bought to false: the item then stays on the list for the next trip, and a person reviews every answer before it is saved.

If the photos do not show a receipt or cannot be read, set is_receipt to false, leave lines and the other fields empty or null, and mark every list item as not bought.`;

export class ReceiptReadError extends Error {}

// Turns the model's answer into something the app can trust: unknown item ids
// are dropped, amounts become integer cents, malformed dates become null.
export function sanitizeReceipt(parsed, items) {
  const listIds = new Set(items.map((i) => i.id));
  const matches = {};
  for (const m of parsed.matches ?? []) {
    if (!listIds.has(m.item_id) || matches[m.item_id]) continue;
    matches[m.item_id] = { bought: m.bought === true, receiptLine: m.receipt_line?.trim() || null };
  }
  const toCents = (n) => (typeof n === "number" && Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null);
  return {
    isReceipt: parsed.is_receipt === true,
    store: parsed.store?.trim() || null,
    date: /^\d{4}-\d{2}-\d{2}$/.test(parsed.date ?? "") ? parsed.date : null,
    totalCents: toCents(parsed.total),
    currency: /^[A-Za-z]{3}$/.test(parsed.currency ?? "") ? parsed.currency.toUpperCase() : null,
    lines: (parsed.lines ?? []).slice(0, 300).map((l) => ({
      description: String(l.description).trim(),
      quantity: typeof l.quantity === "number" && Number.isFinite(l.quantity) ? l.quantity : null,
      amountCents: toCents(l.amount),
    })),
    matches,
  };
}

export function createReceiptReader({ apiKey, model, effort, client } = {}) {
  if (!client && !apiKey) {
    return {
      available: false,
      async read() {
        throw new ReceiptReadError("La lectura automática de facturas no está activada.");
      },
    };
  }
  const anthropic = client ?? new Anthropic({ apiKey, timeout: 180_000, maxRetries: 1 });

  return {
    available: true,
    // images: [{ mime, data: Buffer }], items: [{ id, name, quantity }]
    async read(images, items) {
      const list = items.map(({ id, name, quantity }) => ({ id, name, quantity: quantity || undefined }));
      let response;
      try {
        response = await anthropic.beta.messages.parse({
          model,
          max_tokens: 16000,
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
          output_config: { effort, format: betaZodOutputFormat(ReceiptSchema) },
          system: SYSTEM_PROMPT,
          messages: [
            {
              role: "user",
              content: [
                ...images.map((img) => ({
                  type: "image",
                  source: { type: "base64", media_type: img.mime, data: img.data.toString("base64") },
                })),
                { type: "text", text: `Lista de compras:\n${JSON.stringify(list)}` },
              ],
            },
          ],
        });
      } catch (error) {
        throw new ReceiptReadError(describeApiError(error), { cause: error });
      }

      if (response.stop_reason === "refusal") {
        throw new ReceiptReadError("No se pudo leer esta factura. Llena los datos a mano.");
      }
      if (response.stop_reason === "max_tokens" || !response.parsed_output) {
        throw new ReceiptReadError("La factura es muy larga para leerla de una vez. Llena los datos a mano.");
      }
      return sanitizeReceipt(response.parsed_output, items);
    },
  };
}

function describeApiError(error) {
  if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) {
    return "La clave de Claude no es válida. Revisa ANTHROPIC_API_KEY en el servidor.";
  }
  if (error instanceof Anthropic.RateLimitError) {
    return "Claude está ocupado. Espera un minuto y vuelve a intentar.";
  }
  if (error instanceof Anthropic.BadRequestError) {
    return "Claude no aceptó la foto. Prueba con otra foto más clara.";
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return "No se pudo conectar con Claude. Revisa la conexión del servidor.";
  }
  return "No se pudo leer la factura. Llena los datos a mano.";
}
