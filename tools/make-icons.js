/**
 * Genera los iconos PNG del PWA sin dependencias externas.
 * Los iconos tienen que ser del mismo origen que la app: si apuntan a Unsplash,
 * no hay icono offline y quedás atado a que un tercero no los cambie.
 *
 *   node tools/make-icons.js
 */

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

/* ---------------------------------------------------------------- PNG mínimo */
function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = (crc ^ buf[i]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePNG(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;    // bit depth
  ihdr[9] = 6;    // color type RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  // Cada scanline lleva un byte de filtro adelante.
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }

  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

/* ------------------------------------------------------------------ dibujo */
const BG = [20, 184, 166];      // #14b8a6, el teal de la marca
const FG = [255, 255, 255];

function draw(size, insetRatio) {
  const px = Buffer.alloc(size * size * 4);
  const set = (x, y, c) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2]; px[i + 3] = 255;
  };
  const rect = (x0, y0, x1, y1, c) => {
    for (let y = Math.round(y0); y < Math.round(y1); y++)
      for (let x = Math.round(x0); x < Math.round(x1); x++) set(x, y, c);
  };

  // Fondo a sangre: necesario para que el recorte maskable no deje huecos.
  rect(0, 0, size, size, BG);

  // Mancuerna centrada dentro de la zona segura.
  const s = size * insetRatio;          // lado útil
  const o = (size - s) / 2;             // offset
  const cy = size / 2;
  const barH = s * 0.13;
  const plateW = s * 0.15;
  const plateH = s * 0.52;
  const innerW = s * 0.11;
  const innerH = s * 0.34;

  // barra
  rect(o + plateW * 0.9, cy - barH / 2, o + s - plateW * 0.9, cy + barH / 2, FG);
  // discos externos
  rect(o, cy - plateH / 2, o + plateW, cy + plateH / 2, FG);
  rect(o + s - plateW, cy - plateH / 2, o + s, cy + plateH / 2, FG);
  // discos internos
  rect(o + plateW * 1.05, cy - innerH / 2, o + plateW * 1.05 + innerW, cy + innerH / 2, FG);
  rect(o + s - plateW * 1.05 - innerW, cy - innerH / 2, o + s - plateW * 1.05, cy + innerH / 2, FG);

  return encodePNG(size, size, px);
}

const outDir = path.join(__dirname, "..", "icons");
fs.mkdirSync(outDir, { recursive: true });

// "any": la mancuerna ocupa bastante. "maskable": más aire, porque Android
// recorta hasta un 20% de cada borde.
const files = [
  ["icon-192.png", draw(192, 0.66)],
  ["icon-512.png", draw(512, 0.66)],
  ["icon-maskable-512.png", draw(512, 0.46)],
  ["favicon-64.png", draw(64, 0.7)]
];

files.forEach(([name, buf]) => {
  fs.writeFileSync(path.join(outDir, name), buf);
  console.log(`${name.padEnd(24)} ${(buf.length / 1024).toFixed(1)} KB`);
});
