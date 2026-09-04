/**
 * FITACCESS SERVICE WORKER
 *
 * Qué se arregló respecto de la versión anterior:
 *
 * 1. `cache.addAll()` es atómico: si UNO de los archivos da 404, la instalación
 *    entera se rechaza y el service worker nunca queda activo. La lista vieja
 *    pedía ./css/theme.css y ./js/app.js, que no existen (la app es un único
 *    index.html con todo embebido), así que el SW no se instalaba nunca.
 *    Ahora cada archivo se cachea por separado y un faltante no rompe nada.
 *
 * 2. Cache-first para el HTML dejaba a la gente clavada en una versión vieja
 *    para siempre. Como acá TODO el código vive dentro de index.html, eso
 *    significa no recibir ni un arreglo. Ahora el documento va network-first.
 *
 * 3. El fetch anterior interceptaba todo, incluidas las llamadas a Firebase
 *    Auth y Firestore. Servir eso desde caché rompe el login y la sincronización.
 *    Ahora esos dominios pasan derecho a la red, siempre.
 *
 * 4. `fetch().catch()` devolvía undefined, y un respondWith(undefined) tira
 *    error en la página. Ahora siempre se devuelve una Response.
 */

const VERSION = "fitaccess-v2.0.0";
const SHELL_CACHE = `${VERSION}-shell`;
const RUNTIME_CACHE = `${VERSION}-runtime`;

/* La app es un solo archivo: no hay ./js/ ni ./css/ que cachear. */
const SHELL_ASSETS = [
  "./",
  "./index.html",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-512.png"
];

/* Nunca se cachean: son el estado vivo de la sesión y de la base.
   Si se sirvieran desde caché, el login y los permisos se romperían. */
const NEVER_CACHE = [
  "identitytoolkit.googleapis.com",   // Firebase Auth
  "securetoken.googleapis.com",       // refresco de tokens
  "firestore.googleapis.com",         // Firestore
  "firebaseinstallations.googleapis.com",
  "firebaselogging",
  "cloudfunctions.net",               // Cloud Functions
  "google.firestore.v1.Firestore"     // canal de escucha en vivo
];

/* Sí se cachean en runtime: los recursos de terceros que la app necesita para
   funcionar offline. El SDK de Firebase está versionado en la URL, así que es
   seguro guardarlo. */
const RUNTIME_HOSTS = [
  "fonts.googleapis.com",
  "fonts.gstatic.com",
  "cdnjs.cloudflare.com",             // qrcodejs
  "cdn.jsdelivr.net",                 // jsQR — sin esto el escáner no anda offline
  "www.gstatic.com",                  // SDK de Firebase (URL con versión)
  "images.unsplash.com"               // fotos de los socios en la demo
];

function offlineFallback() {
  return new Response(
    "Sin conexión y sin copia en caché de este recurso.",
    { status: 503, statusText: "Offline", headers: { "Content-Type": "text/plain; charset=utf-8" } }
  );
}

/* ------------------------------------------------------------------ install */
self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    // Uno por uno: un 404 no puede tumbar la instalación completa.
    const results = await Promise.allSettled(
      SHELL_ASSETS.map(url => cache.add(new Request(url, { cache: "reload" })))
    );
    const failed = results
      .map((r, i) => (r.status === "rejected" ? SHELL_ASSETS[i] : null))
      .filter(Boolean);
    if (failed.length) console.warn("[SW] no se pudieron cachear:", failed);
  })());
  // A propósito NO se llama skipWaiting(): la página avisa y el usuario decide
  // cuándo actualizar. En una terminal de recepción, recargar en medio de un
  // escaneo es peor que esperar un rato.
});

/* ----------------------------------------------------------------- activate */
self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys.filter(k => !k.startsWith(VERSION)).map(k => caches.delete(k))
    );
    await self.clients.claim();
  })());
});

/* La página pide tomar el control cuando el usuario acepta actualizar. */
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
});

/* -------------------------------------------------------------- estrategias */
function isNeverCache(url) {
  return NEVER_CACHE.some(p => url.href.includes(p));
}

function isRuntimeHost(url) {
  return RUNTIME_HOSTS.some(h => url.hostname === h || url.hostname.endsWith("." + h));
}

/** Documento: red primero, caché como red de emergencia. */
async function networkFirst(request) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const fresh = await fetch(request);
    if (fresh && fresh.ok) cache.put(request, fresh.clone());
    return fresh;
  } catch (e) {
    return (await cache.match(request))
      || (await cache.match("./index.html"))
      || (await cache.match("./"))
      || offlineFallback();
  }
}

/** Estáticos: caché primero y se revalida de fondo. */
async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);

  const update = fetch(request).then(res => {
    // Las respuestas opacas (cross-origin sin CORS) también sirven para
    // volver a mostrar el recurso estando offline.
    if (res && (res.ok || res.type === "opaque")) cache.put(request, res.clone());
    return res;
  }).catch(() => null);

  if (cached) return cached;
  return (await update) || offlineFallback();
}

/* -------------------------------------------------------------------- fetch */
self.addEventListener("fetch", (event) => {
  const req = event.request;

  // Sólo GET: un POST no se cachea y no hay que tocarlo.
  if (req.method !== "GET") return;

  let url;
  try { url = new URL(req.url); } catch (e) { return; }

  // Auth, Firestore y funciones: siempre a la red, sin intermediarios.
  if (isNeverCache(url)) return;

  // Navegación (abrir la app, recargar): red primero.
  if (req.mode === "navigate" || (req.headers.get("accept") || "").includes("text/html")) {
    event.respondWith(networkFirst(req));
    return;
  }

  if (url.origin === self.location.origin) {
    event.respondWith(staleWhileRevalidate(req, SHELL_CACHE));
    return;
  }

  if (isRuntimeHost(url)) {
    event.respondWith(staleWhileRevalidate(req, RUNTIME_CACHE));
    return;
  }

  // Cualquier otro origen: se deja pasar sin tocar.
});
