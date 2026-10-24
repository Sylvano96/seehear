// Song recognition through Shazam's public "tag" endpoint (the one its apps use).
// The audio itself is never sent: we compute Shazam's audio fingerprint
// (a list of spectral peaks) locally and send only that signature.
// Port of the algorithm reverse-engineered by SongRec (github.com/marin-m/SongRec).

import { DOMAINS, allowedUrl, cleanLyrics, cleanText } from "./safe.js";

export const SAMPLE_RATE = 16000;
const MAX_SECONDS = 12; // Shazam ignores anything longer

// --- Fingerprint ---------------------------------------------------------

const WINDOW = Float32Array.from({ length: 2048 }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * (i + 1)) / 2049));

// Iterative radix-2 FFT of 2048 real samples; returns |X[k]|² for k = 0..1024.
const N = 2048;
const BITS = 11;
const REV = Uint16Array.from({ length: N }, (_, i) => {
  let r = 0;
  for (let b = 0; b < BITS; b++) r |= ((i >> b) & 1) << (BITS - 1 - b);
  return r;
});
const COS = Float64Array.from({ length: N / 2 }, (_, i) => Math.cos((-2 * Math.PI * i) / N));
const SIN = Float64Array.from({ length: N / 2 }, (_, i) => Math.sin((-2 * Math.PI * i) / N));
const re = new Float64Array(N);
const im = new Float64Array(N);

function powerSpectrum(input, out) {
  for (let i = 0; i < N; i++) {
    re[REV[i]] = input[i];
    im[REV[i]] = 0;
  }
  for (let size = 2; size <= N; size <<= 1) {
    const half = size >> 1;
    const step = N / size;
    for (let start = 0; start < N; start += size) {
      for (let k = 0; k < half; k++) {
        const a = start + k;
        const b = a + half;
        const wr = COS[k * step];
        const wi = SIN[k * step];
        const tr = re[b] * wr - im[b] * wi;
        const ti = re[b] * wi + im[b] * wr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
      }
    }
  }
  for (let k = 0; k <= 1024; k++) {
    out[k] = Math.max((re[k] * re[k] + im[k] * im[k]) / (1 << 17), 1e-10);
  }
}

const ring = (size) => Array.from({ length: size }, () => new Float64Array(1025));
const mod = (n, m) => ((n % m) + m) % m;

// `samples`: Int16Array, mono, 16 kHz. Returns { peaks: [[...band 0], …], numberSamples }.
export function fingerprint(samples) {
  const sampleRing = new Int16Array(2048);
  let samplePos = 0;
  const windowed = new Float64Array(2048);
  const ffts = ring(256);
  const spread = ring(256);
  let pos = 0; // shared position of both rings (they advance together)
  let written = 0;
  const peaks = [[], [], [], []];

  for (let chunk = 0; chunk + 128 <= samples.length; chunk += 128) {
    // FFT of the last 2048 samples.
    sampleRing.set(samples.subarray(chunk, chunk + 128), samplePos);
    samplePos = (samplePos + 128) % 2048;
    for (let i = 0; i < 2048; i++) windowed[i] = sampleRing[(i + samplePos) % 2048] * WINDOW[i];
    const fft = ffts[pos];
    powerSpectrum(windowed, fft);

    // Spread peaks in frequency, then in time (into earlier spread frames).
    const cur = spread[pos];
    cur.set(fft);
    for (let i = 0; i < 1023; i++) cur[i] = Math.max(cur[i], cur[i + 1], cur[i + 2]);
    for (let i = 0; i < 1025; i++) {
      let max = cur[i];
      for (const back of [1, 3, 6]) {
        const former = spread[mod(pos - back, 256)];
        former[i] = max = Math.max(former[i], max);
      }
    }
    pos = (pos + 1) % 256;
    written++;

    if (written >= 46) findPeaks();
  }

  function findPeaks() {
    const f46 = ffts[mod(pos - 46, 256)];
    const s49 = spread[mod(pos - 49, 256)];
    for (let bin = 10; bin <= 1014; bin++) {
      const v = f46[bin];
      if (v < 1 / 64 || v < s49[bin - 1]) continue;
      let max = 0;
      for (const o of [-10, -7, -4, -3, 1, 2, 5, 8]) max = Math.max(max, s49[bin + o]);
      if (v <= max) continue;
      for (const o of [-53, -45, 165, 172, 179, 186, 193, 200, 214, 221, 228, 235, 242, 249]) {
        max = Math.max(max, spread[mod(pos + o, 256)][bin - 1]);
      }
      if (v <= max) continue;

      const mag = (x) => Math.log(Math.max(1 / 64, x)) * 1477.3 + 6144;
      const m = mag(v);
      const before = mag(f46[bin - 1]);
      const after = mag(f46[bin + 1]);
      const variation = ((after - before) * 32) / (m * 2 - before - after);
      const correctedBin = Math.trunc(bin * 64 + variation);
      const hz = correctedBin * (SAMPLE_RATE / 2 / 1024 / 64);
      const band = hz < 250 ? -1 : hz < 520 ? 0 : hz < 1450 ? 1 : hz < 3500 ? 2 : hz <= 5500 ? 3 : -1;
      if (band >= 0) peaks[band].push([written - 46, Math.trunc(m), correctedBin]);
    }
  }

  return { peaks, numberSamples: samples.length };
}

// --- Binary signature ------------------------------------------------------

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function encodeSignature({ peaks, numberSamples }) {
  const out = [];
  const u8 = (v) => out.push(v & 0xff);
  const u16 = (v) => out.push(v & 0xff, (v >>> 8) & 0xff);
  const u32 = (v) => out.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);

  const contents = [];
  peaks.forEach((bandPeaks, band) => {
    if (!bandPeaks.length) return;
    out.length = 0;
    let pass = 0;
    for (const [fftPass, magnitude, bin] of bandPeaks) {
      if (fftPass - pass >= 255) {
        u8(0xff);
        u32(fftPass);
        pass = fftPass;
      }
      u8(fftPass - pass);
      u16(magnitude);
      u16(bin);
      pass = fftPass;
    }
    const peakBytes = [...out];
    out.length = 0;
    u32(0x60030040 + band);
    u32(peakBytes.length);
    for (const b of out) contents.push(b);
    for (const b of peakBytes) contents.push(b);
    while (contents.length % 4) contents.push(0);
  });

  out.length = 0;
  u32(0xcafe2580); // magic
  u32(0); // crc32, filled below
  u32(contents.length + 8);
  u32(0x94119c00); // magic
  u32(0); u32(0); u32(0);
  u32(3 << 27); // sample rate id: 3 = 16 kHz
  u32(0); u32(0);
  u32(Math.trunc(numberSamples + SAMPLE_RATE * 0.24));
  u32((15 << 19) + 0x40000);
  u32(0x40000000);
  u32(contents.length + 8);
  const bytes = Uint8Array.from([...out, ...contents]);
  new DataView(bytes.buffer).setUint32(4, crc32(bytes.subarray(8)), true);

  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return `data:audio/vnd.shazam.sig;base64,${btoa(binary)}`;
}

// --- Lookup ------------------------------------------------------------------

// `samples`: Int16Array mono 16 kHz (only the last 12 s are used).
// Resolves to a normalized track, or null when Shazam knows nothing.
export async function recognize(samples, lang = "en-US") {
  const slice = samples.subarray(Math.max(0, samples.length - MAX_SECONDS * SAMPLE_RATE));
  const sig = fingerprint(slice);
  const now = Date.now();
  const country = lang.split("-")[1] || "US";
  const url =
    `https://amp.shazam.com/discovery/v5/${lang.split("-")[0]}/${country}/android/-/tag/` +
    `${crypto.randomUUID().toUpperCase()}/${crypto.randomUUID()}` +
    "?sync=true&webv3=true&sampling=true&connected=&shazamapiversion=v3&sharehub=true&video=v3";
  const res = await fetch(url, {
    method: "POST",
    credentials: "omit",
    headers: { "Content-Type": "application/json", "Content-Language": lang.replace("-", "_") },
    body: JSON.stringify({
      geolocation: { altitude: 300, latitude: 45, longitude: 2 },
      signature: { uri: encodeSignature(sig), samplems: Math.round((slice.length / SAMPLE_RATE) * 1000), timestamp: now },
      timestamp: now,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "Europe/Paris",
    }),
  });
  if (!res.ok) throw new Error(`Shazam ${res.status}`);
  const data = await res.json();
  return data.track ? normalizeTrack(data.track) : null;
}

// Every field is checked before use: expected domains only for URLs, capped
// strings, and identifiers that must match their official format.
function normalizeTrack(t) {
  const sections = Array.isArray(t.sections) ? t.sections : [];
  const meta = Object.fromEntries(
    (sections.find((s) => s.type === "SONG")?.metadata || []).map((m) => [m.title, m.text])
  );
  const lyrics = sections.find((s) => s.type === "LYRICS")?.text || [];
  const preview = t.hub?.actions?.find((a) => a.type === "uri" && /^https?:/.test(a.uri))?.uri || "";
  // The Android hub links to the Apple Music app (intent://…#Intent;…): keep the web part.
  const appleUri = t.hub?.options?.flatMap((o) => o.actions || []).find((a) => /music\.apple\.com/.test(a.uri || ""))?.uri || "";
  const appleMusic = typeof appleUri === "string" ? appleUri.replace(/^intent:\/\//, "https://").replace(/[?#].*$/, "") : "";
  const cover = String(t.images?.coverarthq || t.images?.coverart || "").replace("/400x400cc.", "/800x800cc.");
  const key = String(t.key ?? "");
  const isrc = String(t.isrc ?? "").toUpperCase();
  return {
    key: /^\d{1,20}$/.test(key) ? key : "",
    isrc: /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/.test(isrc) ? isrc : "", // ISO 3901 format
    title: cleanText(t.title),
    artist: cleanText(t.subtitle),
    cover: allowedUrl(cover, DOMAINS.appleMedia),
    genre: cleanText(t.genres?.primary, 60),
    album: cleanText(meta.Album),
    label: cleanText(meta.Label),
    released: cleanText(meta.Released, 40),
    lyrics: cleanLyrics(lyrics),
    preview: allowedUrl(preview, DOMAINS.appleMedia),
    appleMusic: allowedUrl(appleMusic, DOMAINS.appleMusic),
    shazamUrl: allowedUrl(t.url || t.share?.href || "", DOMAINS.shazamPage),
    explicit: Boolean(t.hub?.explicit),
  };
}
