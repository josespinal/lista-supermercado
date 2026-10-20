# Lista del súper

Una aplicación web para que dos personas (o más) compartan la lista del supermercado desde el celular.

- **Lista compartida.** Cada uno agrega lo que va haciendo falta. Lo que agrega uno aparece al instante en el celular del otro.
- **En el súper.** Marca cada cosa cuando la eches al carrito.
- **Terminar compra.** Toma foto de la factura, escribe una nota y marca lo que compraste. Si hay clave de Claude, la app lee la factura: llena el supermercado, la fecha y el total, y busca cada cosa de la lista en la factura.
- **Lo que faltó se queda en la lista.** Lo que no compraste sigue en la lista para la próxima vez, con la marca «Faltó la vez pasada».
- **Gastos.** Total de este mes y del mes pasado, gasto de los últimos 6 meses y todas las compras con su foto, su nota y lo que faltó.

## Qué necesitas

- Node.js 22 o más nuevo.
- Opcional: una clave de la API de Claude (`ANTHROPIC_API_KEY`) para leer las facturas. Se consigue en <https://console.anthropic.com>.

## Probarla en tu computadora

```bash
npm install
cp .env.example .env     # luego cambia los nombres y los PIN
npm start
```

Abre <http://localhost:3000>. Para probar desde el celular en la misma red Wi-Fi, usa la IP de tu computadora, por ejemplo `http://192.168.1.20:3000`.

## Configuración

Todo se configura en el archivo `.env` (mira `.env.example`):

| Variable | Para qué sirve |
| --- | --- |
| `USERS` | Quiénes entran y su PIN: `"José:1234,Esposa:5678"`. Si cambias un PIN aquí, cambia al reiniciar la app. |
| `ANTHROPIC_API_KEY` | Clave de Claude para leer las facturas. Sin ella, el total se escribe a mano. |
| `CLAUDE_MODEL` | Modelo que lee las facturas. Por defecto `claude-opus-5-5`. |
| `CLAUDE_EFFORT` | Cuánto razona el modelo: `low`, `medium` (por defecto) o `high`. |
| `CURRENCY`, `LOCALE` | Moneda y formato de los montos. Por defecto pesos dominicanos (`DOP`, `es-DO`). |
| `TRUST_PROXY` | Pon `1` cuando la app está detrás de nginx. |
| `DATA_DIR` | Carpeta de la base de datos y las fotos. Por defecto `./data`. |

**Costo de leer facturas:** cada lectura usa la API de Claude y se cobra en tu cuenta de Anthropic. Una factura cuesta unos centavos de dólar; una factura larga con varias fotos cuesta más.

## Ponerla en internet

Para usarla desde la calle, la app tiene que estar en un servidor con HTTPS. Con Ploi (o Forge, o cualquier servidor con Node y nginx):

1. Crea un sitio, por ejemplo `super.tudominio.com`, y conecta este repositorio.
2. Script de despliegue:
   ```bash
   cd /home/ploi/super.tudominio.com
   git pull origin main
   npm ci --omit=dev
   ```
3. Crea el archivo `.env` en la carpeta del sitio con `USERS`, `ANTHROPIC_API_KEY`, `PORT=3000` y `TRUST_PROXY=1`.
4. Crea un *daemon* (proceso que siempre corre) con el comando `npm start` en la carpeta del sitio.
5. En la configuración de nginx del sitio, envía el tráfico a la app:
   ```nginx
   location / {
       proxy_pass http://127.0.0.1:3000;
       proxy_set_header Host $host;
       proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
       proxy_set_header X-Forwarded-Proto $scheme;
       proxy_buffering off;          # para que los cambios lleguen al instante
       client_max_body_size 12m;     # fotos de la factura
   }
   ```
6. Activa el certificado SSL (Let's Encrypt).

En el celular, abre la página y elige **«Agregar a pantalla de inicio»**. Así queda como una app.

## Copias de seguridad

Todo está en la carpeta `data/`: la base de datos `lista.db` y la carpeta `uploads/` con las fotos. Copia esa carpeta de vez en cuando.

## Para desarrollar

```bash
npm run dev    # reinicia la app cuando cambias un archivo
npm test       # pruebas del servidor
```

- `src/server.js`: rutas de la API y arranque.
- `src/db.js`: base de datos (SQLite) y reglas de la lista y las compras.
- `src/receipt.js`: lectura de la factura con Claude.
- `src/auth.js`: entrada con PIN y sesiones.
- `public/`: la app que se ve en el celular (HTML, CSS y JavaScript, sin compilación).
