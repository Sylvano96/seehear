import { LISTEN_SECONDS } from "./recordings.js";
import { SAMPLE_RATE, recognize } from "./shazam.js";

export { LISTEN_SECONDS, loadRecording, storeRecording } from "./recordings.js";

// Listens to an audio MediaStream (a tab or the microphone) and tries to work
// out what it is, the way Shazam does: a song lookup every few seconds, stopping
// as soon as one matches. Meanwhile, speech is transcribed so the lyrics (or a
// spoken query) can be searched too.

const ATTEMPT_EVERY = 3; // seconds of new audio between two song lookups

const SpeechRecognition = globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition;

// Transcribing a tab needs SpeechRecognition.start(track), which only recent
// Chromium versions support (older ones would silently listen to the mic).
export const canTranscribeTabs = Boolean(SpeechRecognition && "available" in SpeechRecognition);

/**
 * @param {MediaStream} stream
 * @param {object} options
 * @param {boolean} [options.playback]   keep the audio audible (tab capture mutes the tab)
 * @param {"mic"|"track"|false} [options.transcribe]
 * @param {string} [options.lang]
 * @param {AbortSignal} [options.signal] abort("finish") stops early and keeps the result;
 *   any other abort cancels (resolves with `cancelled: true`)
 * @param {(p: {elapsed: number, level: number, transcript: string, track: object|null}) => void} [options.onProgress]
 */
export async function listen(stream, { playback = false, transcribe = false, lang = "en-US", signal, onProgress } = {}) {
  const ctx = new AudioContext();
  const source = ctx.createMediaStreamSource(stream);
  if (playback) source.connect(ctx.destination);

  // Raw capture at the context's native rate, resampled to 16 kHz on demand.
  const chunks = [];
  let captured = 0;
  let level = 0;
  let peakLevel = 0;
  await ctx.audioWorklet.addModule(new URL("./capture-worklet.js", import.meta.url));
  // channelCount 1 + "explicit": stereo input is mixed down to mono for us.
  const processor = new AudioWorkletNode(ctx, "seehear-capture", {
    numberOfOutputs: 0,
    channelCount: 1,
    channelCountMode: "explicit",
  });
  source.connect(processor);
  processor.port.onmessage = ({ data }) => {
    chunks.push(data);
    captured += data.length;
    let sum = 0;
    for (const v of data) sum += v * v;
    level = Math.min(1, Math.sqrt(sum / data.length) * 4);
    peakLevel = Math.max(peakLevel, level);
  };
  if (ctx.state === "suspended") {
    await Promise.race([ctx.resume().catch(() => {}), new Promise((r) => setTimeout(r, 1500))]);
  }
  if (ctx.state !== "running") {
    // Autoplay policy: the page needs a click before it may process audio.
    source.disconnect();
    processor.disconnect();
    ctx.close();
    throw new Error("The browser blocked audio: press the microphone button to start.");
  }

  const speech = startSpeech(stream, transcribe, lang);
  const seconds = () => captured / ctx.sampleRate;

  let track = null;
  let confidence = null;
  let alternatives = [];
  let lookupError = null;
  let attempted = 0;
  const ticker = setInterval(
    () => onProgress?.({ elapsed: seconds(), level, transcript: speech.text(), track }),
    100
  );

  // Never keep the capture (and its memory) alive for nothing: stop when the
  // source goes away (tab closed, mic unplugged) or after a hard time limit.
  const deadline = Date.now() + (LISTEN_SECONDS + 15) * 1000;
  const sourceGone = () => stream.getAudioTracks().every((t) => t.readyState === "ended") || Date.now() > deadline;

  // A short excerpt can match the wrong song (same artist, another version or
  // a medley): only stop early when two lookups in a row agree; otherwise
  // keep the song matched most often.
  const found = [];
  const lookup = async () => {
    const t = await recognize(await resample(chunks, ctx.sampleRate), lang);
    if (t) found.push(t);
    return t;
  };
  const agreed = () => found.length >= 2 && found.at(-1).key === found.at(-2).key;

  try {
    while (!signal?.aborted && !agreed() && attempted < LISTEN_SECONDS) {
      const next = Math.min(attempted + ATTEMPT_EVERY, LISTEN_SECONDS);
      await waitUntil(() => seconds() >= next || signal?.aborted || sourceGone());
      if (signal?.aborted) break;
      if (seconds() < next) break; // source gone: identify what was heard so far, below
      attempted = next;
      try {
        await lookup();
        lookupError = null;
      } catch (err) {
        lookupError = err; // offline or blocked: keep listening, maybe it recovers
      }
    }
    // Stopped early (by the user or because the source went away): still try
    // with the audio heard since the last lookup. A cancel skips this.
    const cancelled = signal?.aborted && signal.reason !== "finish";
    if (!cancelled && !agreed() && seconds() - attempted >= 2) await lookup().catch(() => null);
    ({ track, confidence, alternatives } = pickTrack(found));
  } finally {
    clearInterval(ticker);
    processor.port.onmessage = null;
    source.disconnect();
    processor.disconnect();
  }

  const transcript = await speech.stop();
  const samples = await resample(chunks, ctx.sampleRate);
  ctx.close();
  return {
    cancelled: Boolean(signal?.aborted) && signal.reason !== "finish",
    track,
    confidence,
    alternatives,
    transcript,
    samples,
    durationMs: Math.round((samples.length / SAMPLE_RATE) * 1000),
    silent: peakLevel < 0.01,
    error: track ? null : lookupError?.message || null,
  };
}

// Most frequent match wins (ties: the latest, heard on the longest excerpt).
// "high" confidence = matched at least twice.
function pickTrack(found) {
  if (!found.length) return { track: null, confidence: null, alternatives: [] };
  const byKey = new Map();
  found.forEach((t, i) => byKey.set(t.key, { track: t, count: (byKey.get(t.key)?.count || 0) + 1, last: i }));
  const ranked = [...byKey.values()].sort((a, b) => b.count - a.count || b.last - a.last);
  return {
    track: ranked[0].track,
    confidence: ranked[0].count >= 2 ? "high" : "low",
    alternatives: ranked.slice(1).map((r) => r.track),
  };
}

function waitUntil(test) {
  return new Promise((resolve) => {
    const check = () => (test() ? resolve() : setTimeout(check, 100));
    check();
  });
}

// Float32 chunks at `rate` → Int16Array mono at 16 kHz, cleaned up for the
// fingerprint (OfflineAudioContext also applies a proper anti-aliasing filter):
// - a high-pass filter removes rumble, hum and wind noise below the 250 Hz the
//   fingerprint starts at, which would otherwise eat the headroom;
// - the volume is normalized: the fingerprint ignores spectral peaks under an
//   absolute threshold, so a quiet tab or a distant mic gives far fewer peaks.
export async function resample(chunks, rate, { enhance = true } = {}) {
  const length = chunks.reduce((n, c) => n + c.length, 0);
  if (!length) return new Int16Array(0);
  const offline = new OfflineAudioContext(1, Math.ceil((length * SAMPLE_RATE) / rate), SAMPLE_RATE);
  const buffer = offline.createBuffer(1, length, rate);
  const channel = buffer.getChannelData(0);
  let offset = 0;
  for (const c of chunks) {
    channel.set(c, offset);
    offset += c.length;
  }
  const node = offline.createBufferSource();
  node.buffer = buffer;
  let last = node;
  if (enhance) {
    // Two cascaded 2nd-order filters = a steep 4th-order cut below ~120 Hz.
    for (let i = 0; i < 2; i++) {
      const highpass = offline.createBiquadFilter();
      highpass.type = "highpass";
      highpass.frequency.value = 120;
      highpass.Q.value = 0.7;
      last.connect(highpass);
      last = highpass;
    }
  }
  last.connect(offline.destination);
  node.start();
  const out = (await offline.startRendering()).getChannelData(0);
  const gain = enhance ? normalizationGain(out) : 1;
  return Int16Array.from(out, (v) => Math.max(-32768, Math.min(32767, Math.round(v * gain * 32767))));
}

// Gain that brings the loud parts of the signal to a healthy level. Based on a
// high percentile rather than the absolute peak, so one click or pop doesn't
// stop a quiet recording from being raised; capped at +30 dB to avoid turning
// pure background noise into "music".
function normalizationGain(samples) {
  const step = Math.max(1, Math.floor(samples.length / 20000)); // a sample of the values is enough
  const levels = [];
  for (let i = 0; i < samples.length; i += step) levels.push(Math.abs(samples[i]));
  levels.sort((a, b) => a - b);
  const loud = levels[Math.floor(levels.length * 0.995)] || 0;
  if (loud < 1e-5) return 1; // silence: nothing to raise
  return Math.min(0.5 / loud, 31.6);
}

// Live speech-to-text. Never throws: if the browser can't transcribe, text stays empty.
function startSpeech(stream, mode, lang) {
  const finals = [];
  let interim = "";
  let ended = Promise.resolve();
  let rec = null;

  const usable = mode === "mic" ? Boolean(SpeechRecognition) : mode === "track" && canTranscribeTabs;
  if (usable) {
    try {
      rec = new SpeechRecognition();
      rec.lang = lang;
      rec.continuous = true;
      rec.interimResults = true;
      rec.onresult = (e) => {
        interim = "";
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const text = e.results[i][0].transcript.trim();
          if (e.results[i].isFinal) finals[i] = text;
          else interim += " " + text;
        }
      };
      ended = new Promise((resolve) => {
        rec.onend = resolve;
        rec.onerror = resolve;
      });
      if (mode === "track") rec.start(stream.getAudioTracks()[0]);
      else rec.start();
    } catch {
      rec = null;
      ended = Promise.resolve();
    }
  }

  const text = () => [...finals.filter(Boolean), interim.trim()].filter(Boolean).join(" ");
  return {
    text,
    async stop() {
      if (rec) {
        try {
          rec.stop();
        } catch {}
        // Give the recognizer a moment to deliver its last final result.
        await Promise.race([ended, new Promise((r) => setTimeout(r, 1500))]);
      }
      return text();
    },
  };
}

// --- Storage (session only, like images) --------------------------------

export function samplesToBase64(samples) {
  const bytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export function base64ToSamples(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Int16Array(bytes.buffer);
}
