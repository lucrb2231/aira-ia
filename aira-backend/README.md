# AIRA IA — Servidor intermedio (protege la API Key)

**Centro Educativo Los Pinos · Veltrix Smart System**
Asistente Inteligente de Reconocimiento y Asistencia

---

## ¿Para qué sirve esto?

Antes, la página del chatbot guardaba la API Key **en el navegador**. Eso tiene un problema serio: si publicás la página en Internet, cualquiera puede abrir el código y quedarse con tu clave, y usarla gastando tu cuota (o tu dinero).

Este servidor soluciona eso:

```
   ANTES                              AHORA
   -----                              -----
   Navegador                          Navegador
      |  (lleva la clave)                 |  (sin clave, solo la pregunta)
      v                                   v
   Google / OpenAI                    Este servidor  <-- acá vive la clave
                                          |  (lleva la clave)
                                          v
                                      Google / OpenAI
```

La clave **nunca sale del servidor**. El navegador solo manda la pregunta y recibe el texto de la respuesta.

---

## Qué incluye

| Archivo | Qué es |
|---|---|
| `server.js` | Servidor HTTP principal (chat, proxy de claves, rutas). |
| `ai-quota.js` | Sensor de tokens: cuenta el saldo y cambia de IA solo. |
| `face-server.js` | Reconocimiento facial del lado del servidor (IA 2 y plan B). |
| `package.json` | Ficha del proyecto y comando de arranque. |
| `.env.example` | Plantilla de configuración. **Acá van tus claves.** |
| `render.yaml` | Configuración de despliegue automático en Render. |
| `public/index.html` | Tu página, ya adaptada para usar este servidor. |

---

## Instalación paso a paso

### 1. Requisitos
Tener **Node.js 18 o superior**. Para chequear, en la terminal:

```bash
node --version
```

Si da 18 o más, estás listo.

### 2. Entrar a la carpeta

```bash
cd aira-backend
```

### 3. Crear tu archivo de configuración

**Windows (PowerShell):**
```powershell
Copy-Item .env.example .env
```

**Mac / Linux:**
```bash
cp .env.example .env
```

### 4. Poner tu clave en `.env`
Abrí el archivo `.env` con cualquier editor de texto (Bloc de notas, VS Code) y completá:

```
GEMINI_API_KEY=tu_clave_verdadera_aca
```

- Clave de **OpenRouter** (modelo gratis NVIDIA Nemotron): https://openrouter.ai/keys
- Clave de **Google Gemini** (gratis para empezar): https://aistudio.google.com/apikey
- Clave de **OpenAI**: https://platform.openai.com/api-keys

> Para usar OpenRouter poné `AI_PROVIDER=openrouter` y llená `OPENROUTER_API_KEY`.
> Para OpenAI: `AI_PROVIDER=openai` y `OPENAI_API_KEY`.
> Si el proveedor elegido falla, el servidor prueba solo los demás que tengan clave (`AI_FALLBACK=false` lo desactiva).

### 5. Instalar dependencias

```bash
npm install
```

Esto descarga el reconocimiento facial del servidor (Human + TensorFlow.js y sus modelos, ~11 MB). Si no lo hacés, el chat funciona igual, pero la IA 2 facial queda desactivada.

### 6. Arrancar el servidor

```bash
node server.js
```

Vas a ver algo así:

```
  ============================================
   AIRA IA - Servidor del Centro Educativo Los Pinos
  ============================================
   Direccion : http://localhost:3000
   Proveedor : gemini
   Gemini    : configurado si
   OpenAI    : SIN CLAVE
   Limite    : 20 mensajes por minuto e IP
  ============================================
```

### 7. Usarlo
Abrí en el navegador: **http://localhost:3000**

Entrá a la pestaña **Asistente AIRA IA** y escribile lo que quieras. Las respuestas ya vienen del modelo real, y la clave quedó protegida del lado del servidor.

> **Importante:** NO abras el archivo `index.html` haciendo doble clic. Tiene que abrirse desde la dirección del servidor (`http://localhost:3000`), si no el chatbot no puede conectarse.

---

## Si querés publicarlo en Internet (opcional)

Para que otros puedan usarlo desde sus casas:

1. **Subí esta carpeta a un hosting** que soporte Node.js (Render, Railway, Fly.io, un VPS propio, etc.).
2. **Configurá las variables de entorno** del hosting igual que en el `.env` (la plataforma casi siempre tiene un panel para eso). Así la clave no queda en ningún archivo del repositorio.
3. Cuando ya tengas el dominio, en el archivo `.env` poné:

```
ALLOWED_ORIGINS=https://aira.tucolegio.edu.uy
```

Así solo tu página puede usar el servicio (evita que otras webs se aprovechen de tu clave).
Si la página se sirve desde el mismo servidor, no hace falta tocar nada más.

---

## Preguntas frecuentes

**¿Cada cuánto tengo que hacer esto?**
Solo la primera vez. Después es siempre `node server.js`.

**¿Se pierde algo de lo que ya tenía la página?**
No. Funciona todo igual: login, reconocimiento facial, agenda, notificaciones. Lo único que cambió es que la IA ahora pasa por el servidor.

**¿La agenda se sincroniza entre computadoras?**
No. Los usuarios, la asistencia y la agenda viven en el navegador (o en Firebase, si ya cargaste los datos de tu proyecto). Eso no cambió con este servidor — es un tema aparte.

**¿Y si el servidor está apagado?**
El chatbot avisa "Modo básico" y sigue respondiendo las consultas típicas del sistema (agenda, reconocimiento facial, horarios). Las preguntas libres, en cambio, sí necesitan el servidor encendido.

**¿Puedo usar las dos claves (Gemini y OpenAI)?**
Sí, cargá todas las que tengas en el `.env`. La página usa `AI_PROVIDER` como IA 1; si esa se queda sin tokens o falla, el sensor pasa solo a la siguiente (ver más abajo).

**¿Qué pasa si una IA se queda sin tokens?**
El servidor la marca como agotada y la próxima consulta la responde la IA 2, después la IA 3. No hay que tocar nada a mano. El panel de la página muestra solo el **saldo total estimado**, sin indicar qué IA está respondiendo ni avisar de los cambios.

**¿Es seguro tener la clave en un archivo `.env`?**
Es mucho más seguro que en el navegador. Reglas de oro: no subas el `.env` a GitHub, usá un servidor con HTTPS, y cambiá la clave si alguna vez se filtró.

---

## Sensor de tokens y cambio automático de IA

El servidor lleva la cuenta de los tokens que consume cada proveedor y **cambia solo de IA cuando a la actual le quedan pocos** (o cuando el proveedor responde "cuota agotada"). No hace falta reiniciar ni tocar el `.env`.

**Cómo funciona:**

1. Cada respuesta de Gemini / OpenAI / OpenRouter informa cuántos tokens usó. El servidor lo suma al consumo del proveedor.
2. Ese consumo se guarda en `data/ai-usage.json`, así no se pierde al reiniciar.
3. Si a la IA activa le quedan menos tokens que `AI_TOKEN_RESERVE`, o el proveedor devuelve un error de cuota, se marca como agotada y se pasa a la siguiente del orden `AI_FALLBACK_ORDER`.
4. Las cuentas se reinician cada `AI_TOKEN_WINDOW_HOURS` horas. Si un proveedor respondió "cuota agotada", queda en pausa `AI_QUOTA_COOLDOWN_MIN` minutos.

**Roles de las IAs:**

| Rol | Quién es |
|---|---|
| IA 1 | El proveedor de `AI_PROVIDER` (ej. `gemini`) |
| IA 2 | El siguiente en `AI_FALLBACK_ORDER` |
| IA 3 | El restante |

El orden se calcula solo según el proveedor pedido, así que si cambiás `AI_PROVIDER` también cambian los roles.

> 🤫 **Discreción:** la página no muestra qué IA está respondiendo ni avisa cuándo se cambia. El panel solo muestra el saldo total estimado. El detalle queda disponible en `/api/ai/quota` para administración.

**Endpoints útiles:**

| Ruta | Qué devuelve |
|---|---|
| `GET /api/ai/quota` | Estado del sensor: tokens usados/restantes, IA activa y último cambio |
| `GET /api/ai/quota?compact=1` | Versión anónima que usa la página (solo números, sin nombres ni cambios) |
| `GET /api/ai/quota?provider=openai` | Lo mismo, calculando los roles como si OpenAI fuera la IA 1 |
| `GET /api/health` | Incluye un resumen del sensor |
| `POST /api/ai/quota/reset` | Reinicia la cuenta (solo si `ENABLE_QUOTA_RESET=true`) |

> ⚠️ **Importante:** Gemini y OpenAI no publican "tokens restantes". El sensor trabaja con un **presupuesto estimado** (`AI_TOKENS_GEMINI`, `AI_TOKENS_OPENAI`, `AI_TOKENS_OPENROUTER`) y con el consumo real que informa cada API. Ajustá esos números al plan que tengas contratado. OpenRouter, además, muestra los créditos reales de la cuenta como dato extra.

**En Render (plan gratis):** el archivo `data/ai-usage.json` se pierde cuando el servicio se reinicia o se vuelve a desplegar, así que la cuenta arranca de cero. Es normal: el sensor vuelve a medir desde ese momento.

---

## Reconocimiento facial (IA 1 + IA 2)

La página usa **dos capas** para marcar asistencia:

| Capa | Dónde corre | Qué hace |
|---|---|---|
| IA 1 | Navegador | Detecta el rostro y propone candidatos con el modelo local. |
| IA 2 | Servidor (`face-server.js`) | Vuelve a comparar contra **todos** los alumnos con huella y aplica los umbrales del servidor. |

- La verificación de la IA 2 **solo corre en el servidor** (la casilla del panel está fija). El navegador no puede aflojar los umbrales: solo puede pedirlos más estrictos.
- Si la IA 2 no está disponible, se pide una **confirmación manual (Plan B)**. En modo *máxima precisión* no se acepta la IA 1 sola.
- El **anti-foto** se exige con `FACE_LIVENESS=true`. Si se pide y no se puede comprobar, la asistencia **no se registra** (no se acepta "a ciegas").
- Para que la IA 2 tenga con qué comparar, los alumnos deben **re-registrar el rostro** una vez: ahí se guarda `faceDescriptor2`.

**Requisitos:** ejecutar `npm install` (instala Human + TensorFlow.js y los modelos, ~11 MB). Para comprobar que cargó:

```
https://tu-servidor.onrender.com/api/face/status?warm=1
```

Debe devolver `"available":true`, `"loaded":true` y `"modelsOk":true`. Si `livenessReady` es `false`, el modelo anti-foto no está disponible.

---

## Resumen de la configuración

| Variable | Para qué sirve | Ejemplo |
|---|---|---|
| `PORT` | Puerto del servidor | `3000` |
| `AI_PROVIDER` | Proveedor por defecto | `openrouter`, `gemini` u `openai` |
| `OPENROUTER_API_KEY` | Tu clave de OpenRouter | `sk-or-...` |
| `OPENROUTER_MODEL` | Modelo de OpenRouter | `nvidia/nemotron-3.5-lightning:free` |
| `AI_FALLBACK` | Probar otro proveedor si falla | `true` / `false` |
| `GEMINI_API_KEY` | Tu clave de Google | `AIza...` |
| `GEMINI_MODEL` | Modelo de Gemini | `gemini-3.8-flash` |
| `OPENAI_API_KEY` | Tu clave de OpenAI | `sk-...` |
| `OPENAI_MODEL` | Modelo de OpenAI | `gpt-4o-mini` |
| `ALLOWED_ORIGINS` | Dominios autorizados | `*` o `https://tu-dominio` |
| `RATE_LIMIT_PER_MINUTE` | Límite de consultas por minuto e IP | `20` |
| `AI_TIMEOUT_MS` | Espera máxima por respuesta de una IA | `25000` |
| `AI_TOKENS_GEMINI` | Presupuesto estimado de tokens de Gemini | `1000000` |
| `AI_TOKENS_OPENAI` | Presupuesto estimado de tokens de OpenAI | `2000000` |
| `AI_TOKENS_OPENROUTER` | Presupuesto estimado de tokens de OpenRouter | `500000` |
| `AI_TOKEN_RESERVE` | Colchón mínimo antes de cambiar de IA | `800` |
| `AI_TOKEN_WINDOW_HOURS` | Cada cuántas horas se reinicia la cuenta | `24` |
| `AI_QUOTA_COOLDOWN_MIN` | Pausa tras "cuota agotada" | `60` |
| `AI_FALLBACK_ORDER` | Orden de respaldo de las IAs | `gemini,openrouter,openai` |
| `ENABLE_QUOTA_RESET` | Permite reiniciar el sensor por HTTP | `false` |
| `FACE_MIN_SIM` | Similitud mínima del rostro | `0.55` |
| `FACE_MIN_GAP` | Diferencia mínima entre 1.º y 2.º candidato | `0.04` |
| `FACE_MIN_SCORE` | Puntaje mínimo de detección | `0.6` |
| `FACE_LIVENESS` | Exigir prueba de vida (anti-foto) | `true` |
| `FACE_MAX_IMAGES` | Fotos máximas por rostro | `8` |
| `FACE_MAX_CANDIDATES` | Candidatos máximos a comparar | `200` |
