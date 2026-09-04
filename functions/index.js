/**
 * FitAccess — Cloud Functions
 *
 * Por qué existe este archivo: el rol y el gymId de un usuario tienen que
 * viajar FIRMADOS en el token (custom claims). Los custom claims sólo los puede
 * escribir el Admin SDK, o sea el backend. Desde el navegador es imposible, y
 * `firestore.rules` bloquea a propósito la escritura de /users y de la
 * auditoría, para que nadie se autoasigne permisos desde la consola del
 * navegador.
 *
 * Claims que se firman acá:
 *   { platform: true }                                    → operador del SaaS
 *   { gymId, role, memberId?, branchId? }                  → usuario de un gym
 *
 * Deploy:
 *   cd functions && npm install
 *   firebase deploy --only functions,firestore:rules
 */

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { setGlobalOptions } = require("firebase-functions/v2");
const admin = require("firebase-admin");

admin.initializeApp();
const db = admin.firestore();
const auth = admin.auth();

/* Orígenes autorizados a llamar estas funciones.
   ⚠️ REEMPLAZAR por tu dominio real de GitHub Pages, por ejemplo:
     "https://tuusuario.github.io"
   Si la app vive en un subdirectorio (tuusuario.github.io/fitaccess/), el
   origen sigue siendo el dominio, sin la ruta. */
const ALLOWED_ORIGINS = [
  "https://REEMPLAZAR.github.io",
  "https://fitaccess-5ad19.web.app",
  "https://fitaccess-5ad19.firebaseapp.com",
  "http://localhost:8099",
  "http://127.0.0.1:8099"
];

// Región cercana para bajar latencia en Argentina.
setGlobalOptions({ region: "southamerica-east1", maxInstances: 10, cors: ALLOWED_ORIGINS });

/* ==========================================================================
   RBAC — la misma matriz que el frontend, revalidada en el servidor.
   El cliente no es fuente de verdad: acá se vuelve a chequear todo.
   ========================================================================== */

const ROLES = ["owner", "admin", "recepcion", "entrenador", "socio"];

// Qué roles puede crear/administrar cada rol. Nadie puede crear a un igual o
// superior, salvo el dueño (que puede nombrar otro dueño) y la plataforma.
const CAN_ASSIGN = {
  owner: ["owner", "admin", "recepcion", "entrenador", "socio"],
  admin: ["recepcion", "entrenador", "socio"]
};

const SAAS_PLANS = {
  trial:      { maxMembers: 100,      maxStaff: 3 },
  starter:    { maxMembers: 300,      maxStaff: 5 },
  pro:        { maxMembers: 1000,     maxStaff: 15 },
  enterprise: { maxMembers: Infinity, maxStaff: Infinity }
};

function requireAuth(req) {
  if (!req.auth) throw new HttpsError("unauthenticated", "Tenés que iniciar sesión.");
  return req.auth;
}

function isPlatform(req) {
  return req.auth && req.auth.token && req.auth.token.platform === true;
}

/** Devuelve el rol del llamante EN ESE gimnasio, o null. */
function callerRoleIn(req, gymId) {
  const t = (req.auth && req.auth.token) || {};
  if (t.platform === true) return "platform";
  return t.gymId === gymId ? t.role || null : null;
}

function requireManager(req, gymId) {
  const role = callerRoleIn(req, gymId);
  if (role === "platform") return role;
  if (role !== "owner" && role !== "admin") {
    throw new HttpsError("permission-denied", "No administrás ese gimnasio.");
  }
  return role;
}

function assertCanAssign(callerRole, targetRole) {
  if (callerRole === "platform") return;
  const allowed = CAN_ASSIGN[callerRole] || [];
  if (!allowed.includes(targetRole)) {
    throw new HttpsError("permission-denied", `Tu rol no puede asignar el rol ${targetRole}.`);
  }
}

function assertValidRole(role) {
  if (!ROLES.includes(role)) throw new HttpsError("invalid-argument", `Rol inválido: ${role}.`);
}

function cleanEmail(email) {
  const e = String(email || "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) throw new HttpsError("invalid-argument", "Email inválido.");
  return e;
}

async function writeAudit(gymId, actor, action, detail, entity = "-", entityId = "-") {
  await db.collection("gyms").doc(gymId).collection("audit").add({
    at: new Date().toISOString(),
    serverAt: admin.firestore.FieldValue.serverTimestamp(),
    actorId: actor.uid,
    actorEmail: actor.token.email || "-",
    actorRole: actor.token.platform ? "superadmin" : actor.token.role || "-",
    action, detail, entity, entityId
  });
}

/** Link de invitación: la persona elige su propia contraseña. Nadie más la sabe. */
async function inviteLinkFor(email) {
  try {
    return await auth.generatePasswordResetLink(email);
  } catch (e) {
    console.warn("No se pudo generar el link de invitación", e);
    return null;
  }
}

/* ==========================================================================
   createGymUser — alta de un usuario dentro de un gimnasio
   ========================================================================== */
exports.createGymUser = onCall(async (req) => {
  const actor = requireAuth(req);
  const { gymId, name, role, memberId = null, branchId = null } = req.data || {};
  const email = cleanEmail(req.data && req.data.email);

  if (!gymId) throw new HttpsError("invalid-argument", "Falta gymId.");
  assertValidRole(role);
  const callerRole = requireManager(req, gymId);
  assertCanAssign(callerRole, role);

  const gymRef = db.collection("gyms").doc(gymId);
  const gymSnap = await gymRef.get();
  if (!gymSnap.exists) throw new HttpsError("not-found", "El gimnasio no existe.");
  const gym = gymSnap.data();
  if (gym.active === false) throw new HttpsError("failed-precondition", "El gimnasio está suspendido.");

  // Un email = un usuario. Firebase Auth lo impone; acá damos un error claro.
  try {
    const existing = await auth.getUserByEmail(email);
    const claims = existing.customClaims || {};
    throw new HttpsError("already-exists", claims.gymId && claims.gymId !== gymId
      ? "Ese correo ya está en uso en otro gimnasio de la plataforma. Usá otro."
      : "Ese correo ya tiene un usuario.");
  } catch (e) {
    if (e instanceof HttpsError) throw e;
    if (e.code !== "auth/user-not-found") throw new HttpsError("internal", e.message);
  }

  // Límite de staff del plan SaaS, revalidado en el servidor.
  if (role !== "socio") {
    const plan = SAAS_PLANS[(gym.saas && gym.saas.plan) || "pro"] || SAAS_PLANS.pro;
    if (plan.maxStaff !== Infinity) {
      const staff = await db.collection("users")
        .where("gymId", "==", gymId).where("active", "==", true).get();
      const count = staff.docs.filter(d => (d.data().role || "socio") !== "socio").length;
      if (count >= plan.maxStaff) {
        throw new HttpsError("resource-exhausted", `El plan permite ${plan.maxStaff} usuarios de staff.`);
      }
    }
  }

  // Si es socio, la ficha tiene que existir y ser de ESE gimnasio.
  if (role === "socio" && memberId) {
    const m = await gymRef.collection("members").doc(memberId).get();
    if (!m.exists) throw new HttpsError("not-found", "Esa ficha de socio no existe en este gimnasio.");
  }

  // Contraseña aleatoria descartable: la real la elige la persona por el link.
  const user = await auth.createUser({
    email,
    displayName: name || email,
    password: require("crypto").randomBytes(24).toString("base64url"),
    emailVerified: false
  });

  const claims = { gymId, role };
  if (memberId) claims.memberId = memberId;
  if (branchId) claims.branchId = branchId;
  await auth.setCustomUserClaims(user.uid, claims);

  await db.collection("users").doc(user.uid).set({
    uid: user.uid, email, name: name || email,
    gymId, role, memberId, branchId,
    active: true,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    createdBy: actor.uid
  });

  await writeAudit(gymId, actor, "user:create", `Creó el usuario ${email} con rol ${role}`, "user", user.uid);

  return { uid: user.uid, email, inviteLink: await inviteLinkFor(email) };
});

/* ==========================================================================
   setGymUserRole — cambio de rol
   ========================================================================== */
exports.setGymUserRole = onCall(async (req) => {
  const actor = requireAuth(req);
  const { uid, gymId, role, memberId = null, branchId = null } = req.data || {};
  if (!uid || !gymId) throw new HttpsError("invalid-argument", "Faltan uid o gymId.");
  assertValidRole(role);

  const callerRole = requireManager(req, gymId);
  const target = await db.collection("users").doc(uid).get();
  if (!target.exists) throw new HttpsError("not-found", "El usuario no existe.");
  const t = target.data();
  if (t.gymId !== gymId) throw new HttpsError("permission-denied", "Ese usuario no es de tu gimnasio.");

  // No se puede tocar a alguien de rango mayor, ni asignar por encima del propio.
  assertCanAssign(callerRole, t.role);
  assertCanAssign(callerRole, role);
  if (actor.uid === uid) throw new HttpsError("failed-precondition", "No podés cambiarte el rol a vos mismo.");

  // El gimnasio conserva al menos un dueño activo.
  if (t.role === "owner" && role !== "owner") {
    const owners = await db.collection("users")
      .where("gymId", "==", gymId).where("role", "==", "owner").where("active", "==", true).get();
    if (owners.size <= 1) throw new HttpsError("failed-precondition", "El gimnasio necesita al menos un dueño.");
  }

  const claims = { gymId, role };
  if (memberId) claims.memberId = memberId;
  if (branchId) claims.branchId = branchId;
  await auth.setCustomUserClaims(uid, claims);
  await db.collection("users").doc(uid).update({ role, memberId, branchId, updatedAt: admin.firestore.FieldValue.serverTimestamp() });

  await writeAudit(gymId, actor, "user:role", `Cambió el rol de ${t.email} de ${t.role} a ${role}`, "user", uid);
  return { ok: true, revokeNote: "El token viejo sigue válido hasta 1 hora; la app debe refrescarlo." };
});

/* ==========================================================================
   setGymUserActive — activar / desactivar
   ========================================================================== */
exports.setGymUserActive = onCall(async (req) => {
  const actor = requireAuth(req);
  const { uid, gymId, active } = req.data || {};
  if (!uid || !gymId || typeof active !== "boolean") {
    throw new HttpsError("invalid-argument", "Faltan uid, gymId o active.");
  }
  const callerRole = requireManager(req, gymId);
  if (actor.uid === uid) throw new HttpsError("failed-precondition", "No podés desactivarte a vos mismo.");

  const target = await db.collection("users").doc(uid).get();
  if (!target.exists) throw new HttpsError("not-found", "El usuario no existe.");
  const t = target.data();
  if (t.gymId !== gymId) throw new HttpsError("permission-denied", "Ese usuario no es de tu gimnasio.");
  assertCanAssign(callerRole, t.role);

  if (t.role === "owner" && active === false) {
    const owners = await db.collection("users")
      .where("gymId", "==", gymId).where("role", "==", "owner").where("active", "==", true).get();
    if (owners.size <= 1) throw new HttpsError("failed-precondition", "El gimnasio necesita al menos un dueño activo.");
  }

  // Deshabilitar en Auth corta la sesión de verdad, no sólo en la UI.
  await auth.updateUser(uid, { disabled: !active });
  await db.collection("users").doc(uid).update({ active, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
  await writeAudit(gymId, actor, "user:toggle", `${active ? "Reactivó" : "Desactivó"} a ${t.email}`, "user", uid);
  return { ok: true };
});

/* ==========================================================================
   createGym — alta de un tenant (sólo la plataforma)
   ========================================================================== */
exports.createGym = onCall(async (req) => {
  const actor = requireAuth(req);
  if (!isPlatform(req)) throw new HttpsError("permission-denied", "Sólo el operador de la plataforma da de alta gimnasios.");

  const { name, branchName, saasPlan = "pro", ownerName } = req.data || {};
  const ownerEmail = cleanEmail(req.data && req.data.ownerEmail);
  if (!name || !branchName) throw new HttpsError("invalid-argument", "Faltan el nombre del gimnasio o la sede.");
  if (!SAAS_PLANS[saasPlan]) throw new HttpsError("invalid-argument", "Plan SaaS inválido.");

  try {
    await auth.getUserByEmail(ownerEmail);
    throw new HttpsError("already-exists", "Ese correo ya está en uso en la plataforma.");
  } catch (e) {
    if (e instanceof HttpsError) throw e;
    if (e.code !== "auth/user-not-found") throw new HttpsError("internal", e.message);
  }

  const slugBase = String(name).toLowerCase().normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "gym";
  const dup = await db.collection("gyms").where("slug", "==", slugBase).get();
  const slug = dup.empty ? slugBase : `${slugBase}-${Date.now().toString(36).slice(-4)}`;

  const gymRef = db.collection("gyms").doc();
  const branchId = `br-${Date.now().toString(36)}`;
  await gymRef.set({
    slug, name,
    legalName: "", cuit: "", phone: "", email: ownerEmail,
    active: true,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    branding: { primaryColor: "#14b8a6", secondaryColor: "#6366f1", logoUrl: "" },
    branches: [{ id: branchId, name: branchName, address: "" }],
    plans: [{ id: `pl-${Date.now().toString(36)}`, name: "Plan Mensual", price: 20000 }],
    settings: { currency: "ARS", warnDays: 3, requireApto: true, qrTtlSeconds: 30, crossBranchAccess: true },
    saas: { plan: saasPlan, status: saasPlan === "trial" ? "trial" : "active" }
  });

  const owner = await auth.createUser({
    email: ownerEmail,
    displayName: ownerName || ownerEmail,
    password: require("crypto").randomBytes(24).toString("base64url")
  });
  await auth.setCustomUserClaims(owner.uid, { gymId: gymRef.id, role: "owner" });
  await db.collection("users").doc(owner.uid).set({
    uid: owner.uid, email: ownerEmail, name: ownerName || ownerEmail,
    gymId: gymRef.id, role: "owner", memberId: null, branchId: null,
    active: true,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    createdBy: actor.uid
  });

  await writeAudit(gymRef.id, actor, "tenant:create", `Alta del gimnasio ${name} con dueño ${ownerEmail}`, "gym", gymRef.id);

  return { gymId: gymRef.id, slug, ownerUid: owner.uid, inviteLink: await inviteLinkFor(ownerEmail) };
});

/* ==========================================================================
   setPlatformOperator — bootstrap: darte a vos mismo el claim de plataforma.
   Se corre UNA vez y después conviene borrar o comentar esta función.
   ========================================================================== */
exports.setPlatformOperator = onCall(async (req) => {
  const actor = requireAuth(req);

  const existing = await db.collection("platformOperators").limit(1).get();
  if (!existing.empty && !isPlatform(req)) {
    throw new HttpsError("permission-denied", "Ya hay un operador de plataforma. Pedile a él que te habilite.");
  }

  const email = cleanEmail(req.data && req.data.email ? req.data.email : actor.token.email);
  const user = await auth.getUserByEmail(email);
  await auth.setCustomUserClaims(user.uid, { platform: true });
  await db.collection("platformOperators").doc(user.uid).set({
    email, at: admin.firestore.FieldValue.serverTimestamp(), by: actor.uid
  });
  return { ok: true, uid: user.uid, note: "Cerrá sesión y volvé a entrar para que el token traiga el claim." };
});
