const { encode, decode, verifyShards } = require('E:/atlas-station/shard-codec.cjs');
const crypto = require('crypto');
let pass = 0, fail = 0;
function t(name, cond) { cond ? pass++ : (fail++, console.log('FAIL: ' + name)); }

// 1. Round-trip with checksums
const payload = crypto.randomBytes(1000);
const enc = encode(payload, 4, 6);
t('encode returns checksums', Array.isArray(enc.checksums) && enc.checksums.length === 6);
t('checksums match shards', enc.shards.every((s,i) => crypto.createHash('sha256').update(s).digest('hex') === enc.checksums[i]));
const rec = decode(Object.fromEntries(enc.shards.slice(0,4).map((s,i)=>[i,s])), 4, 6, 1000);
t('round-trip byte-exact', rec.equals(payload));

// 2. Corrupt one shard -> verifyShards names it
const bad = Buffer.from(enc.shards[2]); bad[7] ^= 0xFF;
const frags = Object.fromEntries(enc.shards.map((s,i)=>[i, i===2?bad:s]).slice(0,5));
const v = verifyShards(frags, enc.checksums);
t('corruption detected', !v.ok && JSON.stringify(v.corrupt) === '[2]');

const goodFrags = {}; let gi = 0;
enc.shards.forEach((s,i)=>{ if(i!==2 && gi<4){ goodFrags[i]=s; gi++; } });
const rec2 = decode(goodFrags, 4, 6, 1000);
t('recovery from survivors after excluding corrupt shard', rec2.equals(payload));

// 4. Backward compat: legacy unsealed fragments still verify ok (no checksums)
const legacy = encode(Buffer.from('legacy'), 2, 3);
delete legacy.checksums;
t('legacy verifyShards no-op', verifyShards({0:legacy.shards[0],1:legacy.shards[1]}, null).ok);

// 5. Empty input edge
const e = encode(Buffer.alloc(0), 3, 5);
const r3 = decode({0:e.shards[0],1:e.shards[1],2:e.shards[2]}, 3, 5, 0);
t('empty input round-trip', r3.length === 0);



// 8. decodeVerified: corrupt fragment excluded before reconstruction
{
  const { decodeVerified } = require('E:/atlas-station/shard-codec.cjs');
  const enc = encode(Buffer.from('decode-verified integrity payload'), 2, 4);
  const frags = { 0: enc.shards[0], 1: enc.shards[1], 2: enc.shards[2], 3: Buffer.from(enc.shards[3]) };
  frags[0][0] ^= 0xff; // bit-rot shard 0
  const r = decodeVerified(frags, enc.checksums, 2, 4, Buffer.byteLength('decode-verified integrity payload'));
  t('dv excludes corrupt & recovers from survivors', r.data.toString() === 'decode-verified integrity payload' && JSON.stringify(r.excluded) === '[0]');
  let threw = false;
  try { decodeVerified({0:frags[0],1:frags[1]}, enc.checksums, 2, 4, Buffer.byteLength('decode-verified integrity payload')); } catch (e) { threw = /insufficient verified/.test(e.message); }
  t('dv refuses when corruption drops below k', threw);
}

console.log(`pass=${pass} fail=${fail}`);