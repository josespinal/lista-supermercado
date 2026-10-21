# Lista del súper

Una aplicación web para que dos personas (o más) compartan la lista del supermercado desde el celular.

- **Lista compartida.** Cada uno agrega lo que va haciendo falta. Lo que agrega uno aparece al instante en el celular del otro.
- **En el súper.** Marca cada cosa cuando la eches al carrito.
- **Terminar compra.** Toma foto de la factura, escribe una nota y marca lo que compraste. Si hay clave de OpenRouter, la app lee la factura con inteligencia artificial: llena el supermercado, la fecha y el total, y busca cada cosa de la lista en la factura.
- **Lo que faltó se queda en la lista.** Lo que no compraste sigue en la lista para la próxima vez, con la marca «Faltó la vez pasada».
- **Gastos.** Total de este mes y del mes pasado, gasto de los últimos 6 meses y todas las compras con su foto, su nota y lo que faltó.

## Qué necesitas

- Node.js 22.13 o más nuevo.
- Opcional: una clave de OpenRouter (`OPENROUTER_API_KEY`) para leer las facturas. Se consigue en <https://openrouter.ai/keys>. La cuenta necesita crédito.

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
| `OPENROUTER_API_KEY` | Clave de OpenRouter para leer las facturas. Sin ella, el total se escribe a mano. |
| `OPENROUTER_MODEL` | Modelo que lee las facturas. Por defecto `google/gemini-3.8-flash`. |
| `CURRENCY`, `LOCALE` | Moneda y formato de los montos. Por defecto pesos dominicanos (`DOP`, `es-DO`). |
| `TRUST_PROXY` | Pon `1` cuando la app está detrás de nginx. |
| `DATA_DIR` | Carpeta de la base de datos y las fotos. Por defecto `./data`. |

**Costo de leer facturas:** cada lectura se cobra del crédito de tu cuenta de OpenRouter. Con el modelo por defecto, una factura cuesta alrededor de 1 centavo de dólar; una factura larga con varias fotos cuesta un poco más.

**Cambiar de modelo:** puedes usar cualquier modelo de OpenRouter que lea imágenes y responda en JSON. En la [lista de modelos](https://openrouter.ai/models?supported_parameters=structured_outputs&input_modalities=image) filtra por *image* y *structured outputs*, copia el nombre (por ejemplo `anthropic/claude-haiku-5.5` u `openai/gpt-6-luna`) y ponlo en `OPENROUTER_MODEL`. Si el modelo no sirve, la app lo dice al leer la factura.

## Ponerla en internet

Para usarla desde la calle, la app tiene que estar en un servidor con HTTPS. Con Ploi (o Forge, o cualquier servidor con Node y nginx):

1. Crea un sitio, por ejemplo `super.tudominio.com`, y conecta este repositorio.
2. Script de despliegue:
   ```bash
   cd /home/ploi/super.tudominio.com
   git pull origin main
   npm ci --omit=dev
   ```
3. Crea el archivo `.env` en la carpeta del sitio con `USERS`, `OPENROUTER_API_KEY`, `PORT=3000` y `TRUST_PROXY=1`.
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
- `src/receipt.js`: lectura de la factura con OpenRouter.
- `src/auth.js`: entrada con PIN y sesiones.
- `public/`: la app que se ve en el celular (HTML, CSS y JavaScript, sin compilación).
