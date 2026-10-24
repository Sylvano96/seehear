import { SAMPLE_RATE, recognize } from "../lib/shazam.js";
import {
  LISTEN_SECONDS,
  base64ToSamples,
  canTranscribeTabs,
  listen,
  loadRecording,
  samplesToBase64,
  storeRecording,
} from "../lib/listen.js";
import { searchYouTube } from "../lib/insights.js";
import { deezerPreview, enrichTrack } from "../lib/music.js";
import { updateEntry } from "../lib/session.js";
import { $, hideSocial, linkPill, renderSocial, toast, videoCard, videoMessage, videoSkeletons } from "./ui.js";

const lang = navigator.language || "en-US";
const enc = encodeURIComponent;
const params = new URLSearchParams(location.search);
let recordingId = params.get("id");
let entry = null;
let samples = null;
let controller = null;

// Links for a typed query or what was heard: lyrics are best found with an
// exact-phrase search.
const SEARCH_LINKS = [
  { name: "YouTube", url: (q) => `https://www.youtube.com/results?search_query=${enc(q)}` },
  { name: "Google", url: (q) => `https://www.google.com/search?q=${enc(q)}` },
  { name: "Exact phrase", url: (q) => `https://www.google.com/search?q=${enc(`"${q}"`)}` },
  { name: "Lyrics", url: (q) => `https://www.google.com/search?q=${enc(`${q} lyrics`)}` },
  { name: "Wikipedia", url: (q) => `https://en.wikipedia.org/w/index.php?search=${enc(q)}` },
  { name: "News", url: (q) => `https://news.google.com/search?q=${enc(q)}&hl=en` },
];

const SERVICES = [
  { name: "Spotify", color: "#1db954", url: (t, q) => `https://open.spotify.com/search/${enc(q)}` },
  { name: "Apple Music", color: "#fa2d48", url: (t, q) => t.appleMusic || `https://music.apple.com/search?term=${enc(q)}` },
  { name: "Deezer", color: "#a238ff", url: (t, q) => t.extra?.deezerUrl || `https://www.deezer.com/search/${enc(q)}` },
  { name: "YouTube Music", color: "#ff0033", url: (t, q) => `https://music.youtube.com/search?q=${enc(q)}` },
  { name: "YouTube", color: "#ff0033", url: (t, q) => `https://www.youtube.com/results?search_query=${enc(q)}` },
  { name: "Shazam", color: "#0a84ff", url: (t) => t.shazamUrl },
  { name: "Lyrics", color: "#8e8ea0", url: (t, q) => (lyricsOf(t).length ? "" : `https://www.google.com/search?q=${enc(`${q} lyrics`)}`) },
];

init();

async function init() {
  const cmds = await chrome.commands.getAll();
  const key = cmds.find((c) => c.name === "listen-tab")?.shortcut;
  if (key) $("listenKeyHint").textContent = ` (or ${key})`;

  if (recordingId) {
    entry = await loadRecording(recordingId);
    if (entry) {
      samples = base64ToSamples(entry.samples);
      showResult();
    } else {
      setHeadline("Recording expired", "Recordings are only kept for the session. Tap to listen again.");
    }
  } else if (params.get("listen") === "mic") {
    startMic();
  }
}

// --- Listening with the microphone -------------------------------------------

$("micBtn").addEventListener("click", () => (controller ? controller.abort("finish") : startMic()));
$("finishBtn").addEventListener("click", () => controller?.abort("finish"));
$("cancelBtn").addEventListener("click", () => controller?.abort("cancel"));

async function startMic() {
  if (controller) return;
  stopPlayback();
  let stream;
  try {
    // Raw sound: noise suppression would erase the music we want to recognize.
    stream = await navigator.mediaDevices.getUserMedia({
      // Full-band, unprocessed audio: noise suppression and voice isolation
      // treat music as noise, and automatic gain "pumps" the volume (listen.js
      // normalizes the level itself, evenly).
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        voiceIsolation: false,
        channelCount: { ideal: 1 },
        sampleRate: { ideal: 48000 },
      },
    });
  } catch {
    setHeadline(
      "Microphone unavailable",
      "Allow microphone access (icon on the right of the address bar), then tap again."
    );
    return;
  }

  controller = new AbortController();
  setListening(true);
  setHeadline("Listening…", "Let it hear the sound, or say what you're looking for.");
  let lastSound = 0;
  try {
    const result = await listen(stream, {
      transcribe: "mic",
      lang,
      signal: controller.signal,
      onProgress: (p) => {
        showProgress(p);
        // Spoken query: stop by itself once the user has finished talking.
        if (p.level > 0.05) lastSound = p.elapsed;
        if (p.transcript && p.elapsed > 3 && p.elapsed - lastSound > 2) controller?.abort("finish");
      },
    });
    if (result.cancelled) {
      setHeadline("Tap to listen", "Let it hear a song, or say what you're looking for.");
      return;
    }
    samples = result.samples;
    entry = { ...result, samples: samplesToBase64(result.samples), origin: "mic" };
    recordingId = await storeRecording(entry);
    history.replaceState(null, "", `?id=${recordingId}`);
    showResult();
  } catch (err) {
    setHeadline("Listening failed", err.message || String(err));
  } finally {
    stream.getTracks().forEach((t) => t.stop());
    controller = null;
    setListening(false);
  }
}

function setListening(on) {
  $("listenCard").classList.toggle("listening", on);
  $("listeningUi").hidden = !on;
  $("progressBar").style.width = "0";
  $("micBtn").setAttribute("aria-label", on ? "Finish listening" : "Listen with the microphone");
  if (on) {
    $("listenCard").classList.remove("found");
    $("orbCover").hidden = true;
  }
}

function showProgress({ elapsed, level, transcript }) {
  $("micBtn").style.setProperty("--level", level.toFixed(3));
  [...$("micBtn").querySelectorAll(".bars i")].forEach((bar, i) => {
    const wave = 0.5 + 0.5 * Math.sin(Date.now() / 110 + i * 1.1);
    bar.style.height = `${6 + Math.round(level * wave * 46)}px`;
  });
  $("progressBar").style.width = `${Math.min(100, (elapsed / LISTEN_SECONDS) * 100)}%`;
  if (transcript) $("listenSub").textContent = `“${transcript.slice(-120)}”`;
}

function setHeadline(title, sub) {
  $("listenTitle").textContent = title;
  $("listenSub").textContent = sub;
}

// --- Result ---------------------------------------------------------------------

function showResult() {
  const { track, transcript, silent, origin } = entry;
  const card = $("listenCard");
  card.classList.toggle("found", Boolean(track));
  $("orbCover").hidden = !track?.cover;
  if (track?.cover) $("orbCover").src = track.cover;
  $("howCard").hidden = true;

  if (track && entry.confidence === "low") setHeadline("Probably…", `${track.title} · ${track.artist}`);
  else if (track) setHeadline("Found it!", `${track.title} · ${track.artist}`);
  else if (transcript) setHeadline("No song recognized", "But here are the lyrics heard: search them to find the song.");
  else if (silent) {
    setHeadline(
      "No sound detected",
      origin === "tab"
        ? "The tab was silent. Start playback (and check it isn't muted), then try again."
        : "The microphone picked up nothing. Move closer to the sound."
    );
  } else if (entry.context) {
    setHeadline(
      "Song not recognized",
      "It's probably not on streaming platforms (common for songs only posted on Facebook): here are results based on the post's text."
    );
  } else setHeadline("No match", "This sound wasn't recognized. Try a longer or clearer passage.");

  renderMeta();
  $("clipActions").hidden = !samples?.length;
  renderTrack(track);

  const showHeard = Boolean(track && transcript);
  $("heard").hidden = !showHeard;
  if (showHeard) $("heardText").textContent = transcript;

  renderSuggestions();

  // Not recognized (e.g. a local song only posted on Facebook): fall back on
  // the caption of the post that was playing.
  const query = track ? `${track.artist} ${track.title}` : transcript || entry.context || "";
  const why = track
    ? "Music video and clips for this song:"
    : transcript
      ? "Searching what was said:"
      : "Searching the text of the post that was playing:";
  $("queryInput").value = query;
  $("searchTitle").textContent = track ? "Videos and links" : "Search what you heard";
  if (query) runSearch(query, why);
  else {
    resetSearch();
    let status = "Type what you remember: a title, an artist, some lyrics…";
    if (entry.error) status = "The recognition service can't be reached. Check your connection, then “Retry”. " + status;
    else if (origin === "tab" && !canTranscribeTabs) {
      status = "Tip: this browser can't transcribe a tab's speech. Use the microphone near the speakers, or " + status.charAt(0).toLowerCase() + status.slice(1);
    }
    setStatus(status);
    $("queryInput").focus();
  }
}

function renderMeta() {
  const rows = [];
  if (entry.origin === "tab") {
    const host = /^https?:/.test(entry.pageUrl || "") ? new URL(entry.pageUrl).hostname.replace(/^www\./, "") : "";
    const dd = document.createElement("span");
    if (entry.favicon && /^https?:/.test(entry.favicon)) {
      dd.append(Object.assign(document.createElement("img"), { src: entry.favicon, alt: "" }));
    }
    dd.append(host ? `Tab · ${host}` : "Tab");
    rows.push(["Source", dd]);
    if (entry.pageTitle) {
      const a = Object.assign(document.createElement("a"), { textContent: entry.pageTitle, title: entry.pageTitle, target: "_blank", rel: "noopener" });
      if (host) a.href = entry.pageUrl;
      rows.push(["Page", a]);
    }
  } else {
    rows.push(["Source", "Microphone"]);
  }
  rows.push(["Duration", `${Math.max(1, Math.round(entry.durationMs / 1000))} s`]);
  rows.push(["Time", new Date(entry.createdAt || Date.now()).toLocaleTimeString(lang, { hour: "2-digit", minute: "2-digit" })]);

  $("meta").replaceChildren(
    ...rows.flatMap(([k, v]) => {
      const dt = document.createElement("dt");
      dt.textContent = k;
      const dd = document.createElement("dd");
      dd.append(v);
      return [dt, dd];
    })
  );
}

// Shazam's own details first, completed by Deezer / LRCLIB (track.extra).
const lyricsOf = (t) => (t?.lyrics?.length ? t.lyrics : t?.extra?.lyrics || []);
const coverOf = (t) => t.extra?.cover || t.cover;
const formatDuration = (s) => (s ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}` : "");

function renderTrack(track) {
  $("trackCard").hidden = !track;
  renderAlternatives(track);
  $("lyricsCard").hidden = !lyricsOf(track).length;
  stopPreview();
  if (!track) return;
  if (!track.extra) loadExtra(track);
  else if (!track.extra.preview && track.extra.deezerId && !track.preview) loadPreview(track);

  $("trackTitle").textContent = track.title;
  $("trackArtist").textContent = track.artist;
  $("trackCover").src = coverOf(track) || "../icons/icon128.png";
  // Covers are parsed https URLs (see safeUrl), JSON quoting keeps the CSS string intact.
  $("trackBackdrop").style.backgroundImage = coverOf(track) ? `url(${JSON.stringify(coverOf(track))})` : "";
  const year = (track.released || track.extra?.released || "").match(/\d{4}/)?.[0];
  const duration = formatDuration(track.extra?.duration);
  $("trackChips").replaceChildren(
    ...[track.genre, track.album || track.extra?.album, year, duration, track.label && track.label !== track.artist ? track.label : ""]
      .filter(Boolean)
      .map((text) => Object.assign(document.createElement("span"), { className: "chip", textContent: text }))
  );

  const q = `${track.artist} ${track.title}`;
  $("trackLinks").replaceChildren(
    ...SERVICES.map((s) => {
      const href = s.url(track, q);
      if (!href) return null;
      const a = linkPill(s.name, href);
      a.style.setProperty("--dot", s.color);
      return a;
    }).filter(Boolean)
  );

  const preview = track.preview || track.extra?.preview || "";
  $("previewBtn").hidden = !preview;
  if ($("previewAudio").getAttribute("src") !== preview) $("previewAudio").src = preview;
  $("lyrics").textContent = lyricsOf(track).join("\n");
  $("lyricsSource").textContent = !track.lyrics?.length && lyricsOf(track).length ? "Lyrics from LRCLIB" : "";
}

// Recording reopened: get a fresh Deezer preview URL (kept in memory only).
async function loadPreview(track) {
  const preview = await deezerPreview(track.extra.deezerId).catch(() => "");
  if (!preview || entry?.track?.key !== track.key) return;
  track.extra.preview = preview;
  $("previewBtn").hidden = false;
  $("previewAudio").src = preview;
}

// Saves the recording. Deezer preview URLs are left out: they carry an access
// token that expires, and a fresh one is fetched when the song is shown again.
function saveEntry() {
  const strip = (t) => (t?.extra?.preview ? { ...t, extra: { ...t.extra, preview: "" } } : t);
  return updateEntry("snd", recordingId, {
    ...entry,
    track: strip(entry.track),
    alternatives: (entry.alternatives || []).map(strip),
  });
}

// Fetches the Deezer / LRCLIB details once, saves them with the recording and
// refreshes the card if the user is still looking at the same song.
async function loadExtra(track) {
  const extra = await enrichTrack(track).catch(() => null);
  if (!extra) return;
  track.extra = extra;
  if (entry?.track?.key === track.key) {
    entry.track.extra = extra;
    saveEntry();
    renderTrack(entry.track);
  }
}

// A song matched only once may be wrong (same artist, another version): say so,
// and list the other songs heard so the user can switch with one click.
function renderAlternatives(track) {
  const unsure = Boolean(track) && entry.confidence === "low";
  $("trackEyebrow").classList.toggle("unsure", unsure);
  $("trackEyebrowText").textContent = unsure ? "Probable match" : "Song identified";

  const others = (entry.alternatives || []).filter((t) => t.key !== track?.key);
  $("altCard").hidden = !track || (!unsure && !others.length);
  if ($("altCard").hidden) return;
  $("altNote").textContent = others.length
    ? "Several songs were recognized while listening. If this isn't the right one, pick another:"
    : "Recognized from a single passage: if it's not the right song, listen again for longer, ideally during the chorus.";
  $("altList").replaceChildren(
    ...others.map((t) => {
      const b = document.createElement("button");
      b.type = "button";
      b.innerHTML = `<img alt=""><span></span>`;
      b.querySelector("img").src = t.cover || "../icons/icon48.png";
      b.querySelector("span").textContent = `${t.title} · ${t.artist}`;
      b.addEventListener("click", () => {
        // Swap: the chosen song becomes the main result, the previous one an alternative.
        entry = { ...entry, track: t, confidence: "high", alternatives: [entry.track, ...others.filter((o) => o.key !== t.key)] };
        saveEntry();
        showResult();
        window.scrollTo({ top: 0, behavior: "smooth" });
      });
      return b;
    })
  );
}

// The post caption or the page title often names what is playing.
function renderSuggestions() {
  const title = (entry.pageTitle || "").replace(/^\(\d+\)\s*/, "").replace(/\s*[-–|·]\s*(YouTube|Facebook|Instagram|TikTok|Netflix)$/i, "").trim();
  const generic = /^(facebook|instagram|youtube|tiktok|netflix|accueil|home)$/i.test(title);
  const items = [];
  if (entry.context) items.push(["Post", entry.context]);
  if (title && !generic && title.length > 3 && title !== entry.context) items.push(["Page title", title]);
  $("suggestions").replaceChildren(
    ...items.map(([label, text]) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = `${label}: ${text}`;
      b.title = text;
      b.addEventListener("click", () => {
        $("queryInput").value = text;
        runSearch(text, `Searching: ${label.toLowerCase()}`);
      });
      return b;
    })
  );
}

// --- Search (links + YouTube videos) ---------------------------------------------

let searchRun = 0;

$("queryForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const q = $("queryInput").value.trim();
  if (q) runSearch(q, "Results for your search:");
});
$("heardBtn").addEventListener("click", () => {
  $("queryInput").value = entry.transcript;
  runSearch(entry.transcript, "Searching what was said:");
});

async function runSearch(query, status) {
  const run = ++searchRun;
  $("howCard").hidden = true;
  setStatus(status);
  $("quickLinks").replaceChildren(...SEARCH_LINKS.map((l) => linkPill(l.name, l.url(query))));
  $("videosHead").hidden = false;
  $("ytMore").href = SEARCH_LINKS[0].url(query);
  $("videos").replaceChildren(...videoSkeletons());
  renderSocial(query);
  try {
    const videos = await searchYouTube(query);
    if (run !== searchRun) return;
    $("videos").replaceChildren(...(videos.length ? videos.map(videoCard) : [videoMessage("No videos found.")]));
  } catch {
    if (run !== searchRun) return;
    $("videos").replaceChildren(videoMessage("Can't load videos here. Use “More on YouTube”."));
  }
}

function resetSearch() {
  searchRun++;
  hideSocial();
  $("quickLinks").replaceChildren();
  $("videos").replaceChildren();
  $("videosHead").hidden = true;
}

function setStatus(text) {
  $("insightStatus").textContent = text;
}

// --- Retry, clip playback, song preview -------------------------------------------

$("retryBtn").addEventListener("click", async () => {
  const btn = $("retryBtn");
  btn.disabled = true;
  try {
    const track = await recognize(samples, lang);
    if (!track) {
      toast("Still no song recognized");
      return;
    }
    const previous = entry.track && entry.track.key !== track.key ? [entry.track] : [];
    // Same song as before = confirmed; a different one stays "probable".
    const confidence = entry.track?.key === track.key ? "high" : "low";
    entry = { ...entry, track, confidence, alternatives: [...previous, ...(entry.alternatives || [])].filter((t) => t.key !== track.key), error: null };
    await saveEntry();
    showResult();
  } catch {
    toast("Recognition service unreachable");
  } finally {
    btn.disabled = false;
  }
});

let player = null;
$("playBtn").addEventListener("click", () => {
  if (player) return stopPlayback();
  stopPreview();
  const ctx = new AudioContext();
  const buffer = ctx.createBuffer(1, samples.length, SAMPLE_RATE);
  buffer.getChannelData(0).set(Float32Array.from(samples, (v) => v / 32768));
  const node = ctx.createBufferSource();
  node.buffer = buffer;
  node.connect(ctx.destination);
  node.onended = stopPlayback;
  node.start();
  player = { ctx, node };
  $("playBtn").querySelector("span").textContent = "Stop";
});

function stopPlayback() {
  if (!player) return;
  const { ctx, node } = player;
  player = null;
  node.onended = null;
  try {
    node.stop();
  } catch {}
  ctx.close();
  $("playBtn").querySelector("span").textContent = "Replay the clip";
}

const preview = $("previewAudio");
$("previewBtn").addEventListener("click", () => {
  if (preview.paused) {
    stopPlayback();
    preview.play().catch(() => toast("Preview unavailable"));
  } else preview.pause();
});
preview.addEventListener("play", () => ($("previewBtn").querySelector("span").textContent = "Pause"));
preview.addEventListener("pause", () => ($("previewBtn").querySelector("span").textContent = "Play preview"));

function stopPreview() {
  if (!preview.paused) preview.pause();
}
