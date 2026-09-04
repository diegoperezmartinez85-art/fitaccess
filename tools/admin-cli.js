#!/usr/bin/env node
/**
 * FITACCESS ADMIN CLI
 *
 * Hace desde tu máquina lo que las Cloud Functions harían en el servidor:
 * crear usuarios, firmar custom claims, dar de alta gimnasios y migrar datos.
 * El Admin SDK ignora las reglas de Firestore, así que esto funciona con la
 * base completamente cerrada y sin el plan Blaze.
 *
 * SETUP
 *   1. Firebase Console → Configuración del proyecto → Cuentas de servicio
 *      → "Generar nueva clave privada" → guardar como serviceAccountKey.json
 *      ⚠️ NUNCA commitear ese archivo. Ya está en .gitignore.
 *   2. npm install firebase-admin        (dentro de tools/)
 *
 * USO
 *   node tools/admin-cli.js <comando> [opciones]
 *
 *   init-platform   --email a@b.com
 *   list-gyms
 *   list-users      [--gym <gymId>]
 *   create-gym      --name "Iron Beast" --branch "Sede Centro" --owner-email a@b.com
 *                   --owner-name "Ana Pérez" [--plan pro]
 *   create-user     --gym <gymId> --email a@b.com --name "Nombre" --role recepcion
 *                   [--member SOC-1001] [--branch br-xxx]
 *   set-role        --email a@b.com --role admin
 *   set-active      --email a@b.com --active false
 *   reset-link      --email a@b.com
 *   import-backup   --file fitaccess_backup.json [--dry-run]
 *   fix-claims      (re-firma los claims de todos desde /users, útil tras importar)
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

let admin;
try {
  admin = require("firebase-admin");
} catch (e) {
  console.error("Falta la dependencia. Corré:  cd tools && npm install");
  process.exit(1);
}

/* ------------------------------------------------------------------- setup */
const KEY_PATHS = [
  process.env.GOOGLE_APPLICATION_CREDENTIALS,
  path.join(process.cwd(), "serviceAccountKey.json"),
  path.join(__dirname, "..", "serviceAccountKey.json"),
  path.join(__dirname, "serviceAccountKey.json")
].filter(Boolean);

const keyPath = KEY_PATHS.find(p => { try { return fs.existsSync(p); } catch (e) { return false; } });
if (!keyPath) {
  console.error("No encontré serviceAccountKey.json.\nBuscado en:\n  " + KEY_PATHS.join("\n  "));
  process.exit(1);
}

admin.initializeApp({ credential: admin.credential.cert(require(keyPath)) });
const db = admin.firestore();
const auth = admin.auth();

/* ------------------------------------------------------------------ helpers */
const ROLES = ["owner", "admin", "recepcion", "entrenador", "socio"];
const SAAS_PLANS = ["trial", "starter", "pro", "enterprise"];

function args() {
  const out = { _: [] };
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i++) {
    if (a[i].startsWith("--")) {
      const k = a[i].slice(2);
      const v = (a[i + 1] && !a[i + 1].startsWith("--")) ? a[++i] : "true";
      out[k] = v;
    } else out._.push(a[i]);
  }
  return out;
}

function die(msg) { console.error("✖ " + msg); process.exit(1); }
function ok(msg) { console.log("✔ " + msg); }

function slugify(s) {
  return String(s).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "gym";
}

function tempPassword() { return crypto.randomBytes(24).toString("base64url"); }

/** Crea el Auth user si no existe, y devuelve el uid. */
async function ensureAuthUser(email, name) {
  try {
    const u = await auth.getUserByEmail(email);
    return { uid: u.uid, existed: true };
  } catch (e) {
    if (e.code !== "auth/user-not-found") throw e;
    const u = await auth.createUser({ email, displayName: name || email, password: tempPassword() });
    return { uid: u.uid, existed: false };
  }
}

/** Firma los claims y escribe el espejo en /users/{uid}. Los dos, siempre:
 *  las reglas leen los claims si están, y el documento como puente. */
async function writeIdentity(uid, { email, name, gymId, role, memberId = null, branchId = null, platform = false, active = true }) {
  const claims = platform ? { platform: true } : { gymId, role };
  if (!platform && memberId) claims.memberId = memberId;
  if (!platform && branchId) claims.branchId = branchId;
  await auth.setCustomUserClaims(uid, claims);

  await db.collection("users").doc(uid).set({
    uid, email, name: name || email,
    gymId: platform ? null : gymId,
    role: platform ? "superadmin" : role,
    platform: !!platform,
    memberId: platform ? null : memberId,
    branchId: platform ? null : branchId,
    active,
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });
}

async function auditFrom(gymId, action, detail) {
  if (!gymId) return;
  await db.collection("gyms").doc(gymId).collection("audit").add({
    at: new Date().toISOString(),
    serverAt: admin.firestore.FieldValue.serverTimestamp(),
    actorId: "admin-cli", actorEmail: "admin-cli", actorRole: "system",
    action, detail, entity: "-", entityId: "-"
  });
}

/* ----------------------------------------------------------------- comandos */
const commands = {

  async "init-platform"(a) {
    if (!a.email) die("Falta --email");
    const { uid, existed } = await ensureAuthUser(a.email, "Operador FitAccess");
    await writeIdentity(uid, { email: a.email, name: "Operador FitAccess", platform: true });
    await db.collection("platformOperators").doc(uid).set({
      email: a.email, at: admin.firestore.FieldValue.serverTimestamp()
    });
    ok(`${a.email} es operador de la plataforma (uid ${uid}).`);
    if (!existed) console.log("  Link para que elija su contraseña:\n  " + await auth.generatePasswordResetLink(a.email));
    console.log("  Si ya estaba logueado, tiene que cerrar sesión y volver a entrar.");
  },

  async "list-gyms"() {
    const snap = await db.collection("gyms").get();
    if (snap.empty) return console.log("(sin gimnasios)");
    for (const d of snap.docs) {
      const g = d.data();
      const members = (await d.ref.collection("members").count().get()).data().count;
      const users = (await db.collection("users").where("gymId", "==", d.id).get()).size;
      console.log(`${d.id}  ${(g.name || "?").padEnd(28)} socios:${String(members).padEnd(5)} usuarios:${String(users).padEnd(4)} plan:${(g.saas && g.saas.plan) || "?"} ${g.active === false ? "SUSPENDIDO" : ""}`);
    }
  },

  async "list-users"(a) {
    let q = db.collection("users");
    if (a.gym) q = q.where("gymId", "==", a.gym);
    const snap = await q.get();
    if (snap.empty) return console.log("(sin usuarios)");
    for (const d of snap.docs) {
      const u = d.data();
      let claims = {};
      try { claims = (await auth.getUser(d.id)).customClaims || {}; } catch (e) {}
      const claimTxt = claims.platform ? "platform" : (claims.role ? `${claims.role}@${claims.gymId}` : "SIN CLAIMS");
      console.log(`${(u.email || "?").padEnd(34)} doc:${String(u.role).padEnd(11)} gym:${String(u.gymId).padEnd(22)} claims:${claimTxt}${u.active === false ? " [inactivo]" : ""}`);
    }
  },

  async "create-gym"(a) {
    for (const f of ["name", "branch", "owner-email"]) if (!a[f]) die(`Falta --${f}`);
    const plan = a.plan || "pro";
    if (!SAAS_PLANS.includes(plan)) die(`Plan inválido. Opciones: ${SAAS_PLANS.join(", ")}`);

    const email = String(a["owner-email"]).toLowerCase();
    const dup = await db.collection("users").where("email", "==", email).get();
    if (!dup.empty) die(`${email} ya tiene un usuario. Un email = un gimnasio.`);

    let slug = slugify(a.name);
    if (!(await db.collection("gyms").where("slug", "==", slug).get()).empty) {
      slug = `${slug}-${Date.now().toString(36).slice(-4)}`;
    }

    const gymRef = db.collection("gyms").doc();
    const branchId = `br-${Date.now().toString(36)}`;
    await gymRef.set({
      slug, name: a.name, legalName: "", cuit: "", phone: "", email,
      active: true,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      branding: { primaryColor: "#14b8a6", secondaryColor: "#6366f1", logoUrl: "" },
      branches: [{ id: branchId, name: a.branch, address: "" }],
      plans: [{ id: `pl-${Date.now().toString(36)}`, name: "Plan Mensual", price: 20000 }],
      settings: { currency: "ARS", warnDays: 3, requireApto: true, qrTtlSeconds: 30, crossBranchAccess: true },
      saas: { plan, status: plan === "trial" ? "trial" : "active" }
    });

    const { uid, existed } = await ensureAuthUser(email, a["owner-name"]);
    await writeIdentity(uid, { email, name: a["owner-name"], gymId: gymRef.id, role: "owner" });
    await auditFrom(gymRef.id, "tenant:create", `Alta de ${a.name} con dueño ${email} (admin-cli)`);

    ok(`Gimnasio "${a.name}" creado.`);
    console.log(`  gymId:   ${gymRef.id}\n  slug:    ${slug}\n  sede:    ${branchId}\n  dueño:   ${email}`);
    if (!existed) console.log("  Invitación:\n  " + await auth.generatePasswordResetLink(email));
  },

  async "create-user"(a) {
    for (const f of ["gym", "email", "role"]) if (!a[f]) die(`Falta --${f}`);
    if (!ROLES.includes(a.role)) die(`Rol inválido. Opciones: ${ROLES.join(", ")}`);

    const email = String(a.email).toLowerCase();
    const gym = await db.collection("gyms").doc(a.gym).get();
    if (!gym.exists) die(`El gimnasio ${a.gym} no existe.`);

    const dup = await db.collection("users").where("email", "==", email).get();
    if (!dup.empty) die(`${email} ya tiene un usuario (gym ${dup.docs[0].data().gymId}). Un email = un gimnasio.`);

    if (a.role === "socio" && a.member) {
      const m = await gym.ref.collection("members").doc(a.member).get();
      if (!m.exists) die(`La ficha ${a.member} no existe en ese gimnasio.`);
    }

    const { uid, existed } = await ensureAuthUser(email, a.name);
    await writeIdentity(uid, {
      email, name: a.name, gymId: a.gym, role: a.role,
      memberId: a.member || null, branchId: a.branch || null
    });
    await auditFrom(a.gym, "user:create", `Creó ${email} con rol ${a.role} (admin-cli)`);

    ok(`${email} creado como ${a.role} en ${gym.data().name} (uid ${uid}).`);
    if (!existed) console.log("  Invitación:\n  " + await auth.generatePasswordResetLink(email));
  },

  async "set-role"(a) {
    if (!a.email || !a.role) die("Faltan --email o --role");
    if (!ROLES.includes(a.role)) die(`Rol inválido. Opciones: ${ROLES.join(", ")}`);
    const u = await auth.getUserByEmail(String(a.email).toLowerCase());
    const doc = await db.collection("users").doc(u.uid).get();
    if (!doc.exists) die("Ese usuario no tiene perfil en /users. Usá create-user.");
    const d = doc.data();

    if (d.role === "owner" && a.role !== "owner") {
      const owners = await db.collection("users")
        .where("gymId", "==", d.gymId).where("role", "==", "owner").where("active", "==", true).get();
      if (owners.size <= 1) die("El gimnasio necesita al menos un dueño activo.");
    }

    await writeIdentity(u.uid, { ...d, email: d.email, role: a.role, gymId: d.gymId });
    await auditFrom(d.gymId, "user:role", `${d.email}: ${d.role} → ${a.role} (admin-cli)`);
    ok(`${d.email} ahora es ${a.role}. Tiene que volver a iniciar sesión.`);
  },

  async "set-active"(a) {
    if (!a.email) die("Falta --email");
    const active = a.active !== "false";
    const u = await auth.getUserByEmail(String(a.email).toLowerCase());
    await auth.updateUser(u.uid, { disabled: !active });   // corta la sesión de verdad
    await db.collection("users").doc(u.uid).set({ active }, { merge: true });
    const d = (await db.collection("users").doc(u.uid).get()).data() || {};
    await auditFrom(d.gymId, "user:toggle", `${a.email} ${active ? "reactivado" : "desactivado"} (admin-cli)`);
    ok(`${a.email} ${active ? "activo" : "desactivado"}.`);
  },

  async "reset-link"(a) {
    if (!a.email) die("Falta --email");
    console.log(await auth.generatePasswordResetLink(String(a.email).toLowerCase()));
  },

  /* Sube el backup JSON que exporta el panel (Backup → Descargar).
     Acepta tanto el backup global como el de un solo gimnasio. */
  async "import-backup"(a) {
    if (!a.file) die("Falta --file");
    const dry = a["dry-run"] === "true";
    const data = JSON.parse(fs.readFileSync(a.file, "utf8"));
    const gyms = data.scope === "gym" ? [data.gym] : (data.gyms || []);
    const members = data.members || [];
    const users = data.users || [];
    if (!gyms.length) die("El backup no tiene gimnasios.");

    console.log(`${dry ? "[dry-run] " : ""}${gyms.length} gimnasio(s), ${members.length} socio(s), ${users.length} usuario(s)`);

    for (const g of gyms) {
      const { id, ...gd } = g;
      console.log(`  gym ${id} — ${g.name}`);
      if (!dry) await db.collection("gyms").doc(id).set(gd, { merge: true });

      const mine = members.filter(m => m.gymId === id);
      // Los certificados en base64 pueden pasar el límite de 1 MB por documento.
      let pesados = 0;
      for (const m of mine) {
        const { id: mid, gymId, ...md } = m;
        if (md.aptoFile && md.aptoFile.length > 900000) { delete md.aptoFile; pesados++; }
        if (!dry) await db.collection("gyms").doc(id).collection("members").doc(mid).set(md, { merge: true });
      }
      console.log(`    ${mine.length} socios${pesados ? ` (${pesados} sin el certificado: pesaba más de 900 KB)` : ""}`);
    }

    // Los usuarios se crean en Auth y se les firman los claims.
    for (const u of users) {
      if (!u.email) continue;
      if (u.role === "superadmin") { console.log(`  (salteado ${u.email}: usá init-platform)`); continue; }
      if (dry) { console.log(`  [dry-run] usuario ${u.email} → ${u.role}@${u.gymId}`); continue; }
      try {
        const { uid, existed } = await ensureAuthUser(u.email, u.name);
        await writeIdentity(uid, {
          email: u.email, name: u.name, gymId: u.gymId, role: u.role,
          memberId: u.memberId || null, branchId: u.branchId || null,
          active: u.active !== false
        });
        console.log(`  usuario ${u.email} → ${u.role}@${u.gymId}${existed ? "" : " (nuevo, necesita invitación)"}`);
      } catch (e) {
        console.log(`  ✖ ${u.email}: ${e.message}`);
      }
    }
    ok(dry ? "Dry-run terminado, no se escribió nada." : "Importación terminada.");
    if (!dry) console.log("  Las contraseñas NO se migran: cada uno entra con reset-link.");
  },

  /* Re-firma los claims de todos a partir de /users. Útil si importaste datos
     o si tocaste algo a mano en la consola. */
  async "fix-claims"() {
    const snap = await db.collection("users").get();
    let n = 0;
    for (const d of snap.docs) {
      const u = d.data();
      try {
        await writeIdentity(d.id, {
          email: u.email, name: u.name, gymId: u.gymId, role: u.role,
          memberId: u.memberId || null, branchId: u.branchId || null,
          platform: !!u.platform, active: u.active !== false
        });
        n++;
      } catch (e) { console.log(`  ✖ ${u.email}: ${e.message}`); }
    }
    ok(`${n} usuario(s) con claims al día. Todos tienen que volver a iniciar sesión.`);
  }
};

/* -------------------------------------------------------------------- main */
(async () => {
  const a = args();
  const cmd = a._[0];
  if (!cmd || !commands[cmd]) {
    console.log("Comandos: " + Object.keys(commands).join(", "));
    console.log("Ayuda completa en el encabezado de este archivo.");
    process.exit(cmd ? 1 : 0);
  }
  try {
    await commands[cmd](a);
    process.exit(0);
  } catch (e) {
    die(e.message || String(e));
  }
})();
