import path from "node:path";

// Reads USERS="José:1234,María:5678" into [{ name, pin }].
export function parseUsers(raw) {
  if (!raw || !raw.trim()) return [];
  return raw.split(",").map((entry) => {
    const sep = entry.lastIndexOf(":");
    if (sep <= 0) throw new Error(`USERS: "${entry.trim()}" debe tener la forma Nombre:PIN`);
    const name = entry.slice(0, sep).trim();
    const pin = entry.slice(sep + 1).trim();
    if (!/^\d{4,8}$/.test(pin)) throw new Error(`USERS: el PIN de ${name} debe tener entre 4 y 8 dígitos`);
    return { name, pin };
  });
}

export function loadConfig(env = process.env) {
  const users = parseUsers(env.USERS);
  if (users.length === 0) {
    throw new Error('Falta USERS. Ejemplo: USERS="José:1234,María:5678"');
  }
  return {
    port: Number(env.PORT || 3000),
    host: env.HOST || "0.0.0.0",
    dataDir: path.resolve(env.DATA_DIR || "./data"),
    users,
    currency: env.CURRENCY || "DOP",
    locale: env.LOCALE || "es-DO",
    trustProxy: env.TRUST_PROXY === "1" || env.TRUST_PROXY === "true",
    anthropicApiKey: env.ANTHROPIC_API_KEY || "",
    claudeModel: env.CLAUDE_MODEL || "claude-opus-5-5",
    claudeEffort: env.CLAUDE_EFFORT || "medium",
  };
}
