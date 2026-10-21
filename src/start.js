// Starts the app: npm start, pm2 (ecosystem.config.cjs) and Ploi all run this file.
import { hashPin } from "./auth.js";
import { loadConfig } from "./config.js";
import { createStore, openDatabase } from "./db.js";
import { createReceiptReader } from "./receipt.js";
import { createApp } from "./server.js";

async function main() {
  const config = loadConfig();
  const db = openDatabase(config.dataDir);
  const store = createStore(db);
  store.syncUsers(config.users, hashPin);
  const receiptReader = createReceiptReader({
    apiKey: config.openRouterApiKey,
    model: config.openRouterModel,
  });
  const { app, events, sweepOrphans } = createApp({ config, store, receiptReader });
  sweepOrphans();
  setInterval(sweepOrphans, 6 * 60 * 60 * 1000).unref();

  const server = app.listen(config.port, config.host, () => {
    console.log(`Lista del supermercado en http://localhost:${config.port}`);
    console.log(`Usuarios: ${config.users.map((u) => u.name).join(", ")}`);
    console.log(
      `Lectura de facturas: ${receiptReader.available ? `sí (OpenRouter, ${config.openRouterModel})` : "no (falta OPENROUTER_API_KEY)"}`,
    );
  });
  const shutdown = () => {
    events.close();
    server.close(() => {
      db.close();
      process.exit(0);
    });
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
