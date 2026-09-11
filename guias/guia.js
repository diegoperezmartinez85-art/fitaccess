/* ==========================================================================
   PROGRESO DE LAS GUÍAS VISUALES

   Alguien que sigue una guía por primera vez se interrumpe: lo llaman, cierra
   la pestaña, vuelve al otro día. Si al volver perdió las tildes, tiene que
   adivinar dónde había quedado y termina repitiendo pasos o salteándolos.

   Cada guía guarda su propio progreso, con una clave derivada del nombre del
   archivo: así el avance de la guía del dueño no se mezcla con el de recepción.

   `iniciarProgreso(pasos)` recibe los ids que cuentan para la barra de arriba.
   Puede haber tildes que no cuenten —verificaciones sueltas dentro de un
   paso— y por eso la lista es explícita en lugar de contar todos los casilleros.
   ========================================================================== */
function iniciarProgreso(pasos) {
  const CLAVE = "fitaccess_guia_" + (location.pathname.split("/").pop() || "guia");
  const casilleros = document.querySelectorAll(".chk input");
  if (!casilleros.length) return;

  const leer = () => {
    try { return JSON.parse(localStorage.getItem(CLAVE) || "{}"); } catch (e) { return {}; }
  };
  const guardar = d => {
    try { localStorage.setItem(CLAVE, JSON.stringify(d)); } catch (e) { /* modo privado */ }
  };

  function pintar() {
    const d = leer();
    casilleros.forEach(i => {
      i.checked = !!d[i.id];
      const fila = i.closest("li");
      if (fila) fila.classList.toggle("hecho", i.checked);
    });

    const lista = (pasos && pasos.length) ? pasos : [...casilleros].map(i => i.id);
    const hechos = lista.filter(k => d[k]).length;

    const n = document.getElementById("cuenta");
    if (n) n.textContent = hechos;
    const b = document.getElementById("barra");
    if (b) b.style.width = (lista.length ? (hechos / lista.length * 100) : 0) + "%";
  }

  casilleros.forEach(i => {
    i.addEventListener("change", () => {
      const d = leer();
      d[i.id] = i.checked;
      guardar(d);
      pintar();
    });
  });

  pintar();
}

/* Copiar al portapapeles con confirmación visible: sin el cambio de texto no
   hay forma de saber si el clic hizo algo. */
function copiar(btn, texto) {
  const antes = btn.textContent;
  const avisar = t => { btn.textContent = t; setTimeout(() => { btn.textContent = antes; }, 1400); };
  if (navigator.clipboard) {
    navigator.clipboard.writeText(texto).then(() => avisar("copiado")).catch(() => avisar("copialo a mano"));
  } else {
    avisar("copialo a mano");
  }
}

function copiarDe(btn, id) {
  const el = document.getElementById(id);
  if (el) copiar(btn, el.textContent.trim());
}
