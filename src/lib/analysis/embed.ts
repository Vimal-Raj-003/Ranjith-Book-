/**
 * Sentence embeddings, computed locally.
 *
 * Model: `all-MiniLM-L6-v2` (Apache-2.0), the standard Sentence Transformers
 * model, run in Node through transformers.js + ONNX Runtime — no Python, no
 * GPU, no API key. ~23MB, downloaded once into CACHE_ROOT/models; a 200-page
 * book's ~350 chunks embed in well under a minute on a laptop CPU.
 *
 * Behind an interface so tests (and a machine with no network on first run)
 * use `lexicalEmbedder`, a bag-of-words fallback that is worse at paraphrase
 * but never unavailable. Which one ran is recorded on the analysis, so a
 * degraded run is visible rather than silent.
 */
import path from "node:path";
import { CACHE_ROOT } from "../paths";
import { normalizeToken } from "../ingest/align";

export interface Embedder {
  readonly id: string;
  /** L2-normalised vectors, one per text. */
  embed(texts: string[]): Promise<Float32Array[]>;
}

export const MODEL_ID = "Xenova/all-MiniLM-L6-v2";
export const MODEL_DIR = path.join(CACHE_ROOT, "models");
const BATCH = 32;

type Extractor = (texts: string[], opts: { pooling: "mean"; normalize: boolean }) => Promise<{
  tolist(): number[][];
}>;

let extractor: Promise<Extractor> | null = null;

async function loadExtractor(): Promise<Extractor> {
  const { pipeline, env } = await import("@huggingface/transformers");
  env.cacheDir = MODEL_DIR;
  return (await pipeline("feature-extraction", MODEL_ID, { dtype: "q8" })) as unknown as Extractor;
}

export const transformersEmbedder: Embedder = {
  id: MODEL_ID,
  async embed(texts) {
    if (!extractor) {
      extractor = loadExtractor();
      // A failed load must not poison every later call in this process.
      extractor.catch(() => {
        extractor = null;
      });
    }
    const fe = await extractor;
    const out: Float32Array[] = [];
    for (let i = 0; i < texts.length; i += BATCH) {
      const result = await fe(texts.slice(i, i + BATCH), { pooling: "mean", normalize: true });
      for (const row of result.tolist()) out.push(Float32Array.from(row));
    }
    return out;
  },
};

const STOP = new Set(
  "a an and are as at be but by for from has have he her his i in is it its of on or she so that the their them they this to was we were what when which who will with you your not can do does".split(
    " ",
  ),
);

/** Hashed bag of words. Deterministic, dependency-free, paraphrase-blind. */
export const lexicalEmbedder: Embedder = {
  id: "lexical",
  async embed(texts) {
    const DIM = 512;
    return texts.map((t) => {
      const v = new Float32Array(DIM);
      for (const raw of t.split(/\s+/)) {
        const w = normalizeToken(raw);
        if (w.length < 3 || STOP.has(w)) continue;
        const stem = w.replace(/(ing|ed|es|s)$/, "");
        let h = 2166136261;
        for (let i = 0; i < stem.length; i++) h = Math.imul(h ^ stem.charCodeAt(i), 16777619);
        v[(h >>> 0) % DIM] += 1;
      }
      return normalize(v);
    });
  },
};

function normalize(v: Float32Array): Float32Array {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n);
  if (n > 0) for (let i = 0; i < v.length; i++) v[i] /= n;
  return v;
}

/** Cosine similarity of two normalised vectors. */
export function cosine(a: Float32Array, b: Float32Array): number {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

export function toBytes(v: Float32Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(v.byteLength);
  out.set(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
  return out;
}

export function fromBytes(b: Uint8Array): Float32Array {
  const copy = new Uint8Array(b.byteLength);
  copy.set(b);
  return new Float32Array(copy.buffer);
}

/** Indices of the `k` vectors most similar to `query`, best first. */
export function topK(query: Float32Array, vectors: Float32Array[], k: number): { index: number; score: number }[] {
  return vectors
    .map((v, index) => ({ index, score: cosine(query, v) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}
