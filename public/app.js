// Lista del súper — the whole client. No build step: plain ES modules.

const root = document.getElementById("app");
const state = { config: null, me: null, items: [], view: null, events: null };
let checkout = null; // the purchase being registered; survives switching tabs

// ---------------------------------------------------------------- helpers

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else if (key === "class") node.className = value;
    else if (key === "dataset") Object.assign(node.dataset, value);
    else if (key in node && typeof value !== "string") node[key] = value;
    else node.setAttribute(key, value === true ? "" : value);
  }
  appendChildren(node, children);
  return node;
}

// Children may be nested arrays, and false/null/undefined are skipped, so
// views can write `cond && el(...)` and `cond && [a, b]`.
function appendChildren(node, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false || child === "") continue;
    node.append(child instanceof Node ? child : String(child));
  }
}

function fill(node, ...children) {
  node.replaceChildren();
  appendChildren(node, children);
}

function svg(path) {
  const ns = "http://www.w3.org/2000/svg";
  const node = document.createElementNS(ns, "svg");
  node.setAttribute("viewBox", "0 0 24 24");
  node.setAttribute("fill", "none");
  node.setAttribute("stroke", "currentColor");
  node.setAttribute("stroke-width", "2");
  node.setAttribute("stroke-linecap", "round");
  node.setAttribute("stroke-linejoin", "round");
  node.setAttribute("aria-hidden", "true");
  node.innerHTML = path;
  return node;
}

const ICONS = {
  list: '<path d="M9 6h11M9 12h11M9 18h11"/><path d="m3.5 6 1 1 2-2M3.5 12l1 1 2-2M3.5 18l1 1 2-2"/>',
  receipt: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6M9 12h6M9 16h3"/>',
  chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
};

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function api(method, url, body) {
  const options = { method, headers: {} };
  if (body instanceof FormData) options.body = body;
  else if (body !== undefined) {
    options.headers["content-type"] = "application/json";
    options.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(url, options);
  } catch {
    throw new ApiError(0, "No hay conexión. Revisa el internet e intenta otra vez.");
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && url !== "/api/login" && state.me) {
    state.me = null;
    showLogin();
  }
  if (!res.ok) throw new ApiError(res.status, data.error || "Algo falló. Intenta otra vez.");
  return data;
}

function storage(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(key);
    localStorage.setItem(key, value);
  } catch {
    return null;
  }
  return null;
}

const money = (cents) =>
  new Intl.NumberFormat(state.config.locale, { style: "currency", currency: state.config.currency }).format(
    (cents ?? 0) / 100,
  );

// Accepts "2450", "2,450.50", "2450,50" or "RD$ 2,450.50". Returns cents or null.
function parseMoney(input) {
  let s = String(input).replace(/[^\d.,]/g, "");
  if (!s) return null;
  const lastDot = s.lastIndexOf(".");
  const lastComma = s.lastIndexOf(",");
  let decimalSep = null;
  if (lastDot !== -1 && lastComma !== -1) decimalSep = lastDot > lastComma ? "." : ",";
  else if (lastComma !== -1 && /,\d{1,2}$/.test(s)) decimalSep = ",";
  else if (lastDot !== -1 && /\.\d{1,2}$/.test(s)) decimalSep = ".";
  if (decimalSep) {
    const [whole, fraction] = [s.slice(0, s.lastIndexOf(decimalSep)), s.slice(s.lastIndexOf(decimalSep) + 1)];
    s = `${whole.replace(/[.,]/g, "")}.${fraction}`;
  } else {
    s = s.replace(/[.,]/g, "");
  }
  const value = Number(s);
  return Number.isFinite(value) ? Math.round(value * 100) : null;
}

const centsToInput = (cents) => (cents === null || cents === undefined ? "" : (cents / 100).toFixed(2));

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const formatDate = (iso, options = { day: "numeric", month: "short", year: "numeric" }) =>
  new Intl.DateTimeFormat(state.config.locale, { ...options, timeZone: "UTC" }).format(new Date(`${iso}T00:00:00Z`));

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

let toastTimer;
function toast(message) {
  const node = document.getElementById("toast");
  node.textContent = message;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    node.hidden = true;
  }, 3500);
}

function fail(error) {
  toast(error instanceof ApiError ? error.message : "Algo falló. Intenta otra vez.");
}

// Phone photos are 3–12 MB. Shrinking them keeps uploads fast on mobile data
// and still leaves the receipt text sharp enough to read.
async function shrinkPhoto(file, maxSide = 2000) {
  let bitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    return file;
  }
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
  return blob ?? file;
}

// ---------------------------------------------------------------- login

function showLogin() {
  closeEvents();
  const users = state.config.users;
  let chosen = users.find((u) => String(u.id) === storage("lista:lastUser")) ?? (users.length === 1 ? users[0] : null);
  const error = el("p", { class: "notice error", hidden: true });
  const pin = el("input", {
    id: "pin",
    class: "pin",
    type: "password",
    inputmode: "numeric",
    autocomplete: "current-password",
    maxlength: "8",
    required: true,
  });
  const people = el(
    "div",
    { class: "people", role: "group", "aria-label": "¿Quién eres?" },
    users.map((u) =>
      el(
        "button",
        {
          type: "button",
          "aria-pressed": String(chosen?.id === u.id),
          onclick: (e) => {
            chosen = u;
            for (const b of people.children) b.setAttribute("aria-pressed", String(b === e.currentTarget));
            pin.focus();
          },
        },
        u.name,
      ),
    ),
  );
  const submit = el("button", { class: "btn primary block", type: "submit" }, "Entrar");
  const form = el(
    "form",
    {
      onsubmit: async (e) => {
        e.preventDefault();
        error.hidden = true;
        if (!chosen) {
          error.textContent = "Elige tu nombre.";
          error.hidden = false;
          return;
        }
        submit.disabled = true;
        try {
          const { user } = await api("POST", "/api/login", { userId: chosen.id, pin: pin.value });
          storage("lista:lastUser", String(user.id));
          state.me = user;
          startApp();
        } catch (err) {
          error.textContent = err.message;
          error.hidden = false;
          pin.value = "";
          pin.focus();
        } finally {
          submit.disabled = false;
        }
      },
    },
    el("h2", {}, "¿Quién eres?"),
    people,
    el("label", { class: "field", for: "pin" }, el("span", {}, "Tu PIN"), pin),
    error,
    submit,
  );
  fill(root,
    el(
      "div",
      { class: "login" },
      el("img", { class: "logo", src: "/icon.svg", alt: "" }),
      el("h1", {}, "Lista del súper"),
      el("p", { class: "hint" }, "La lista que compartimos para que no se nos quede nada."),
      form,
    ),
  );
  if (chosen) pin.focus();
}

// ---------------------------------------------------------------- shell and routing

const TABS = [
  { href: "#/lista", label: "Lista", icon: "list" },
  { href: "#/compra", label: "Terminar compra", icon: "receipt" },
  { href: "#/gastos", label: "Gastos", icon: "chart" },
];

function startApp() {
  fill(root,
    el(
      "div",
      { class: "shell" },
      el(
        "header",
        { class: "topbar" },
        el("span", { class: "brand" }, "Lista del súper"),
        el(
          "span",
          { class: "who" },
          state.me.name,
          el(
            "button",
            {
              class: "btn small",
              type: "button",
              onclick: async () => {
                await api("POST", "/api/logout").catch(() => {});
                state.me = null;
                showLogin();
              },
            },
            "Salir",
          ),
        ),
      ),
      el("main", { id: "main" }),
      el(
        "nav",
        { class: "tabbar", "aria-label": "Secciones" },
        TABS.map((t) => el("a", { href: t.href }, svg(ICONS[t.icon]), t.label)),
      ),
    ),
  );
  openEvents();
  route();
}

function route() {
  if (!state.me) return;
  const main = document.getElementById("main");
  if (!main) return;
  const hash = location.hash || "#/lista";
  for (const a of document.querySelectorAll(".tabbar a")) {
    const active = hash === a.getAttribute("href") || (a.getAttribute("href") === "#/gastos" && hash.startsWith("#/gastos"));
    if (active) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
  window.scrollTo(0, 0);
  const purchase = hash.match(/^#\/gastos\/(\d+)$/);
  if (purchase) return showPurchase(main, Number(purchase[1]));
  if (hash === "#/compra") return showCheckout(main);
  if (hash === "#/gastos") return showSpending(main);
  return showList(main);
}

window.addEventListener("hashchange", route);

// Live updates: the server sends a nudge when someone changes something.
function openEvents() {
  closeEvents();
  state.events = new EventSource("/api/events");
  state.events.onmessage = (message) => {
    let event;
    try {
      event = JSON.parse(message.data);
    } catch {
      return;
    }
    if (event.by && event.by !== state.me?.name && event.text) toast(`${event.by} ${event.text}`);
    state.view?.onEvent?.(event);
  };
}

function closeEvents() {
  state.events?.close();
  state.events = null;
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && state.me) state.view?.onEvent?.({ topic: "items" });
});

async function loadItems() {
  state.items = (await api("GET", "/api/items")).items;
  return state.items;
}

// ---------------------------------------------------------------- the list

function showList(main) {
  const name = el("input", {
    id: "new-item",
    placeholder: "¿Qué hace falta?",
    autocomplete: "off",
    enterkeyhint: "done",
    maxlength: "80",
  });
  const quantity = el("input", { placeholder: "Cantidad", "aria-label": "Cantidad", maxlength: "30" });
  const note = el("input", { placeholder: "Nota (marca, tamaño…)", "aria-label": "Nota", maxlength: "300" });
  const details = el("div", { class: "add-details", hidden: true }, quantity, note);
  const addButton = el("button", { class: "btn primary", type: "submit" }, "Agregar");
  const form = el(
    "form",
    {
      class: "add-form",
      onsubmit: async (e) => {
        e.preventDefault();
        if (!name.value.trim()) return name.focus();
        addButton.disabled = true;
        try {
          const { item, duplicate } = await api("POST", "/api/items", {
            name: name.value,
            quantity: quantity.value,
            note: note.value,
          });
          if (duplicate) toast(`${item.name} ya estaba en la lista (lo agregó ${item.addedBy}).`);
          name.value = quantity.value = note.value = "";
          await loadItems();
          draw();
        } catch (err) {
          fail(err);
        } finally {
          addButton.disabled = false;
          name.focus();
        }
      },
    },
    el("label", { class: "sr-only", for: "new-item" }, "¿Qué hace falta?"),
    el("div", { class: "row" }, el("div", { class: "grow" }, name), addButton),
    el(
      "button",
      {
        type: "button",
        class: "link",
        onclick: (e) => {
          details.hidden = !details.hidden;
          e.currentTarget.textContent = details.hidden ? "Agregar cantidad o nota" : "Ocultar cantidad y nota";
          if (!details.hidden) quantity.focus();
        },
      },
      "Agregar cantidad o nota",
    ),
    details,
  );
  const listArea = el("div", {}, el("p", { class: "loading" }, "Cargando la lista…"));
  fill(main, el("h1", {}, "Lo que hace falta"), form, listArea);

  function itemRow(item) {
    const checkbox = el("input", {
      type: "checkbox",
      checked: item.inCart,
      "aria-label": `${item.name}: ya está en el carrito`,
      onchange: async () => {
        item.inCart = checkbox.checked;
        draw();
        try {
          await api("PATCH", `/api/items/${item.id}`, { inCart: item.inCart });
        } catch (err) {
          fail(err);
          await loadItems().catch(() => {});
          draw();
        }
      },
    });
    const meta = [`Agregó ${item.addedBy ?? "alguien"}`];
    return el(
      "li",
      { class: `item${item.inCart ? " in-cart" : ""}` },
      el("label", { class: "check" }, checkbox),
      el(
        "button",
        { class: "item-body", type: "button", onclick: () => editItem(item, draw) },
        el("span", { class: "item-name" }, item.name, item.quantity && el("span", { class: "qty" }, item.quantity)),
        item.note && el("span", { class: "item-note" }, item.note),
        el(
          "span",
          { class: "item-meta" },
          meta.join(" · "),
          item.missedCount > 0 && " · ",
          item.missedCount > 0 &&
            el(
              "span",
              { class: "badge" },
              item.missedCount === 1 ? "Faltó la vez pasada" : `Faltó ${item.missedCount} veces`,
            ),
        ),
      ),
    );
  }

  function draw() {
    if (!main.isConnected) return;
    const toBuy = state.items.filter((i) => !i.inCart);
    const inCart = state.items.filter((i) => i.inCart);
    if (state.items.length === 0) {
      fill(listArea,
        el("p", { class: "empty" }, "La lista está vacía. Agrega lo que vaya haciendo falta y aparecerá aquí para los dos."),
      );
      return;
    }
    fill(listArea,
      el(
        "p",
        { class: "counts" },
        `${plural(toBuy.length, "cosa por comprar", "cosas por comprar")}`,
        inCart.length > 0 && ` · ${inCart.length} en el carrito`,
      ),
      el("p", { class: "hint" }, "En el súper, marca cada cosa cuando la eches al carrito."),
      el("ul", { class: "items" }, toBuy.map(itemRow)),
      inCart.length > 0 && el("p", { class: "section-label" }, "En el carrito"),
      inCart.length > 0 && el("ul", { class: "items" }, inCart.map(itemRow)),
      inCart.length > 0 &&
        el("p", { class: "actions" }, el("a", { class: "btn primary block", href: "#/compra" }, "Terminar compra")),
    );
  }

  state.view = {
    onEvent: (event) => {
      if (event.topic === "items") loadItems().then(draw).catch(() => {});
    },
  };
  loadItems().then(draw).catch(fail);
}

function editItem(item, onDone) {
  const name = el("input", { value: item.name, maxlength: "80", required: true });
  const quantity = el("input", { value: item.quantity, maxlength: "30" });
  const note = el("textarea", { maxlength: "300" }, item.note);
  const dialog = el(
    "dialog",
    { onclose: () => dialog.remove() },
    el(
      "form",
      {
        method: "dialog",
        onsubmit: async (e) => {
          e.preventDefault();
          try {
            await api("PATCH", `/api/items/${item.id}`, {
              name: name.value,
              quantity: quantity.value,
              note: note.value,
            });
            dialog.close();
            await loadItems();
            onDone();
          } catch (err) {
            fail(err);
          }
        },
      },
      el("h2", {}, "Editar"),
      el("label", { class: "field" }, el("span", {}, "Qué"), name),
      el("label", { class: "field" }, el("span", {}, "Cantidad"), quantity),
      el("label", { class: "field" }, el("span", {}, "Nota"), note),
      el(
        "div",
        { class: "actions" },
        el(
          "button",
          {
            type: "button",
            class: "btn danger",
            onclick: async () => {
              try {
                await api("DELETE", `/api/items/${item.id}`);
                dialog.close();
                await loadItems();
                onDone();
              } catch (err) {
                fail(err);
              }
            },
          },
          "Quitar de la lista",
        ),
        el(
          "span",
          { class: "row" },
          el("button", { type: "button", class: "btn", onclick: () => dialog.close() }, "Cancelar"),
          el("button", { type: "submit", class: "btn primary" }, "Guardar"),
        ),
      ),
    ),
  );
  document.body.append(dialog);
  dialog.showModal();
}

// ---------------------------------------------------------------- finishing a purchase

function newCheckout() {
  return {
    photos: [], // { key, id?, url, status: "uploading" | "ready" | "error" }
    receipt: null,
    readError: "",
    reading: false,
    store: "",
    date: today(),
    total: "",
    note: "",
    bought: new Set(),
    touched: new Set(), // items whose box the person changed by hand
    reviewedIds: [],
  };
}

function showCheckout(main) {
  if (!checkout) checkout = newCheckout();
  const c = checkout;
  const MAX_PHOTOS = 5;
  state.view = { onEvent: () => {} };

  const fileInput = el("input", {
    type: "file",
    accept: "image/*",
    multiple: true,
    hidden: true,
    onchange: async () => {
      const files = [...fileInput.files].slice(0, MAX_PHOTOS - c.photos.length);
      fileInput.value = "";
      await Promise.all(files.map(addPhoto));
    },
  });
  const photosArea = el("div");
  const readArea = el("div");
  const reviewArea = el("div", {}, el("p", { class: "loading" }, "Cargando la lista…"));
  let listLoaded = false;

  async function addPhoto(file) {
    const photo = { key: crypto.randomUUID(), url: URL.createObjectURL(file), status: "uploading" };
    c.photos.push(photo);
    drawPhotos();
    try {
      const form = new FormData();
      form.append("photo", await shrinkPhoto(file), "factura.jpg");
      photo.id = (await api("POST", "/api/uploads", form)).id;
      photo.status = "ready";
    } catch (err) {
      photo.status = "error";
      fail(err);
    }
    drawPhotos();
  }

  function drawPhotos() {
    if (!main.isConnected) return;
    fill(photosArea,
      c.photos.length > 0 &&
        el(
          "div",
          { class: "photos" },
          c.photos.map((p) =>
            el(
              "div",
              { class: "photo" },
              el("img", { src: p.url, alt: "Foto de la factura" }),
              el(
                "button",
                {
                  class: "remove",
                  type: "button",
                  "aria-label": "Quitar esta foto",
                  onclick: () => {
                    URL.revokeObjectURL(p.url);
                    c.photos = c.photos.filter((x) => x !== p);
                    drawPhotos();
                  },
                },
                "×",
              ),
              p.status !== "ready" &&
                el("span", { class: "status" }, p.status === "uploading" ? "Subiendo…" : "No se subió"),
            ),
          ),
        ),
      c.photos.length < MAX_PHOTOS &&
        el(
          "button",
          { class: "btn block", type: "button", onclick: () => fileInput.click() },
          c.photos.length === 0 ? "Tomar o elegir foto de la factura" : "Agregar otra foto",
        ),
    );
    drawRead();
  }

  function drawRead() {
    if (!main.isConnected) return;
    const ready = c.photos.filter((p) => p.status === "ready");
    const uploading = c.photos.some((p) => p.status === "uploading");
    if (!state.config.receiptReader) {
      fill(readArea,
        c.photos.length > 0 && el("p", { class: "hint" }, "La foto se guarda con la compra. Llena el total abajo."),
      );
      return;
    }
    fill(readArea,
      ready.length > 0 &&
        el(
          "button",
          {
            class: "btn primary block",
            type: "button",
            disabled: c.reading || uploading,
            onclick: readReceipt,
          },
          c.reading && el("span", { class: "spinner", "aria-hidden": "true" }),
          c.reading ? "Leyendo la factura…" : c.receipt ? "Leer la factura otra vez" : "Leer la factura",
        ),
      c.reading && el("p", { class: "hint" }, "Puede tardar hasta un minuto."),
      c.readError && el("p", { class: "notice error" }, c.readError),
      c.receipt && receiptSummary(),
    );
  }

  function receiptSummary() {
    if (!c.receipt.isReceipt) {
      return el("p", { class: "notice warn" }, "No parece una factura, o no se lee bien. Revisa la foto o llena los datos a mano.");
    }
    const found = c.reviewedIds.filter((id) => c.receipt.matches[id]?.bought).length;
    return el(
      "p",
      { class: "notice" },
      `Leí la factura. Encontré ${found} de ${c.reviewedIds.length} cosas de la lista. Revisa los datos antes de guardar.`,
    );
  }

  async function readReceipt() {
    c.reading = true;
    c.readError = "";
    drawRead();
    try {
      const { receipt } = await api("POST", "/api/receipts/read", {
        uploadIds: c.photos.filter((p) => p.status === "ready").map((p) => p.id),
      });
      c.receipt = receipt;
      if (receipt.isReceipt) {
        if (receipt.store) c.store = receipt.store;
        if (receipt.date) c.date = receipt.date;
        if (receipt.totalCents !== null) c.total = centsToInput(receipt.totalCents);
        c.touched.clear();
        c.bought = new Set(c.reviewedIds.filter((id) => receipt.matches[id]?.bought));
      }
    } catch (err) {
      c.readError = err.message;
    } finally {
      c.reading = false;
    }
    if (main.isConnected) {
      drawRead();
      drawForm();
    }
  }

  // ---- the form: store, date, total, note and what was bought

  const storeInput = el("input", { maxlength: "80", autocomplete: "off", list: "stores" });
  const dateInput = el("input", { type: "date", required: true });
  const totalInput = el("input", { inputmode: "decimal", autocomplete: "off", placeholder: "0.00", required: true });
  const noteInput = el("textarea", { maxlength: "1000", placeholder: "Ej.: No había del café de siempre." });
  const storesList = el("datalist", { id: "stores" });
  for (const [input, key] of [
    [storeInput, "store"],
    [dateInput, "date"],
    [totalInput, "total"],
    [noteInput, "note"],
  ]) {
    input.addEventListener("input", () => {
      c[key] = input.value;
    });
  }

  function drawForm() {
    storeInput.value = c.store;
    dateInput.value = c.date;
    totalInput.value = c.total;
    noteInput.value = c.note;
    drawReview();
  }

  function drawReview() {
    if (!main.isConnected || !listLoaded) return;
    const items = state.items.filter((i) => c.reviewedIds.includes(i.id));
    if (items.length === 0) {
      fill(reviewArea, el("p", { class: "hint" }, "No hay nada en la lista. Puedes guardar la compra igual."));
      return;
    }
    const missingCount = items.filter((i) => !c.bought.has(i.id)).length;
    fill(reviewArea,
      el(
        "div",
        { class: "row", style: "justify-content: space-between; flex-wrap: wrap" },
        el("p", { class: "hint", style: "margin: 0" }, "Marca lo que compraste. Lo que no marques se queda en la lista."),
        el(
          "span",
          { class: "row" },
          el("button", { type: "button", class: "link", onclick: () => setAll(items, true) }, "Todo"),
          el("button", { type: "button", class: "link", onclick: () => setAll(items, false) }, "Nada"),
        ),
      ),
      el(
        "ul",
        { class: "review", style: "margin-top: 8px" },
        items.map((item) => {
          const match = c.receipt?.isReceipt ? c.receipt.matches[item.id] : null;
          const box = el("input", {
            type: "checkbox",
            checked: c.bought.has(item.id),
            onchange: () => {
              if (box.checked) c.bought.add(item.id);
              else c.bought.delete(item.id);
              c.touched.add(item.id);
              drawReview();
            },
          });
          let detail = null;
          if (match?.bought) {
            detail = el("span", { class: "found" }, match.receiptLine ? `En la factura: ${match.receiptLine}` : "Aparece en la factura.");
          } else if (c.receipt?.isReceipt && item.inCart && !c.touched.has(item.id)) {
            detail = el("span", { class: "doubt" }, "Estaba en el carrito, pero no la encontré en la factura.");
          } else if (c.receipt?.isReceipt && !c.bought.has(item.id)) {
            detail = el("span", { class: "found" }, "No aparece en la factura.");
          }
          return el(
            "li",
            {},
            el(
              "label",
              {},
              box,
              el(
                "span",
                {},
                el("strong", {}, item.name),
                item.quantity && el("span", { class: "qty" }, item.quantity),
                detail,
              ),
            ),
          );
        }),
      ),
      el(
        "p",
        { class: missingCount > 0 ? "notice warn" : "notice" },
        missingCount > 0
          ? `${plural(missingCount, "cosa se queda", "cosas se quedan")} en la lista para la próxima vez.`
          : "Compraste todo lo de la lista.",
      ),
    );
  }

  function setAll(items, value) {
    for (const item of items) {
      if (value) c.bought.add(item.id);
      else c.bought.delete(item.id);
      c.touched.add(item.id);
    }
    drawReview();
  }

  const saveButton = el("button", { class: "btn primary block", type: "submit" }, "Guardar compra");
  const formError = el("p", { class: "notice error", hidden: true });
  const form = el(
    "form",
    {
      onsubmit: async (e) => {
        e.preventDefault();
        formError.hidden = true;
        const totalCents = parseMoney(c.total);
        const problem =
          c.photos.some((p) => p.status === "uploading")
            ? "Espera a que terminen de subir las fotos."
            : totalCents === null
              ? "Escribe el total de la factura."
              : !c.date
                ? "Escribe la fecha de la compra."
                : null;
        if (problem) {
          formError.textContent = problem;
          formError.hidden = false;
          return;
        }
        saveButton.disabled = true;
        try {
          const boughtItemIds = c.reviewedIds.filter((id) => c.bought.has(id));
          const receiptLines = {};
          for (const id of boughtItemIds) {
            const line = c.receipt?.matches?.[id]?.receiptLine;
            if (line) receiptLines[id] = line;
          }
          const result = await api("POST", "/api/purchases", {
            store: c.store,
            purchasedOn: c.date,
            totalCents,
            note: c.note,
            reviewedItemIds: c.reviewedIds,
            boughtItemIds,
            receiptLines,
            uploadIds: c.photos.filter((p) => p.status === "ready").map((p) => p.id),
            receipt: c.receipt?.isReceipt
              ? { store: c.receipt.store, date: c.receipt.date, totalCents: c.receipt.totalCents, lines: c.receipt.lines }
              : null,
          });
          for (const p of c.photos) URL.revokeObjectURL(p.url);
          checkout = null;
          showSaved(main, result, totalCents);
        } catch (err) {
          formError.textContent = err.message;
          formError.hidden = false;
        } finally {
          saveButton.disabled = false;
        }
      },
    },
    el(
      "section",
      { class: "card step" },
      el("h2", {}, "1. Foto de la factura"),
      el("p", { class: "hint" }, "Si la factura es larga, toma varias fotos de arriba hacia abajo. La foto es opcional."),
      fileInput,
      photosArea,
      readArea,
    ),
    el(
      "section",
      { class: "card step" },
      el("h2", {}, "2. Datos de la compra"),
      el("label", { class: "field" }, el("span", {}, "Supermercado"), storeInput, storesList),
      el(
        "div",
        { class: "grid-2" },
        el("label", { class: "field" }, el("span", {}, "Fecha"), dateInput),
        el("label", { class: "field" }, el("span", {}, `Total (${state.config.currency})`), totalInput),
      ),
      el("label", { class: "field" }, el("span", {}, "Nota"), noteInput),
    ),
    el("section", { class: "card step" }, el("h2", {}, "3. ¿Qué compraste?"), reviewArea),
    formError,
    saveButton,
  );

  fill(main,
    el("h1", {}, "Terminar compra"),
    el("p", { class: "hint" }, "Registra lo que gastaste y revisa qué faltó. Lo que faltó se queda en la lista."),
    form,
  );
  drawPhotos();
  drawForm();

  // Settle every item on the list as it is now; items added later are not touched.
  loadItems()
    .then((items) => {
      const known = new Set(c.reviewedIds);
      for (const item of items) {
        if (!known.has(item.id) && item.inCart) c.bought.add(item.id);
      }
      c.reviewedIds = items.map((i) => i.id);
      listLoaded = true;
      drawReview();
    })
    .catch(fail);
  api("GET", "/api/purchases?limit=50")
    .then(({ purchases }) => {
      const names = [...new Set(purchases.map((p) => p.store).filter(Boolean))];
      fill(storesList, ...names.map((n) => el("option", { value: n })));
    })
    .catch(() => {});
}

function showSaved(main, result, totalCents) {
  state.view = { onEvent: () => {} };
  fill(main,
    el("h1", {}, "Compra guardada"),
    el(
      "div",
      { class: "card" },
      el("p", { style: "margin-top: 0" }, `Gastaste ${money(totalCents)}.`),
      result.missing.length > 0
        ? [
            el("p", {}, "Esto faltó y se quedó en la lista para la próxima vez:"),
            el("ul", { class: "simple-list" }, result.missing.map((name) => el("li", {}, name))),
          ]
        : el("p", {}, "No faltó nada de la lista."),
    ),
    el(
      "div",
      { class: "actions" },
      el("a", { class: "btn primary", href: "#/lista" }, "Ver la lista"),
      el("a", { class: "btn", href: `#/gastos/${result.id}` }, "Ver la compra"),
    ),
  );
  window.scrollTo(0, 0);
}

// ---------------------------------------------------------------- spending

function lastMonths(count) {
  const now = new Date();
  const months = [];
  for (let i = 0; i < count; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  }
  return months;
}

function showSpending(main) {
  const content = el("div", {}, el("p", { class: "loading" }, "Cargando los gastos…"));
  fill(main, el("h1", {}, "Gastos del súper"), content);

  async function load() {
    const [{ months }, { purchases }] = await Promise.all([api("GET", "/api/summary"), api("GET", "/api/purchases")]);
    if (!main.isConnected) return;
    const byMonth = new Map(months.map((m) => [m.month, m]));
    const recent = lastMonths(6);
    const [thisMonth, lastMonth] = recent.map((m) => byMonth.get(m) ?? { totalCents: 0, purchases: 0 });
    const max = Math.max(1, ...recent.map((m) => byMonth.get(m)?.totalCents ?? 0));
    const monthName = (m, opts) => formatDate(`${m}-01`, opts);

    fill(content,
      el(
        "div",
        { class: "hero" },
        el(
          "div",
          { class: "card" },
          el("div", { class: "label" }, "Este mes"),
          el("div", { class: "value" }, money(thisMonth.totalCents)),
          el("div", { class: "sub" }, plural(thisMonth.purchases, "compra", "compras")),
        ),
        el(
          "div",
          { class: "card" },
          el("div", { class: "label" }, "Mes pasado"),
          el("div", { class: "value" }, money(lastMonth.totalCents)),
          el("div", { class: "sub" }, plural(lastMonth.purchases, "compra", "compras")),
        ),
      ),
      el("h2", {}, "Últimos 6 meses"),
      el(
        "div",
        { class: "card" },
        el(
          "ul",
          { class: "bars", "aria-label": "Gasto por mes" },
          recent.map((m) => {
            const entry = byMonth.get(m) ?? { totalCents: 0, purchases: 0 };
            const label = `${monthName(m, { month: "long", year: "numeric" })}: ${money(entry.totalCents)}, ${plural(entry.purchases, "compra", "compras")}`;
            return el(
              "li",
              { class: entry.totalCents === 0 ? "zero" : "", title: label, "aria-label": label },
              el("span", { class: "month", "aria-hidden": "true" }, monthName(m, { month: "short", year: "2-digit" })),
              el(
                "span",
                { class: "track", "aria-hidden": "true" },
                entry.totalCents > 0 && el("span", { class: "bar", style: `display: block; width: ${(entry.totalCents / max) * 100}%` }),
              ),
              el("span", { class: "amount", "aria-hidden": "true" }, money(entry.totalCents)),
            );
          }),
        ),
      ),
      el("h2", {}, "Compras"),
      purchases.length === 0
        ? el("p", { class: "empty" }, "Todavía no hay compras. Cuando termines de comprar, ve a «Terminar compra».")
        : el(
            "ul",
            { class: "purchases" },
            purchases.map((p) =>
              el(
                "li",
                {},
                el(
                  "a",
                  { href: `#/gastos/${p.id}` },
                  el(
                    "div",
                    {},
                    el("div", { class: "title" }, p.store || "Supermercado"),
                    el(
                      "div",
                      { class: "meta" },
                      [
                        formatDate(p.purchasedOn),
                        p.createdBy && `compró ${p.createdBy}`,
                        p.missingCount > 0 && `${plural(p.missingCount, "cosa faltó", "cosas faltaron")}`,
                        p.photoCount > 0 && "con foto",
                      ]
                        .filter(Boolean)
                        .join(" · "),
                    ),
                    p.note && el("div", { class: "meta" }, p.note.length > 80 ? `${p.note.slice(0, 80)}…` : p.note),
                  ),
                  el("span", { class: "total" }, money(p.totalCents)),
                ),
              ),
            ),
          ),
    );
  }

  state.view = {
    onEvent: (event) => {
      if (event.topic === "purchases") load().catch(() => {});
    },
  };
  load().catch(fail);
}

function showPurchase(main, id) {
  fill(main, el("p", { class: "loading" }, "Cargando la compra…"));
  state.view = { onEvent: () => {} };

  async function load() {
    let purchase;
    try {
      purchase = (await api("GET", `/api/purchases/${id}`)).purchase;
    } catch (err) {
      fill(main,
        el("p", { class: "notice error" }, err.message),
        el("a", { class: "btn", href: "#/gastos" }, "Volver a gastos"),
      );
      return;
    }
    if (!main.isConnected) return;
    const matchedLines = new Set(purchase.bought.map((i) => i.receiptLine).filter(Boolean));
    const otherLines = (purchase.receipt?.lines ?? []).filter((l) => !matchedLines.has(l.description));

    fill(main,
      el("p", {}, el("a", { class: "link", href: "#/gastos" }, "← Gastos")),
      el("h1", {}, purchase.store || "Supermercado"),
      el(
        "p",
        { class: "hint" },
        [formatDate(purchase.purchasedOn, { weekday: "long", day: "numeric", month: "long", year: "numeric" }), purchase.createdBy && `compró ${purchase.createdBy}`]
          .filter(Boolean)
          .join(" · "),
      ),
      el("div", { class: "detail-total" }, money(purchase.totalCents)),
      purchase.note && [el("h2", {}, "Nota"), el("div", { class: "note-box" }, purchase.note)],
      purchase.photoIds.length > 0 && [
        el("h2", {}, "Factura"),
        el(
          "div",
          { class: "photos" },
          purchase.photoIds.map((photoId) =>
            el(
              "a",
              { class: "photo", href: `/api/uploads/${photoId}`, target: "_blank", rel: "noopener" },
              el("img", { src: `/api/uploads/${photoId}`, alt: "Foto de la factura", loading: "lazy" }),
            ),
          ),
        ),
      ],
      el("h2", {}, `Faltó (${purchase.missing.length})`),
      purchase.missing.length > 0
        ? el("ul", { class: "simple-list" }, purchase.missing.map((i) => el("li", {}, i.name, i.quantity && ` (${i.quantity})`)))
        : el("p", { class: "hint" }, "No faltó nada de la lista."),
      el("h2", {}, `Se compró de la lista (${purchase.bought.length})`),
      purchase.bought.length > 0
        ? el(
            "ul",
            { class: "simple-list" },
            purchase.bought.map((i) =>
              el("li", {}, i.name, i.receiptLine && el("span", { class: "found" }, ` — ${i.receiptLine}`)),
            ),
          )
        : el("p", { class: "hint" }, "Nada de la lista."),
      otherLines.length > 0 && [
        el("h2", {}, `Otras cosas en la factura (${otherLines.length})`),
        el(
          "ul",
          { class: "simple-list" },
          otherLines.map((l) =>
            el("li", {}, l.description, l.amountCents !== null && el("span", { class: "found" }, ` — ${money(l.amountCents)}`)),
          ),
        ),
      ],
      el(
        "div",
        { class: "actions" },
        el("button", { class: "btn", type: "button", onclick: () => editPurchase(purchase, load) }, "Editar"),
        el(
          "button",
          {
            class: "btn danger",
            type: "button",
            onclick: async () => {
              if (!confirm("¿Borrar esta compra y sus fotos? Las cosas compradas no vuelven a la lista.")) return;
              try {
                await api("DELETE", `/api/purchases/${purchase.id}`);
                location.hash = "#/gastos";
              } catch (err) {
                fail(err);
              }
            },
          },
          "Borrar compra",
        ),
      ),
    );
  }
  load();
}

function editPurchase(purchase, onDone) {
  const storeInput = el("input", { value: purchase.store, maxlength: "80" });
  const dateInput = el("input", { type: "date", value: purchase.purchasedOn, required: true });
  const totalInput = el("input", { inputmode: "decimal", value: centsToInput(purchase.totalCents), required: true });
  const noteInput = el("textarea", { maxlength: "1000" }, purchase.note);
  const dialog = el(
    "dialog",
    { onclose: () => dialog.remove() },
    el(
      "form",
      {
        onsubmit: async (e) => {
          e.preventDefault();
          const totalCents = parseMoney(totalInput.value);
          if (totalCents === null) return toast("Escribe el total.");
          try {
            await api("PATCH", `/api/purchases/${purchase.id}`, {
              store: storeInput.value,
              purchasedOn: dateInput.value,
              totalCents,
              note: noteInput.value,
            });
            dialog.close();
            onDone();
          } catch (err) {
            fail(err);
          }
        },
      },
      el("h2", {}, "Editar compra"),
      el("label", { class: "field" }, el("span", {}, "Supermercado"), storeInput),
      el(
        "div",
        { class: "grid-2" },
        el("label", { class: "field" }, el("span", {}, "Fecha"), dateInput),
        el("label", { class: "field" }, el("span", {}, "Total"), totalInput),
      ),
      el("label", { class: "field" }, el("span", {}, "Nota"), noteInput),
      el(
        "div",
        { class: "actions" },
        el("button", { type: "button", class: "btn", onclick: () => dialog.close() }, "Cancelar"),
        el("button", { type: "submit", class: "btn primary" }, "Guardar"),
      ),
    ),
  );
  document.body.append(dialog);
  dialog.showModal();
}

// ---------------------------------------------------------------- start

async function boot() {
  try {
    state.config = await api("GET", "/api/config");
  } catch (err) {
    fill(root, el("p", { class: "notice error" }, err.message));
    return;
  }
  try {
    state.me = (await api("GET", "/api/me")).user;
  } catch (err) {
    fill(root, el("p", { class: "notice error" }, err.message));
    return;
  }
  if (state.me) startApp();
  else showLogin();
}

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}

boot();
