# FitAccess — Modelo Multi-Tenant y Roles

## 1. El problema actual

En la versión anterior no existía la entidad **gimnasio**. Lo que se mostraba como
"Sede: FitAccess Club" era `WhiteLabelEngine.config.gymName`, es decir, **branding global
de la aplicación**, no el gimnasio del socio. Consecuencias:

| Problema | Detalle |
|---|---|
| Sin aislamiento de datos | `FitApp.members`, `users` y `logs` eran listas planas. Cualquier admin veía el padrón completo. |
| "Sede" incorrecta | La credencial imprimía el nombre de la app en lugar del gimnasio del socio. |
| Branding compartido | Si el gym A cambiaba el color, se lo cambiaba a todos. |
| Backdoor de auth | `password === "FitAccess123!" \|\| password === "123456"` permitía entrar como **cualquier** email, incluso inexistente, con rol inferido del portal. Escalada de privilegios trivial. |
| Contraseñas en claro | `users[].password` en `localStorage`, legible desde la consola del navegador. |
| Roles planos | Sólo `admin / recepcion / socio`. El dueño del gym y el operador del SaaS eran el mismo rol. |

## 2. Modelo de datos (tenant-first)

Toda entidad de negocio lleva `gymId`. Nada se lee sin filtrar por el tenant activo.

```
Gym (tenant)
├─ id, slug, name, legalName, cuit, phone, email, active
├─ branding   { primaryColor, secondaryColor, logoUrl }
├─ branches[] { id, name, address }        ← las "sedes" reales
├─ plans[]    { id, name, price }          ← precios propios de cada gym
├─ settings   { currency, warnDays, requireApto, qrTtlSeconds }
└─ saas       { plan, status, maxMembers, maxStaff }

Member  { id, gymId, branchId, name, dni, email, planId, ... }
User    { id, gymId|null, role, email, salt, passwordHash, memberId, active }
Log     { id, gymId, branchId, memberId, status, reason, byUserId }
Audit   { id, gymId, actorId, action, entity, entityId, detail, at }
```

`gymId === null` sólo es válido para el rol `superadmin` (operador de la plataforma).

**Jerarquía:** Plataforma → Gym (tenant / cliente que paga la suscripción) → Sedes
(branches) → Socios. El admin de un gym nunca sale de su `gymId`.

### Reglas de negocio definidas

**1. Las sedes de un gimnasio comparten el padrón.** El socio con sede habitual en
Palermo entra en Belgrano, y el staff de cualquier sede ve y cobra a todo el padrón.
`branchId` en la ficha es la *sede habitual*: sirve para estadística y para detectar
visitas, no para limitar el acceso.

- Un ingreso en otra sede se permite y se registra como visita:
  `GREEN · "Ingreso correcto (visita entre sedes)"`, con `isVisit: true` y la puerta
  real en `branchId`. En el semáforo aparece `🔄 visita · socio de Sede Belgrano`.
- El padrón tiene un filtro por sede, pero es sólo una vista: los datos no se parten.
- Para el gimnasio que venda planes por sede existe `settings.crossBranchAccess`.
  En `false`, la visita se deniega con *"Su plan es válido sólo en Sede Belgrano"*.
  Por defecto está en `true`, que es el comportamiento pedido.

**2. Un mail = un gimnasio.** El email identifica a un único usuario de un único
gimnasio, en toda la plataforma. Si el correo ya está tomado, se usa otro.

- Es la regla que impone Firebase Auth: no admite dos cuentas con el mismo email.
  Adoptarla como regla del sistema evita construir un modelo de membresías, un
  selector de gimnasio al ingresar y funciones extra para firmar claims por tenant.
- Al crear un usuario con un correo ya usado, el mensaje distingue los dos casos:
  *"ya tiene un usuario en este gimnasio"* o *"ya está en uso en la plataforma"*.
- El DNI y el email de un **socio** sí son únicos por gimnasio, no globales: la misma
  persona puede entrenar en dos gimnasios distintos. La restricción global aplica a las
  cuentas de acceso, no a las fichas.

> Si algún día una persona necesita cuenta en dos gimnasios, se cambia `user.gymId` por
> una lista de membresías y el rol pasa a `claims.gyms[gymId]`. El resto del código no
> se toca, porque ya está todo scopeado por `gymId`. Se descartó hacerlo ahora: es
> complejidad para un caso que todavía no existe.

## 3. Roles

| Rol | Alcance | Para quién |
|---|---|---|
| `superadmin` | Plataforma (todos los gyms) | Vos, dueño del SaaS. Crea gimnasios, asigna dueños, suspende por impago. **No se puede crear desde el panel de un gym.** |
| `owner` | Su gym completo | Dueño del gimnasio. Único que toca facturación del SaaS y puede crear otros `admin`. |
| `admin` | Su gym, sin facturación | Gerente / encargado. Padrón, cobros, branding, staff de recepción. No crea dueños ni borra el gym. |
| `recepcion` | Su gym, operativo | Mostrador: escáner, semáforo, cobro en 1 clic. No ve facturación, no crea usuarios, no exporta el padrón. |
| `entrenador` | Su gym, lectura | Ve el padrón y los aptos médicos. Cero acceso a plata. |
| `socio` | Sólo sí mismo | Su carnet, su QR, sus pagos, su apto. |

### Matriz de permisos (capabilities)

Se resuelve con `FitApp.can('members:create')`. Los comodines (`members:*`)
cubren toda la familia.

| Capability | superadmin | owner | admin | recepcion | entrenador | socio |
|---|:-:|:-:|:-:|:-:|:-:|:-:|
| `tenants:manage` (crear/suspender gyms) | ✅ | — | — | — | — | — |
| `gym:billing` (suscripción SaaS) | ✅ | ✅ | — | — | — | — |
| `gym:branding` / `gym:settings` (incluye sedes, planes y acceso entre sedes) | ✅ | ✅ | ✅ | — | — | — |
| `members:view` | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| `members:create` / `members:edit` | ✅ | ✅ | ✅ | — | — | — |
| `members:delete` | ✅ | ✅ | ✅ | — | — | — |
| `payments:charge` | ✅ | ✅ | ✅ | ✅ | — | — |
| `access:scan` | ✅ | ✅ | ✅ | ✅ | — | — |
| `users:create` | ✅ | ✅ | ✅ | — | — | — |
| `users:role:owner` | ✅ | ✅ | — | — | — | — |
| `users:role:admin` | ✅ | ✅ | — | — | — | — |
| `users:role:recepcion` / `entrenador` / `socio` | ✅ | ✅ | ✅ | — | — | — |
| `reports:view` | ✅ | ✅ | ✅ | — | — | — |
| `audit:view` | ✅ | ✅ | ✅ | — | — | — |
| `data:export` | ✅ | ✅ | ✅ | — | — | — |
| `data:import` | ✅ | ✅ | — | — | — | — |
| `self:card` / `self:pay` / `self:apto` | — | — | — | — | — | ✅ |

Regla de oro: **nadie puede crear un usuario con más permisos que los propios.**
El `<select>` de roles se arma en runtime desde las capabilities del usuario logueado,
y `saveNewUser()` vuelve a validar del lado del "servidor" (no confía en el DOM).

## 4. Aislamiento aplicado

- `scopedMembers() / scopedUsers() / scopedLogs()` filtran por `activeGymId`. Ninguna
  vista lee los arrays crudos. El scope es el **gimnasio**, nunca la sede.
- `findMember()` busca **sólo** dentro del gym activo → un DNI de otro gimnasio no existe.
- El QR embebe `gymId`. Si un socio del Gym A escanea en el Gym B: rojo,
  "credencial de otro gimnasio", y queda en el log.
- El branding se guarda en `gym.branding`, no global. Al loguearse se aplica el tema
  del gym del usuario.
- El backup de un `admin` exporta sólo su tenant. El backup completo es del `superadmin`.
- El `superadmin` entra a un gym explícitamente ("Entrar") y aparece una barra
  de impersonación visible + registro en auditoría.

## 5. Seguridad que se corrigió

1. **Eliminado el master password.** Ahora sólo las cuentas semilla marcadas `isDemo`
   aceptan la clave de demo. Un email inexistente ya no crea sesión.
2. **Hash de contraseñas** (SHA-256 + salt por usuario vía WebCrypto). No se guarda
   la clave en claro; se muestra una sola vez al crearla, para entregársela al usuario.
3. **Validación de rol en el back del portal**: el portal elegido no define el rol.
4. **Auditoría** de acciones sensibles: creación/borrado de usuarios, cambios de rol,
   cobros, cambios de branding, entrada del superadmin a un gym.
5. **Límites del plan SaaS**: `maxMembers` / `maxStaff` se validan al crear.

## 5.b Los dos modos: local y Firebase

La app corre en **modo local** (`localStorage`) o en **modo Firebase**, y se cambia desde
el botón *"Origen de datos"* del login. El badge del header dice en cuál estás.

En modo local el aislamiento es sólo de la UI: cualquiera edita `localStorage` desde
DevTools y se pone `owner`. Sirve para demos y para trabajar sin backend.

En modo Firebase el rol y el `gymId` **no se leen de `localStorage`**: vienen firmados en
los custom claims del token, y la app descarta cualquier rol local que no coincida.
Verificado: con `localStorage` diciendo `owner` y el claim diciendo `recepcion`, la sesión
queda en `recepcion`. Ahí sí el aislamiento es real, porque lo hace `firestore.rules`.

Las operaciones sensibles —crear usuarios, cambiar roles, dar de alta gimnasios, escribir
auditoría— pasan por Cloud Functions con el Admin SDK (`functions/index.js`): son las
únicas que pueden firmar claims. Y en ese modo **nadie fija la contraseña de otro**: se
envía una invitación por email y la persona elige la suya.

Ver `README-firebase.md` para el despliegue.

## 6. Ideas siguientes (priorizadas)

**Alto impacto, poco esfuerzo**
1. Onboarding self-service: alta de gym + prueba de 14 días con `saas.status: "trial"`.
2. Invitación por email con token en lugar de "acá tenés la contraseña".
3. Congelamiento de membresía (vacaciones) sin perder antigüedad.
4. Pases por sesión / clases sueltas con contador de créditos.
5. Reporte de asistencia por franja horaria → detectar horas pico por sede.

**Producto**
6. Turnos de clases con cupo (crossfit, funcional) y lista de espera.
7 Rutinas del entrenador visibles en el carnet del socio (justifica el rol `entrenador`).
8. Cobro real: Mercado Pago Checkout Pro + webhook que marque la cuota al día.
9. Débito automático y recordatorios por WhatsApp Business API (hoy es un `wa.me`).
10. Antipassback: bloquear el mismo QR dos veces en X minutos, y detección de
    credenciales compartidas.

**Infra / plataforma**
11. Firebase Auth con **custom claims** `{ gymId, role }` + las reglas de Firestore.
    Crear usuarios desde una Cloud Function con Admin SDK, nunca desde el cliente
    con una app secundaria como hoy.
12. Dominio o subdominio por gym (`gimnasio.fitaccess.app`) para el white-label.
13. Offline-first en recepción (IndexedDB + cola de sincronización): si se cae internet,
    el molinete tiene que seguir dejando entrar gente.
14. Soft delete + retención de datos (ley 25.326 de datos personales en Argentina:
    el apto médico es dato de salud, requiere consentimiento y borrado a pedido).


## 7. Cuentas de demostración

Clave para todas: `FitAccess123!`. Dos gimnasios distintos, a propósito, para que se
vea el aislamiento: entrá con el admin de uno e intentá encontrar a un socio del otro.

| Portal | Email | Rol | Gimnasio |
|---|---|---|---|
| Consola SaaS | `superadmin@fitaccess.app` | superadmin | — (todos) |
| Staff | `dueno@powerhousegym.com` | owner | Powerhouse Gym |
| Staff | `admin@powerhousegym.com` | admin | Powerhouse Gym |
| Staff | `entrenador@powerhousegym.com` | entrenador | Powerhouse Gym |
| Recepción | `recepcion@powerhousegym.com` | recepcion | Powerhouse Gym |
| Socio | `carlos@powerhousegym.com` | socio | Powerhouse Gym |
| Staff | `dueno@veloxtraining.com` | owner | Velox Training Hub |
| Recepción | `recepcion@veloxtraining.com` | recepcion | Velox Training Hub |
| Socio | `pablo@veloxtraining.com` | socio | Velox Training Hub |

## 8. Qué pasa con los datos que ya tenías

Al abrir la app por primera vez, `Store.migrate()` detecta el formato viejo
(socios sin `gymId`) y hace lo siguiente, una sola vez:

1. Crea un tenant `gym-legacy` con el nombre que tenías en el white-label
   (si decía "FitAccess Club", el gimnasio se va a llamar así →
   **renombralo en Panel Gimnasio → Mi Gimnasio**, ese es el nombre que ven los socios).
2. Le asigna ese `gymId` y una "Sede Principal" a todos los socios.
3. Convierte los planes de texto libre en planes del tenant, con precio editable.
4. El `admin` viejo pasa a `owner` (es el dueño de ese gimnasio).
5. Hashea las contraseñas que estaban en texto plano, conservando el login: cada
   usuario sigue entrando con la misma clave de siempre. Queda registrado en la auditoría.


## 9. PWA: por qué "PWA Activa" era mentira

El repo tenía un `sw.js` y un `manifest.json`, pero la app **no era instalable ni
funcionaba offline**, por tres motivos acumulados:

**1. El `index.html` nunca registraba el service worker.** No había ninguna llamada a
`navigator.serviceWorker.register()`. El archivo estaba en el repo y nunca se ejecutaba.

**2. Aunque se hubiera registrado, no se instalaba.** La lista de precache era:

```js
const ASSETS_TO_CACHE = ["./", "./index.html", "./css/theme.css",
  "./js/app.js", "./js/scanner.js", "./js/white-label.js", "./manifest.json"];
```

Esos `./css/` y `./js/` no existen: la app es un único `index.html` con el CSS y el JS
embebidos. Y `cache.addAll()` es **atómico**: si uno de los pedidos falla, rechaza toda
la promesa, el evento `install` falla y el service worker nunca llega a activarse. Cuatro
404 garantizados.

**3. Los iconos del manifest eran remotos y con el MIME equivocado.** Apuntaban a
`images.unsplash.com` declarando `"type": "image/png"`, pero esa URL con `auto=format`
devuelve JPEG o WebP. Icono no válido para instalar, sin icono offline, y dependiendo de
que un tercero no cambie la foto.

### Cómo quedó

- **Iconos propios**, generados sin dependencias con `tools/make-icons.js` (encoder PNG
  a mano con `zlib`): 192, 512 y una variante `maskable` con más aire, porque Android
  recorta hasta un 20% de cada borde.
- **Precache tolerante a fallos**: cada archivo se cachea por separado.
- **Documento network-first**: todo el código vive en `index.html`, así que cache-first
  significaba no volver a recibir ni un arreglo.
- **Auth, Firestore y Cloud Functions nunca se cachean.** El SW anterior interceptaba
  todo, incluido el canal de escucha de Firestore.
- **jsQR y qrcodejs sí se cachean** en runtime: sin eso el escáner no funciona offline,
  que es justo cuando más falta hace.
- **`theme_color` dinámico**: la barra del navegador toma el color del gimnasio, igual
  que el resto del white-label. Antes el manifest decía `#06b6d4` y el `<meta>` del HTML
  `#14b8a6`.
- **Aviso de actualización** en lugar de recarga forzada, y **barra de sin conexión**
  para que en el mostrador se sepa que está operando con datos locales.

Verificado apagando el servidor y recargando: la app levanta desde el caché, se puede
iniciar sesión, el semáforo responde y el ingreso queda registrado.
