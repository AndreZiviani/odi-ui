/*
 * Known-answer tests for web/crypto.js, and a round trip against the openssl
 * command line in both directions (skipped, with a message, without openssl).
 *
 *   node scripts/crypto-check.mjs        (via make check)
 */
import { spawnSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const c = await import(join(root, 'web', 'crypto.js'));

let failed = 0;
const ok = (cond, what) => {
  if (!cond) { failed++; console.error('FAIL: ' + what); }
};
const enc = (s) => new TextEncoder().encode(s);
const hex = (b) => Buffer.from(b).toString('hex');
const unhex = (h) => new Uint8Array(Buffer.from(h.replace(/\s+/g, ''), 'hex'));

/* --- SHA-256: FIPS 180-4 examples -------------------------------------- */
ok(hex(c.sha256(enc('abc'))) === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad', 'sha256 abc');
ok(hex(c.sha256(enc(''))) === 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', 'sha256 empty');
ok(hex(c.sha256(enc('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')))
   === '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1', 'sha256 two-block message');
ok(hex(c.sha256(enc('a'.repeat(55)))) === '9f4390f8d30c2dd92ec9f095b65e2b9ae9b0a925a5258e241c9f1e910f734318', 'sha256 55 bytes (one-block padding edge)');
ok(hex(c.sha256(enc('a'.repeat(56)))) === 'b35439a4ac6f0948b6d6f9e3c6af0f5f590ce20f1bde7090ef7970686ec6738a', 'sha256 56 bytes (padding spills into a second block)');
ok(hex(c.sha256(enc('a'.repeat(1000000)))) === 'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0', 'sha256 a million a');

/* --- HMAC-SHA256: RFC 4231 --------------------------------------------- */
ok(hex(c.hmacSha256(new Uint8Array(20).fill(0x0b), enc('Hi There')))
   === 'b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7', 'hmac case 1');
ok(hex(c.hmacSha256(enc('Jefe'), enc('what do ya want for nothing?')))
   === '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843', 'hmac case 2');
ok(hex(c.hmacSha256(new Uint8Array(20).fill(0xaa), new Uint8Array(50).fill(0xdd)))
   === '773ea91e36800e46854db8ebd09181a72959098b3ef8c122d9635514ced565fe', 'hmac case 3');
ok(hex(c.hmacSha256(new Uint8Array(131).fill(0xaa), enc('Test Using Larger Than Block-Size Key - Hash Key First')))
   === '60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54', 'hmac case 6 (key longer than a block)');

/* --- PBKDF2-HMAC-SHA256: RFC 7914 section 11 --------------------------- */
ok(hex(c.pbkdf2Sha256(enc('passwd'), enc('salt'), 1, 64))
   === '55ac046e56e3089fec1691c22544b605f94185216dde0465e68b9d57c20dacbc49ca9cccf179b645991664b39d77ef317c71b845b1e30bd509112041d3a19783',
   'pbkdf2 passwd/salt/1');
ok(hex(c.pbkdf2Sha256(enc('Password'), enc('NaCl'), 80000, 64))
   === '4ddcd8f60b98be21830cee5ef22701f9641a4418d04c0414aeff08876b34ab56a1d425a1225833549adb841b51c9b3176a272bdebba1d078478f62b397f33c8d',
   'pbkdf2 Password/NaCl/80000');

/* --- AES-256: NIST SP 800-38A F.2.5 and F.2.6 --------------------------- */
const KEY = unhex('603deb1015ca71be2b73aef0857d77811f352c073b6108d72d9810a30914dff4');
const IV = unhex('000102030405060708090a0b0c0d0e0f');
const PLAIN = unhex(`6bc1bee22e409f96e93d7e117393172a ae2d8a571e03ac9c9eb76fac45af8e51
                     30c81c46a35ce411e5fbc1191a0a52ef f69f2445df4f9b17ad2b417be66c3710`);
const CIPHER = unhex(`f58c4c04d6e5f1ba779eabfb5f7bfbd6 9cfc4e967edb808d679f777bc6702c7d
                      39f23369a9d9bacfa530e26304231461 b2eb05e2c39be9fcda6c19078c6a9d1b`);
const sealed = c.cbcEncrypt(KEY, IV, PLAIN);

ok(hex(sealed.subarray(0, 64)) === hex(CIPHER), 'aes-256-cbc encrypt (SP 800-38A F.2.5)');
ok(sealed.length === 80, 'a block-aligned input gets a whole block of padding');
ok(hex(c.cbcDecrypt(KEY, IV, sealed)) === hex(PLAIN), 'aes-256-cbc decrypt (SP 800-38A F.2.6) and padding removed');
ok(c.cbcDecrypt(KEY, IV, sealed.subarray(0, 79)) === null, 'a ragged length is refused');
ok(c.cbcDecrypt(KEY, IV, new Uint8Array(0)) === null, 'empty ciphertext is refused');

/* --- the backup file ----------------------------------------------------- */
const XML = '<Value Name="GPON_SN" Value="ODI012345678"/>\n<Value Name="VLAN_MANU_TAG_VID" Value="110"/>\n';
const SALT = unhex('0001020304050607');
const file = c.encryptBackup(enc(XML), 'correct horse', SALT, 1000);

ok(c.isEncrypted(file) && !c.isEncrypted(enc(XML)), 'Salted__ is told from plain XML');
ok(hex(file.subarray(0, 16)) === '53616c7465645f5f0001020304050607', 'header is Salted__ plus the salt');
ok(Buffer.from(c.decryptBackup(file, 'correct horse', 1000)).toString() === XML, 'a backup decrypts with its password');
const wrong = c.decryptBackup(file, 'correct horsf', 1000);
ok(wrong === null || Buffer.from(wrong).toString() !== XML, 'a wrong password never gives the plaintext');
ok(c.decryptBackup(enc(XML), 'x', 1000) === null, 'a plain file is not decrypted');
ok(c.encryptBackup(enc(XML), 'p', undefined, 1000).length === file.length, 'a fresh salt is drawn when none is given');

/* --- openssl, both directions -------------------------------------------- */
const run = (args, input) => spawnSync('openssl', args, { input, timeout: 30000 });
const probe = run(['version']);

if (probe.error || probe.status !== 0) {
  console.log('SKIP: openssl not available, no round trip against it');
} else {
  const dir = mkdtempSync(join(tmpdir(), 'odi-crypto-'));
  const pw = 'päss w0rd';   /* a non-ASCII password and a space: UTF-8 bytes on both sides */
  const iter = String(c.ITER);
  const big = enc(XML.repeat(1500));   /* ~100 KB: many blocks, a ragged tail */

  try {
    /* openssl takes the password from the environment so it is not on a command line */
    const env = { ...process.env, ODI_PW: pw };
    const ssl = (args) => spawnSync('openssl', args, { env, timeout: 30000 });

    for (const [label, data] of [['small', enc(XML)], ['large', big]]) {
      writeFileSync(join(dir, 'js.enc'), c.encryptBackup(data, pw));
      const d = ssl(['enc', '-d', '-aes-256-cbc', '-pbkdf2', '-iter', iter, '-md', 'sha256',
        '-pass', 'env:ODI_PW', '-in', join(dir, 'js.enc'), '-out', join(dir, 'js.out')]);

      ok(d.status === 0, `openssl reads a ${label} backup written in JS: ${d.stderr}`);
      ok(d.status === 0 && hex(readFileSync(join(dir, 'js.out'))) === hex(data), `openssl decrypts the ${label} JS backup to the same bytes`);

      writeFileSync(join(dir, 'ssl.in'), data);
      const e = ssl(['enc', '-aes-256-cbc', '-pbkdf2', '-iter', iter, '-md', 'sha256',
        '-pass', 'env:ODI_PW', '-in', join(dir, 'ssl.in'), '-out', join(dir, 'ssl.enc')]);

      ok(e.status === 0, `openssl writes a ${label} backup: ${e.stderr}`);
      const back = e.status === 0 ? c.decryptBackup(new Uint8Array(readFileSync(join(dir, 'ssl.enc'))), pw) : null;

      ok(back !== null && hex(back) === hex(data), `JS decrypts the ${label} backup openssl wrote`);
    }
    console.log('openssl round trip done: ' + probe.stdout.toString().trim());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (failed) console.error(failed + ' crypto check(s) failed');
else console.log('crypto checks passed');
process.exit(failed ? 1 : 0);
