/*
 * Password-encrypted backups, in plain JavaScript.
 *
 * Why not crypto.subtle: this page is served over plain HTTP on a private
 * address, and browsers expose WebCrypto only to secure contexts, so there it
 * is simply undefined. Only crypto.getRandomValues (the salt) is available
 * there. Everything else below is written out: SHA-256, HMAC, PBKDF2 and
 * AES-256 in CBC mode.
 *
 * The file is what `openssl enc` writes, so a backup can be opened without the
 * stick or this page (the exact command is in docs/API.md):
 *
 *     "Salted__" | 8 salt bytes | AES-256-CBC (PKCS#7) of the XML
 *     key (32 bytes) | iv (16 bytes) = PBKDF2-HMAC-SHA256(password, salt, ITER, 48)
 *
 * OpenSSL does not store the iteration count, so ITER is a constant and part
 * of the format: change it and every older backup needs the old -iter.
 *
 * CBC does not authenticate. A wrong password mostly shows as bad padding, and
 * about one time in 256 as garbage with valid padding, which is why the caller
 * must check that the plaintext parses as a backup before using it.
 */

/* 200000 rounds: about 0.5 s in node on a laptop, a few seconds on a slow
   phone. It is the only brake on guessing a password from a stolen file, so
   it is as high as the wait allows. */
const ITER = 200000;
const MAGIC = 'Salted__';

/* --- SHA-256 (FIPS 180-4) ------------------------------------------------- */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
const IV = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
const W = new Uint32Array(64);

const rotr = (x, n) => (x >>> n) | (x << (32 - n));

/* One 64-byte block, given as 16 big-endian words, folded into state h. */
function compress(h, m) {
  for (let i = 0; i < 16; i++) W[i] = m[i];
  for (let i = 16; i < 64; i++) {
    const a = W[i - 15];
    const b = W[i - 2];
    W[i] = (W[i - 16] + (rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3))
          + W[i - 7] + (rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10))) | 0;
  }
  let [a, b, c, d, e, f, g, hh] = h;

  for (let i = 0; i < 64; i++) {
    const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + W[i]) | 0;
    const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;

    hh = g; g = f; f = e; e = (d + t1) | 0;
    d = c; c = b; b = a; a = (t1 + t2) | 0;
  }
  h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += hh;
}

const words = (bytes, at) => {
  const m = new Uint32Array(16);

  for (let i = 0; i < 16; i++)
    m[i] = (bytes[at + 4 * i] << 24) | (bytes[at + 4 * i + 1] << 16) | (bytes[at + 4 * i + 2] << 8) | bytes[at + 4 * i + 3];
  return m;
};

/* Hash msg, starting from state h0 as if `done` bytes had been hashed already
   (HMAC reuses the state after its key block, which PBKDF2 depends on). */
function sha256From(h0, done, msg) {
  const h = Uint32Array.from(h0);
  const full = msg.length - (msg.length % 64);
  const tail = new Uint8Array(msg.length - full < 56 ? 64 : 128);
  const bits = (done + msg.length) * 8;

  for (let i = 0; i < full; i += 64) compress(h, words(msg, i));
  tail.set(msg.subarray(full));
  tail[msg.length - full] = 0x80;
  tail[tail.length - 4] = (bits >>> 24) & 255;
  tail[tail.length - 3] = (bits >>> 16) & 255;
  tail[tail.length - 2] = (bits >>> 8) & 255;
  tail[tail.length - 1] = bits & 255;
  for (let i = 0; i < tail.length; i += 64) compress(h, words(tail, i));

  const out = new Uint8Array(32);

  for (let i = 0; i < 32; i++) out[i] = h[i >> 2] >>> (24 - 8 * (i & 3));
  return out;
}

const sha256 = (msg) => sha256From(IV, 0, msg);

/* --- HMAC-SHA256 (RFC 2104) and PBKDF2 (RFC 8018) -------------------------- */

/* The states after the inner and outer pad blocks, so that each HMAC call
   costs two compressions instead of four. */
function hmacStates(key) {
  const k = new Uint8Array(64);
  const inner = new Uint8Array(64);
  const outer = new Uint8Array(64);

  k.set(key.length > 64 ? sha256(key) : key);
  for (let i = 0; i < 64; i++) { inner[i] = k[i] ^ 0x36; outer[i] = k[i] ^ 0x5c; }
  const si = Uint32Array.from(IV);
  const so = Uint32Array.from(IV);

  compress(si, words(inner, 0));
  compress(so, words(outer, 0));
  return [si, so];
}

const hmacWith = ([si, so], msg) => sha256From(so, 64, sha256From(si, 64, msg));
const hmacSha256 = (key, msg) => hmacWith(hmacStates(key), msg);

function pbkdf2Sha256(password, salt, iter, len) {
  const st = hmacStates(password);
  const out = new Uint8Array(len);

  for (let block = 1, pos = 0; pos < len; block++, pos += 32) {
    const first = new Uint8Array(salt.length + 4);

    first.set(salt);
    new DataView(first.buffer).setUint32(salt.length, block);
    let u = hmacWith(st, first);
    const t = Uint8Array.from(u);

    for (let i = 1; i < iter; i++) {
      u = hmacWith(st, u);
      for (let j = 0; j < 32; j++) t[j] ^= u[j];
    }
    out.set(t.subarray(0, Math.min(32, len - pos)), pos);
  }
  return out;
}

/* --- AES-256 (FIPS 197) in CBC mode with PKCS#7 padding -------------------- */

/* Multiplication in GF(2^8) with the AES polynomial x^8 + x^4 + x^3 + x + 1. */
function gmul(a, b) {
  let p = 0;

  for (; b; b >>= 1) {
    if (b & 1) p ^= a;
    a = (a << 1) ^ (a & 0x80 ? 0x11b : 0);
  }
  return p & 255;
}

/* The S-box is the multiplicative inverse followed by an affine map; building
   it here is shorter than 256 literals, and the NIST vectors check the result. */
const SBOX = new Uint8Array(256);
const INV = new Uint8Array(256);

for (let x = 0; x < 256; x++) {
  let inv = 0;

  for (let y = 1; y < 256 && x; y++) if (gmul(x, y) === 1) { inv = y; break; }
  let s = inv;

  for (let i = 1; i <= 4; i++) s ^= ((inv << i) | (inv >> (8 - i))) & 255;
  SBOX[x] = s ^ 0x63;
  INV[SBOX[x]] = x;
}

/* 15 round keys of 16 bytes for a 32-byte key. */
function expandKey(key) {
  const w = new Uint8Array(240);

  w.set(key);
  for (let i = 8, rcon = 1; i < 60; i++) {
    const t = w.slice(4 * (i - 1), 4 * i);

    if (i % 8 === 0) {
      t.set([SBOX[t[1]] ^ rcon, SBOX[t[2]], SBOX[t[3]], SBOX[t[0]]]);
      rcon = gmul(rcon, 2);
    } else if (i % 8 === 4) {
      for (let j = 0; j < 4; j++) t[j] = SBOX[t[j]];
    }
    for (let j = 0; j < 4; j++) w[4 * i + j] = w[4 * (i - 8) + j] ^ t[j];
  }
  return w;
}

/* The state is the 16 input bytes in order: byte 4*c + r is row r, column c. */
const addKey = (s, w, round) => { for (let i = 0; i < 16; i++) s[i] ^= w[16 * round + i]; };
/* Row r moves left by r columns when encrypting, right when decrypting. */
const shift = (s, dir) => {
  const t = Uint8Array.from(s);

  for (let r = 1; r < 4; r++)
    for (let c = 0; c < 4; c++) s[4 * ((c + dir * r + 4) % 4) + r] = t[4 * c + r];
};

function mix(s, m) {
  for (let c = 0; c < 16; c += 4) {
    const a = s.slice(c, c + 4);

    for (let r = 0; r < 4; r++)
      s[c + r] = gmul(a[0], m[(4 - r) % 4]) ^ gmul(a[1], m[(5 - r) % 4])
               ^ gmul(a[2], m[(6 - r) % 4]) ^ gmul(a[3], m[(7 - r) % 4]);
  }
}
const MIX = [2, 3, 1, 1];
const UNMIX = [14, 11, 13, 9];

function encryptBlock(s, w) {
  addKey(s, w, 0);
  for (let round = 1; round <= 14; round++) {
    for (let i = 0; i < 16; i++) s[i] = SBOX[s[i]];
    shift(s, -1);
    if (round < 14) mix(s, MIX);
    addKey(s, w, round);
  }
}

function decryptBlock(s, w) {
  addKey(s, w, 14);
  for (let round = 13; round >= 0; round--) {
    shift(s, 1);
    for (let i = 0; i < 16; i++) s[i] = INV[s[i]];
    addKey(s, w, round);
    if (round > 0) mix(s, UNMIX);
  }
}

function cbcEncrypt(key, iv, data) {
  const w = expandKey(key);
  const pad = 16 - (data.length % 16);
  const out = new Uint8Array(data.length + pad);
  let prev = iv;

  out.set(data);
  out.fill(pad, data.length);
  for (let i = 0; i < out.length; i += 16) {
    const s = out.subarray(i, i + 16);

    for (let j = 0; j < 16; j++) s[j] ^= prev[j];
    encryptBlock(s, w);
    prev = s;
  }
  return out;
}

/* Returns null when the padding is wrong, which is how a wrong key shows. */
function cbcDecrypt(key, iv, data) {
  if (!data.length || data.length % 16) return null;
  const w = expandKey(key);
  const out = new Uint8Array(data.length);

  for (let i = 0; i < data.length; i += 16) {
    const s = data.slice(i, i + 16);

    decryptBlock(s, w);
    for (let j = 0; j < 16; j++) out[i + j] = s[j] ^ (i ? data[i - 16 + j] : iv[j]);
  }
  const pad = out[out.length - 1];

  if (pad < 1 || pad > 16) return null;
  for (let i = out.length - pad; i < out.length; i++) if (out[i] !== pad) return null;
  return out.subarray(0, out.length - pad);
}

/* --- the backup file ------------------------------------------------------- */

const utf8 = (s) => new TextEncoder().encode(s);

/* Is this file an OpenSSL-salted one rather than plain XML? */
function isEncrypted(bytes) {
  for (let i = 0; i < MAGIC.length; i++) if (bytes[i] !== MAGIC.charCodeAt(i)) return false;
  return true;
}

function keyAndIv(password, salt, iter) {
  const d = pbkdf2Sha256(utf8(password), salt, iter, 48);

  return [d.subarray(0, 32), d.subarray(32)];
}

/* salt is only for tests; the page always draws a fresh one. */
function encryptBackup(bytes, password, salt, iter = ITER) {
  const s = salt || crypto.getRandomValues(new Uint8Array(8));
  const [key, iv] = keyAndIv(password, s, iter);
  const body = cbcEncrypt(key, iv, bytes);
  const out = new Uint8Array(16 + body.length);

  out.set(utf8(MAGIC));
  out.set(s, 8);
  out.set(body, 16);
  return out;
}

/* The decrypted bytes, or null when the password is wrong (or the file damaged). */
function decryptBackup(bytes, password, iter = ITER) {
  if (!isEncrypted(bytes) || bytes.length < 32) return null;
  const [key, iv] = keyAndIv(password, bytes.subarray(8, 16), iter);

  return cbcDecrypt(key, iv, bytes.subarray(16));
}

export {
  ITER, sha256, hmacSha256, pbkdf2Sha256, cbcEncrypt, cbcDecrypt,
  isEncrypted, encryptBackup, decryptBackup,
};
