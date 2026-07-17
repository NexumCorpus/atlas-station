// embedding.cjs — Semantic embedding module using @xenova/transformers.
// Uses all-MiniLM-L6-v2 (384-dim, ~23MB quantized) with lazy loading.
// Falls back gracefully: if model unavailable, returns null.
'use strict';

const path = require('path');

let _pipelinePromise = null;

async function _getPipeline() {
  if (!_pipelinePromise) {
    _pipelinePromise = (async () => {
      try {
        const { pipeline, env } = await import('@huggingface/transformers');
        env.cacheDir = path.join(__dirname, '.cache', 'transformers');
        env.allowLocalModels = false;
        return await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', { dtype: 'q8' });
      } catch (e) {
        console.error('[embedding] model load failed:', e.message);
        return null;
      }
    })();
  }
  return _pipelinePromise;
}

async function generateEmbedding(text) {
  const pipe = await _getPipeline();
  if (!pipe || !text) return null;
  try {
    const out = await pipe(String(text), { pooling: 'mean', normalize: true });
    return Array.from(out.data);
  } catch { return null; }
}

function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i]*b[i]; na += a[i]*a[i]; nb += b[i]*b[i]; }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom > 0 ? dot / denom : 0;
}

module.exports = { generateEmbedding, cosineSimilarity };
