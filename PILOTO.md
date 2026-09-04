# Probar FitAccess en un gimnasio real

Guía para la primera prueba con socios de verdad. Leé la sección 1 antes de decidir cómo
lo vas a montar: la elección cambia todo lo demás.

---

## 1. Elegí el modo, porque no son equivalentes

### Piloto A — una tablet en recepción (recomendado para empezar)

Todo corre en un dispositivo, en modo **local**. Los socios reciben una **credencial
impresa con QR fijo**. Recepción escanea o busca por DNI.

- ✅ Cero backend, cero costo, funciona sin internet.
- ✅ Se monta en 15 minutos.
- ✅ Sirve para validar lo que importa: si el flujo del mostrador funciona, si el
  semáforo tiene sentido, si el padrón está bien pensado.
- ⚠️ **Un solo dispositivo.** Los datos viven en ese navegador. Otro celular abre una
  instalación vacía y separada.
- ⚠️ Los socios **no** tienen carnet en el celular ni pueden pagar desde la app.
- ⚠️ Backups manuales. Si se borran los datos del navegador, se pierde todo.
- ⚠️ El QR impreso es fijo: se puede fotografiar y pasar a un amigo. Mitigación: el
  semáforo muestra la foto del socio para comparar, y hay antipassback de 6 segundos.

### Piloto B — Firebase, multi-dispositivo

Los socios entran con su cuenta y llevan el carnet con QR dinámico de 30s en el celular.
Recepción y gerencia ven los mismos datos.

- ✅ Es el producto real.
- ✅ Aislamiento de verdad, del lado del servidor.
- ⚠️ Requiere desplegar `firestore.rules` y crear los usuarios con `tools/admin-cli.js`.
- ⚠️ **El camino nube no está probado contra tu proyecto.** Está escrito y probado con
  un doble de Firebase, pero nunca corrió contra `fitaccess-5ad19`. Vas a encontrar
  fricción.

**Recomendación:** arrancá con A durante una o dos semanas. Que el gimnasio use el
mostrador todos los días. Cuando el flujo esté aceitado y sepas qué falta de verdad,
pasá a B — el mismo archivo hace las dos cosas, se cambia con un botón.

---

## 2. Antes de tocar nada: dos comandos

```bash
curl -o vendor/qrcode.min.js https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js
curl -o vendor/jsQR.js       https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js
```

Sin estas copias locales, la app depende de que el wifi del gimnasio deje salir a un CDN.
Si falla, no hay QR en el carnet ni en las credenciales impresas, y el escáner no lee.
La app te avisa con un cartel naranja si faltan, pero mejor evitarlo.

Commiteálas y publicá en GitHub Pages.

---

## 3. Puesta en marcha (Piloto A)

1. Abrí la app en la tablet, en **Chrome** (la cámara y el service worker andan mejor).
2. Entrá con cualquier cuenta de prueba (`dueno@powerhousegym.com` / `FitAccess123!`).
3. Arriba aparece la barra violeta → **"🏁 Poner en marcha mi gimnasio"**.
4. Completá:
   - nombre real del gimnasio y de la sede
   - los planes con los **precios reales**
   - tu cuenta de dueño con una contraseña propia de 10+ caracteres

Al confirmar: **se borran los dos gimnasios de ejemplo, sus socios y todas las cuentas de
prueba.** La clave pública `FitAccess123!` deja de funcionar. Verificado.

5. Creá el usuario de recepción: **Panel Gimnasio → Usuarios → Crear Usuario**, rol
   *Recepción*. Anotá la contraseña que te muestra: se guarda hasheada y no se vuelve a
   ver.
6. Instalá la app en la tablet: en Chrome, menú → *Instalar aplicación*. Queda como un
   ícono, a pantalla completa, y funciona sin internet.

---

## 4. Cargar el padrón

**Panel Gimnasio → Padrón → ➕ Nuevo Socio.** Por cada socio: nombre, DNI, teléfono,
plan, vencimiento de cuota y estado del apto médico. La foto es opcional pero conviene:
es lo que le permite a recepción confirmar que el que entra es el titular.

Las fotos se comprimen a 480px automáticamente. Sin eso, 100 socios llenan el
almacenamiento del navegador.

Cuando termines: **🖨️ Credenciales** imprime todas las tarjetas, 2 por fila en A4.
Papel de 200g o plastificadas. Cada tarjeta lleva el gimnasio, la sede, la foto, el
número de socio, el DNI, el plan y el QR.

---

## 5. El día a día en el mostrador

Recepción entra por **Portal Recepción** y queda en la vista del escáner.

- **Con credencial:** apuntar el QR a la cámara. El semáforo responde solo.
- **Sin credencial:** escribir el DNI en la búsqueda manual y Enter.

Qué significa cada color:

| | Qué pasó | Qué hace recepción |
|---|---|---|
| 🟢 Verde | Cuota al día y apto vigente | Pasa |
| 🟡 Amarillo | La cuota vence en pocos días | Pasa, y se le avisa |
| 🔴 Rojo · cuota vencida | Debe la cuota | Botón **Cobrar** en el mismo semáforo |
| 🔴 Rojo · apto vencido | Falta el certificado médico | No pasa (esto es responsabilidad legal del gimnasio) |
| 🔴 Rojo · no encontrado | El DNI no está en el padrón | Alta como nuevo socio |

El cobro es un clic: extiende el vencimiento 30 días y queda en la auditoría con quién
lo cobró.

---

## 6. Lo que NO podés dejar de hacer

**Descargar el backup.** En modo local los datos viven sólo en esa tablet. La app te
avisa si pasaron 7 días sin backup, y también si el almacenamiento se está llenando. Si
la escritura falla, salta un cartel bloqueante: **lo último que cargaste no se guardó.**

Rutina mínima: **Panel Gimnasio → Backup → Descargar**, una vez por semana, y el archivo
a Drive o a un mail. Ese mismo JSON es el que después importás a Firebase con
`node tools/admin-cli.js import-backup --file <archivo>`.

**No borres los datos del navegador** ni uses modo incógnito en esa tablet. Y no le
"limpies el caché" al dispositivo sin haber bajado un backup antes.

---

## 7. Datos personales — leelo, son 30 segundos

Vas a manejar nombre, DNI, teléfono y **certificados médicos** de personas reales. En
Argentina el apto médico es dato de salud, que la ley 25.326 clasifica como dato
sensible y protege más que al resto.

Lo mínimo razonable para un piloto:

- Avisale al gimnasio que los datos quedan en esa tablet y que vos tenés los backups.
- Que el socio sepa para qué se le pide el certificado.
- Si un socio pide que borren sus datos, hay que poder hacerlo: el botón 🗑️ del padrón lo
  elimina, y el usuario vinculado queda desactivado.
- Los CSV y backups exportados tienen todo eso adentro. Ya están en `.gitignore`, pero no
  los dejes en Descargas ni los mandes por WhatsApp.

---

## 8. Qué mirar durante el piloto

Anotá estas cinco cosas, que son las que van a definir si el producto sirve:

1. **Cuánto tarda un ingreso.** Del QR al verde. Si son más de 3 segundos, en hora pico
   se hace cola.
2. **Cuántos entran sin credencial.** Si es la mayoría, el QR impreso no sirve y hay que
   ir a Piloto B.
3. **Cuántos rojos por apto vencido.** Suele ser el descubrimiento incómodo: muchos
   gimnasios tienen medio padrón sin apto y nunca lo miraron.
4. **Si recepción usa el botón de cobrar** o sigue anotando en un cuaderno.
5. **Qué pide el dueño en la primera semana.** Eso es tu backlog real, no el que
   imaginaste.

---

## 9. Si algo se rompe

| Síntoma | Causa probable | Qué hacer |
|---|---|---|
| Cartel naranja de QR | No están las copias locales y el CDN está bloqueado | Sección 2 |
| La cámara no arranca | Falta el permiso, o no es HTTPS | Chrome → candado → Cámara → Permitir. GitHub Pages ya es HTTPS |
| "No se pudo guardar" | Almacenamiento del navegador lleno | Backup, y pasar a Piloto B |
| Un socio no aparece | Está en otro gimnasio, o el DNI está mal cargado | Buscar por nombre en el padrón |
| Se perdió todo | Se borraron los datos del navegador | Restaurar el último backup JSON |
| El QR de un socio no abre | Es de otro gimnasio | Correcto: el aislamiento funciona |

Para cualquier cosa rara: **Panel Gimnasio → Auditoría** tiene quién hizo qué y cuándo.
