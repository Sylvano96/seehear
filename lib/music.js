// Extra details for a recognized song, from official public APIs (no key):
// - Deezer: the exact track (looked up by ISRC, the recording's international
//   code that Shazam returns), a direct link, a 30 s preview, a large cover,
//   the release date and the duration;
// - LRCLIB: the lyrics (community-maintained, includes many local artists).
// Only the title, artist and ISRC are sent. Every lookup is optional: a failure
// just leaves that detail out. Every field is validated (see safe.js).
import { DOMAINS, allowedUrl, cleanLyrics, cleanText } from "./safe.js";

const enc = encodeURIComponent;
const TIMEOUT = 8000;

async function getJson(url, headers = {}) {
  const res = await fetch(url, { credentials: "omit", headers, signal: AbortSignal.timeout(TIMEOUT) });
  if (!res.ok) return null;
  return res.json().catch(() => null);
}

const clean = (s) => s.toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "").replace(/[^a-z0-9]+/g, " ").trim();
const validId = (id) => Number.isSafeInteger(id) && id > 0;

async function deezerTrack(track) {
  // By ISRC first: one exact recording, no guessing.
  if (track.isrc) {
    const byIsrc = await getJson(`https://api.deezer.com/track/isrc:${enc(track.isrc)}`);
    if (validId(byIsrc?.id)) return byIsrc;
  }
  const q = `artist:"${track.artist}" track:"${track.title}"`;
  const found = await getJson(`https://api.deezer.com/search?q=${enc(q)}&limit=5`);
  // Only accept a result whose title really matches (Deezer search is fuzzy).
  const list = Array.isArray(found?.data) ? found.data : [];
  return list.find((t) => validId(t?.id) && typeof t.title === "string" && clean(t.title).startsWith(clean(track.title).slice(0, 12))) || null;
}

async function lrclibLyrics(track, duration) {
  const headers = { "Lrclib-Client": "Seehear browser extension" };
  const params = `artist_name=${enc(track.artist)}&track_name=${enc(track.title)}`;
  const exact = await getJson(`https://lrclib.net/api/get?${params}${duration ? `&duration=${duration}` : ""}`, headers);
  if (typeof exact?.plainLyrics === "string" && exact.plainLyrics.trim()) return exact.plainLyrics;
  const results = await getJson(`https://lrclib.net/api/search?${params}`, headers);
  const hit = (Array.isArray(results) ? results : []).find((r) => typeof r?.plainLyrics === "string" && r.plainLyrics.trim());
  return hit?.plainLyrics || "";
}

// Deezer preview URLs carry an access token that expires: they are fetched
// when needed and never stored (see deezerPreview).
export async function enrichTrack(track) {
  const deezer = await deezerTrack(track).catch(() => null);
  const duration = Number.isInteger(deezer?.duration) && deezer.duration > 0 && deezer.duration < 36000 ? deezer.duration : 0;
  const lyrics = track.lyrics?.length ? "" : await lrclibLyrics(track, duration).catch(() => "");
  const released = typeof deezer?.release_date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(deezer.release_date) ? deezer.release_date : "";
  return {
    deezerId: deezer ? deezer.id : 0,
    deezerUrl: allowedUrl(deezer?.link, DOMAINS.deezerPage),
    preview: allowedUrl(deezer?.preview, DOMAINS.deezerMedia),
    cover: allowedUrl(deezer?.album?.cover_xl, DOMAINS.deezerMedia),
    released,
    album: cleanText(deezer?.album?.title),
    duration,
    lyrics: cleanLyrics(lyrics ? lyrics.split("\n") : []),
  };
}

// A fresh preview URL for a Deezer track id (for recordings reopened later).
export async function deezerPreview(id) {
  if (!validId(id)) return "";
  const track = await getJson(`https://api.deezer.com/track/${id}`).catch(() => null);
  return allowedUrl(track?.preview, DOMAINS.deezerMedia);
}
