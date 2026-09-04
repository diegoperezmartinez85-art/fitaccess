# Pasar FitAccess a Firebase

La app funciona en dos modos, y se cambia desde el botón **"Origen de datos"** en la
pantalla de ingreso. El badge del header dice en cuál estás.

| | Local (demo) | Firebase |
|---|---|---|
| Datos | `localStorage` del navegador | Firestore |
| Contraseñas | hash SHA-256 + salt, en el navegador | Firebase Auth |
| Rol y gymId | en `localStorage` | **custom claims firmados** en el token |
| Alta de usuarios | el admin fija la contraseña | invitación por email, la persona elige la suya |
| Seguridad real | ninguna: se edita con DevTools | `firestore.rules` |
| Cuentas de prueba | sí | no (viven en Auth) |

Arranca en **local**, porque el modo Firebase no sirve hasta que despliegues las
reglas y las funciones.

## Por qué el rol tiene que estar en los claims

Mientras el rol viva en `localStorage`, cualquiera se pone `owner` desde la consola
del navegador. En modo Firebase la app **descarta** el rol local y usa el del token:

```js
// index.html → applyCloudIdentity()
role: identity.role,        // ← firmado por el backend, no editable
gymId: identity.gymId,
```

Probado: con `localStorage` diciendo `owner` y el claim diciendo `recepcion`, la sesión
queda en `recepcion`.

Y los claims sólo los puede escribir el Admin SDK. Por eso el alta de usuarios pasa por
Cloud Functions y no por el navegador, como hacía la versión anterior con una "app
secundaria" de Firebase: ese camino **no puede** firmar claims, y las reglas le prohíben
escribir en `/users`.

## Antes que nada: autorizar el dominio de GitHub Pages

Firebase Auth sólo acepta pedidos desde dominios en su lista blanca. Sin esto el login
falla con `auth/unauthorized-domain` y no hay pista de por qué.

Consola de Firebase → **Authentication → Settings → Authorized domains → Add domain**:

```
tuusuario.github.io
```

Y en `functions/index.js`, completar el origen para CORS:

```js
const ALLOWED_ORIGINS = [
  "https://tuusuario.github.io",   // ← tu dominio, sin la ruta
  ...
];
```

Si la app vive en `tuusuario.github.io/fitaccess/`, el origen sigue siendo sólo el
dominio: la ruta no forma parte del origen.

## Pasos

### 1. Habilitar Auth

En la consola de Firebase → Authentication → Sign-in method → activar
**Correo electrónico/contraseña**.

### 2. Desplegar reglas y funciones

```bash
npm install -g firebase-tools
firebase login
firebase use fitaccess-5ad19

cd functions && npm install && cd ..
firebase deploy --only firestore:rules,functions
```

Las funciones quedan en `southamerica-east1`. Si preferís otra región, cambiá
`setGlobalOptions` en `functions/index.js`.

### 3. Convertirte en operador de la plataforma

El claim `platform: true` es el que te deja ver todos los gimnasios. Se pone una sola
vez, con la función de bootstrap:

1. Creá tu usuario en Authentication → Users → Add user.
2. Entrá a la app en modo Firebase con ese correo.
3. Desde la consola del navegador:

```js
const { getFunctions, httpsCallable } = await import(
  "https://www.gstatic.com/firebasejs/12.18.0/firebase-functions.js");
await httpsCallable(getFunctions(FirebaseSaaS.app, "southamerica-east1"),
  "setPlatformOperator")({});
```

4. Cerrá sesión y volvé a entrar: el token nuevo trae el claim.

`setPlatformOperator` sólo funciona si todavía no hay ningún operador, o si ya sos uno.
Aun así, **conviene borrarla después del bootstrap**.

### 4. Crear el primer gimnasio

Desde la Consola SaaS → "Alta de Gimnasio". Eso llama a `createGym`, que crea el tenant,
crea al dueño en Auth, le firma `{ gymId, role: "owner" }` y devuelve el link de
invitación.

## Estructura en Firestore

Las rutas que usa la app son exactamente las que autorizan las reglas:

```
/gyms/{gymId}                       ← branding, sedes, planes, settings, saas
/gyms/{gymId}/members/{memberId}    ← padrón (del gimnasio, no de la sede)
/gyms/{gymId}/accessLogs/{logId}    ← ingresos; sólo create, nunca update
/gyms/{gymId}/audit/{eventId}       ← auditoría; sólo la escriben las functions
/users/{uid}                        ← espejo del rol; sólo lo escriben las functions
/platformOperators/{uid}            ← quién es operador del SaaS
```

Custom claims:

```js
{ platform: true }                          // operador del SaaS
{ gymId, role, memberId?, branchId? }       // usuario de un gimnasio
// role ∈ owner | admin | recepcion | entrenador | socio
```

## Qué puede escribir cada uno desde el navegador

Las reglas son deliberadamente más estrictas que la UI:

- **Dueño/admin**: su gimnasio (menos `saas`, `active` y `slug`) y todo el padrón.
- **Recepción**: de una ficha, sólo `subscriptionStatus`, `dueDate`, `payments` y
  `lastCheckInAt`. Puede cobrar, no puede editar datos personales ni borrar socios.
- **Socio**: sólo su ficha, y sólo `phone`, `email`, `photo`, `aptoFile`. **No** puede
  tocar `aptoMedico` ni `dueDate`: sube el certificado y el staff lo valida.
- **Nadie**: `/users`, `/audit` y el `saas` del gimnasio. Eso es del backend.

## Detalles a tener en cuenta

**El token tarda hasta 1 hora en reflejar un cambio de rol.** Al iniciar sesión la app
llama a `getIdTokenResult(true)` para forzar el refresco, pero si le cambiás el rol a
alguien que ya está logueado, sigue con el rol viejo hasta que renueve. Si te molesta,
agregá `admin.auth().revokeRefreshTokens(uid)` en `setGymUserRole` y manejá el
`auth/user-token-revoked` en el cliente.

**La `apiKey` del archivo no es un secreto.** Identifica al proyecto; la seguridad está
en las reglas. No hace falta esconderla.

**Falta migrar los datos que hoy están en `localStorage`.** El backup JSON del panel
(Backup → Descargar) tiene la estructura correcta; hace falta un script que lo suba con
el Admin SDK. Si querés, lo escribo.

**Storage para los certificados médicos.** Hoy el apto se guarda como base64 dentro del
documento del socio, y Firestore tiene un límite de 1 MB por documento. Una foto de
celular lo puede superar. Corresponde subirlos a Cloud Storage y guardar sólo la URL,
con sus propias reglas de Storage. Es dato de salud: acceso restringido al staff, y
borrado a pedido del socio (ley 25.326). Ojo que **Cloud Storage también requiere Blaze**
desde los cambios de septiembre de 2024. Mientras estés en Spark, la alternativa es
redimensionar y comprimir la imagen en el navegador antes de guardarla, para no pasar
el megabyte.

## El plan gratuito no alcanza para las funciones

Desplegar Cloud Functions **requiere el plan Blaze** (pago por uso), porque el proceso de
build usa Cloud Build, que es un servicio pago. A tu volumen el costo real es
prácticamente cero, pero hay que registrar una tarjeta.

Si preferís no hacerlo todavía, la alternativa es correr las mismas operaciones desde tu
máquina con un script del Admin SDK (crear usuarios, firmar claims, dar de alta
gimnasios). Funciona en Spark y las reglas de Firestore te siguen protegiendo igual,
que es lo que importa. Lo que se pierde es el autoservicio desde el panel.

Fuentes: [planes de precios de Firebase](https://firebase.google.com/docs/projects/billing/firebase-pricing-plans),
[requisito de Blaze para desplegar funciones](https://stackoverflow.com/questions/62824043/is-cloud-functions-in-firebase-free-or-not-cloud-functions-deployment-requires/67309096),
[cambios de precios de Cloud Storage](https://firebase.google.com/docs/storage/faqs-storage-changes-announced-sept-2024).
*Contenido reformulado por restricciones de licencia.*

## PWA y modo offline

El service worker anterior **nunca se instalaba**, y el `index.html` nunca lo registraba.
Ver la sección correspondiente en `ROLES.md`. Ahora:

- `sw.js` cachea el shell archivo por archivo, así un 404 no tumba la instalación.
- El documento va **network-first**: como todo el código vive dentro de `index.html`,
  cache-first dejaba a la gente clavada en una versión vieja para siempre.
- Auth, Firestore y las funciones **nunca** se cachean: servir eso desde caché rompe
  el login.
- Firestore arranca con caché persistente en IndexedDB
  (`persistentLocalCache` + `persistentMultipleTabManager`): si se corta internet,
  recepción sigue leyendo el padrón y las escrituras se encolan hasta que vuelva.
- Cuando hay una versión nueva, aparece una barra y **el usuario decide** cuándo
  recargar. Forzar una recarga en medio de un escaneo es peor que esperar.

Probado apagando el servidor y recargando: la app levanta desde el caché, el login
funciona y el semáforo registra ingresos.
