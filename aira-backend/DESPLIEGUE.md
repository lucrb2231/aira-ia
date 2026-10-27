# 🚀 Guía para publicar AIRA IA (paso a paso, sin vueltas)

Esta guía te lleva de la mano. Vas a tener **dos cosas** funcionando:

1. **El servidor** (esta carpeta) → vive en **Render** (gratis). Acá se
   guarda tu clave de IA **en secreto**.
2. **Tu página** (`index.html`) → vive en **GitHub Pages** (gratis) y le
   pide las respuestas al servidor.

> 🔑 La idea clave: la clave de la IA **nunca** se sube a GitHub ni queda en
> la página. Solo la conoce Render. Así nadie te la puede robar mirando el
> código de la página.

---

## ① Antes de empezar — conseguí tu clave de Gemini (gratis)

1. Entrá a → https://aistudio.google.com/apikey
2. Iniciá sesión con tu cuenta de Google.
3. Tocá **“Create API key”** (Crear clave).
4. Copiá la clave larga que te da (empieza con `AIza...`) y guardála en un
   lugar seguro. **No se la pases a nadie.**

---

## ② Subí el servidor a Render

### Opción A — la más fácil (arrastrar la carpeta)

Render necesita leer el código desde GitHub. Hacé esto:

1. Creá una cuenta gratis en → https://render.com (podés entrar con tu
   cuenta de GitHub, es más rápido).
2. Subí **el contenido de esta carpeta** (`aira-backend`) a un repositorio
   nuevo de GitHub. Si no sabés cómo, mirá el **Apéndice** al final.
3. En Render, tocá **“New +” → “Web Service”**.
4. Elegí el repositorio que acabas de subir.
5. Render va a detectar el archivo `render.yaml` solo. Dejá todo como está:
   - **Runtime:** Node
   - **Start command:** `node server.js`
   - **Plan:** Free
6. Tocá **“Create Web Service”**.

### ☛ Cargale la clave secreta (el paso más importante)

Apenas se crea el servicio:

1. En Render, andá a la pestaña **“Environment”**.
2. Agregá estas variables (botón **“Add Environment Variable”**):

   | Nombre (Key)      | Valor (Value)                                      |
   |-------------------|----------------------------------------------------|
   | `OPENROUTER_API_KEY` | *(tu clave de https://openrouter.ai/keys)*      |
   | `GEMINI_API_KEY`  | *(opcional, respaldo: tu clave `AIza...`)*         |
   | `ALLOWED_ORIGINS` | *(la dirección de tu página, ver paso ④)*         |

   > 💡 Si querés que el **sensor de tokens** cambie solo de IA, no hace falta
   > configurar nada más: ya trae valores por defecto. Opcionalmente podés
   > ajustar `AI_PROVIDER` (cuál es la IA 1), `AI_FALLBACK_ORDER` (orden de
   > respaldo) y `AI_TOKENS_GEMINI` / `AI_TOKENS_OPENAI` / `AI_TOKENS_OPENROUTER`
   > (presupuesto estimado de cada una). Están explicados en el `README.md`.

3. Guardá los cambios. Render reinicia el servidor solo.

> Si todavía no tenés la dirección de GitHub Pages, poné provisoriamente
> `ALLOWED_ORIGINS` con un `*` para probar, y después la cambiás por la
> dirección real (es más seguro).

---

## ③ Comprobá que el servidor anda

Cuando Render termina, te da una dirección tipo:

```
https://aira-backend-xxxx.onrender.com
```

Abrí en el navegador:

```
https://aira-backend-xxxx.onrender.com/api/health
```

Si ves algo como `{"status":"ok"}` → ¡el servidor está vivo! 🎉

> ⚠️ El plan gratis de Render “se duerme” si nadie lo usa por un rato. La
> primera pregunta después de un rato puede tardar ~30 segundos en
> despertar. Es normal.

---

## ④ Conectá tu página con el servidor

1. Abrí el archivo `index.html` (el que te entregué).
2. Buscá arriba de todo, en el código, esta línea:

   ```js
   const AIRA_BACKEND_URL = "";
   ```

3. Poné ahí la dirección de tu servidor de Render:

   ```js
   const AIRA_BACKEND_URL = "https://aira-backend-xxxx.onrender.com";
   ```

4. Guardá el archivo.
5. Subí ese `index.html` a tu repositorio de **GitHub Pages**.

### ¿Cuál es la dirección de tu página (para `ALLOWED_ORIGINS`)?

GitHub Pages te da una dirección tipo:

```
https://TU-USUARIO.github.io
```

o (si está dentro de un repo)

```
https://TU-USUARIO.github.io/NOMBRE-DEL-REPO
```

Para `ALLOWED_ORIGINS` en Render poné **solo la parte del dominio**, sin la
ruta final:

```
https://TU-USUARIO.github.io
```

Volvé al paso ② y actualizá esa variable con esta dirección.

---

## ⑤ ¡Listó! Probá todo junto

1. Abrí tu página de GitHub Pages.
2. Escribíle algo a **AIRA IA** en el chat.
3. Si te responde como una IA de verdad → ¡funciona todo! 🚀

Si no responde, mirá la sección **Problemas comunes** más abajo.

---

## 🛠 Problemas comunes

**“La IA no contesta / dice que no se puede conectar”**
- Fijate que `AIRA_BACKEND_URL` en el `index.html` tenga la dirección
  correcta de Render (sin barra `/` al final).
- Entrá a `.../api/health` para confirmar que el servidor está despierto.
- La primera vez puede tardar ~30s (Render se estaba durmiendo).

**“Error de CORS” en la consola del navegador**
- `ALLOWED_ORIGINS` en Render tiene que coincidir **exactamente** con el
  dominio de tu página (`https://tu-usuario.github.io`), sin ruta ni barra
  final.

**“Error 401 / clave inválida”**
- Revisá que `GEMINI_API_KEY` en Render esté bien pegada, sin espacios.

**“Quiero saber qué IA está respondiendo”**
- La interfaz es **discreta a propósito**: el sensor muestra solo el saldo
  total estimado y no avisa cuándo se cambia de IA. El cambio ocurre solo.
- Para revisar el detalle (uso, saldo y último cambio) abrí:

  ```
  https://tu-servidor.onrender.com/api/ai/quota
  ```

- La IA 1 es la que dice `AI_PROVIDER` en Render. El `index.html` puede pedir
  un proveedor puntual con `AIRA_PROVIDER`; si no coincide, manda la pedida
  por la página. Lo más simple es que los dos digan lo mismo (por ejemplo
  `gemini`).
- Si querés forzar que vuelva a la IA 1, esperá a que se reinicie la ventana
  (`AI_TOKEN_WINDOW_HOURS`) o reiniciá el servicio en Render (en el plan
  gratis la cuenta se reinicia de cero).

**“El reconocimiento facial del servidor no carga”**
- Ejecutá `npm install` (o revisá que Render haya instalado las dependencias).
- Abrí `.../api/face/status?warm=1`: tiene que decir `"available":true`,
  `"loaded":true`, `"modelsOk":true` y `"livenessReady":true`.
- Si `"error"` menciona modelos incompletos, volvé a desplegar para que se
  descarguen los modelos de `@vladmandic/human`.
- El plan gratis de Render tiene poca memoria; si el modelo no entra, la IA 2
  facial puede fallar aunque el chat siga funcionando.

**“El sensor dice que quedan 0 tokens pero la IA todavía responde”**
- Es normal: el presupuesto es una **estimación** (`AI_TOKENS_*`). Gemini y
  OpenAI no informan los tokens restantes reales; el sensor lleva la cuenta
  con el consumo que devuelve cada API. Si tu plan tiene más tokens, subí el
  número en `AI_TOKENS_GEMINI` / `AI_TOKENS_OPENAI` / `AI_TOKENS_OPENROUTER`.

---

## 🔒 Sobre la seguridad (para que lo tengas claro)

- Con este armado, tu clave de IA queda **guardada solo en Render** y nadie
  la ve mirando el código de tu página. Ese era el objetivo. ✅
- Los permisos de usuario (admin / coordinador) de la página siguen siendo
  **del lado del navegador**: sirven para ordenar quién ve/edita qué, pero
  alguien con conocimientos técnicos podría saltarlos. Para seguridad
  **de verdad** en los permisos haría falta una base de datos con reglas
  (por ejemplo Firebase). Te lo aclaro para no venderte humo.

---

## 📎 Apéndice — Cómo subir una carpeta a GitHub (rápido)

1. Creá un repositorio nuevo en https://github.com/new
2. En tu compu, dentro de la carpeta `aira-backend`:
   ```bash
   git init
   git add .
   git commit -m "servidor aira"
   git branch -M main
   git remote add origin https://github.com/TU-USUARIO/TU-REPO.git
   git push -u origin main
   ```
3. Listo, ya podés elegirlo en Render.

> ⚠️ **Nunca** subas el archivo `.env` con tu clave a GitHub. La clave va
> solo en el panel de Render. (Por eso incluimos un `.gitignore`.)
