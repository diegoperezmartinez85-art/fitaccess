# Librerías locales

La app usa dos librerías de terceros:

- **qrcodejs** — dibuja el QR de la credencial (carnet en pantalla y tarjetas impresas)
- **jsQR** — lee el QR desde la cámara en recepción

Por defecto se cargan desde un CDN, pero conviene tenerlas acá. Motivos concretos:

1. **El wifi del gimnasio puede bloquear el CDN**, o simplemente no haber internet. Sin
   `qrcodejs` no hay QR en el carnet ni en las credenciales impresas; sin `jsQR` el
   escáner no lee nada y hay que buscar por DNI a mano.
2. **El service worker las cachea mejor**: siendo del mismo origen no hay respuestas
   opacas ni problemas de CORS.
3. Dejás de depender de que un tercero no cambie ni baje el archivo.

## Bajarlas

Desde la raíz del repo:

```bash
curl -o vendor/qrcode.min.js https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js
curl -o vendor/jsQR.js       https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js
```

Commiteálas: son chicas (unos 20 KB y 250 KB) y hacen que la app funcione sola.

El `index.html` ya intenta cargar estas copias primero y sólo cae al CDN si no las
encuentra, así que **no hay que tocar nada más**. Si están, se usan; si no, sigue
funcionando como antes.

## Verificar

Con la app abierta, en la consola del navegador:

```js
console.log("QR:", !!window.QRCode, "Escáner:", !!window.jsQR);
```

Las dos tienen que dar `true`. Si alguna da `false`, la app muestra un aviso naranja
arriba: sin esas librerías el carnet y el escáner no funcionan, aunque el resto de la
app (padrón, cobros, búsqueda por DNI) sigue andando.
