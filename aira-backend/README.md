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
| `server.js` | El servidor. No necesita ninguna librería extra. |
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

### 5. Arrancar el servidor

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

### 6. Usarlo
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
Sí, cargá las dos en el `.env`. La página usa Gemini por defecto; si preferís OpenAI, cambiá `AI_PROVIDER=openai`.

**¿Es seguro tener la clave en un archivo `.env`?**
Es mucho más seguro que en el navegador. Reglas de oro: no subas el `.env` a GitHub, usá un servidor con HTTPS, y cambiá la clave si alguna vez se filtró.

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
