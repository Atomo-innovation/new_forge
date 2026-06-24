// MeshCentral-compatible password hashing (from Ylianst/MeshCentral pass.js).
const crypto = require('crypto');

const len = 128;
const iterations = 12000;

function hash(pwd, salt, fn, tag) {
  if (arguments.length === 4) {
    try {
      crypto.pbkdf2(pwd, salt, iterations, len, 'sha384', (err, hashBuf) => {
        fn(err, hashBuf.toString('base64'), tag);
      });
    } catch {
      crypto.pbkdf2(pwd, salt, iterations, len, (err, hashBuf) => {
        fn(err, hashBuf.toString('base64'), tag);
      });
    }
    return;
  }

  tag = fn;
  fn = salt;
  crypto.randomBytes(len, (err, saltBuf) => {
    if (err) return fn(err);
    const saltStr = saltBuf.toString('base64');
    try {
      crypto.pbkdf2(pwd, saltStr, iterations, len, 'sha384', (hashErr, hashBuf) => {
        if (hashErr) return fn(hashErr);
        fn(null, saltStr, hashBuf.toString('base64'), tag);
      });
    } catch {
      crypto.pbkdf2(pwd, saltStr, iterations, len, (hashErr, hashBuf) => {
        if (hashErr) return fn(hashErr);
        fn(null, saltStr, hashBuf.toString('base64'), tag);
      });
    }
  });
}

module.exports = { hash };
