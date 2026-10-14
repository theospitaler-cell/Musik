// Nur für Tests: PNG lesen/schreiben ohne Zusatzpakete (8 Bit, Grau/RGB/RGBA/Palette, nicht verschachtelt).
import { inflateSync, deflateSync } from 'node:zlib';
import { readFileSync } from 'node:fs';

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

export function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('kein PNG');
  let p = 8;
  let w = 0;
  let h = 0;
  let depth = 8;
  let ctype = 0;
  let interlace = 0;
  const idat = [];
  let plte = null;
  let trns = null;
  while (p < buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('ascii', p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      depth = data[8];
      ctype = data[9];
      interlace = data[12];
    } else if (type === 'PLTE') plte = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  if (depth !== 8 || interlace) throw new Error(`PNG-Format nicht unterstützt (Tiefe ${depth}, Interlace ${interlace})`);
  const ch = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ctype];
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * ch;
  const px = Buffer.alloc(h * stride);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = px.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? cur[x - ch] : 0;
      const b = prev[x];
      const c = x >= ch ? prev[x - ch] : 0;
      let v = line[x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) v += paeth(a, b, c);
      cur[x] = v & 255;
    }
    prev = cur;
  }
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    let r;
    let g;
    let b;
    let a = 255;
    const o = i * ch;
    if (ctype === 0) r = g = b = px[o];
    else if (ctype === 4) {
      r = g = b = px[o];
      a = px[o + 1];
    } else if (ctype === 2) [r, g, b] = [px[o], px[o + 1], px[o + 2]];
    else if (ctype === 6) [r, g, b, a] = [px[o], px[o + 1], px[o + 2], px[o + 3]];
    else {
      const k = px[o];
      [r, g, b] = [plte[k * 3], plte[k * 3 + 1], plte[k * 3 + 2]];
      if (trns && k < trns.length) a = trns[k];
    }
    data[i * 4] = r;
    data[i * 4 + 1] = g;
    data[i * 4 + 2] = b;
    data[i * 4 + 3] = a;
  }
  return { width: w, height: h, data };
}

export const loadPng = (path) => decodePng(readFileSync(path));

// Graustufen-PNG schreiben (für Sichtprüfung in der Entwicklung)
export function encodeGrayPng({ width, height, gray }) {
  const raw = Buffer.alloc(height * (width + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (width + 1)] = 0;
    Buffer.from(gray.buffer, gray.byteOffset + y * width, width).copy(raw, y * (width + 1) + 1);
  }
  const crcTable = new Uint32Array(256).map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b) => {
    let c = 0xffffffff;
    for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
