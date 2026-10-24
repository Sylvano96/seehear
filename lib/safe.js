// Validation of data coming from third-party APIs (Shazam, Deezer, LRCLIB,
// YouTube) before it reaches the page or the session storage.

// A URL is kept only if it is https and on one of the expected domains (or a
// subdomain): a compromised or spoofed API response can't make the page load
// an image or a sound from elsewhere, or show a link to another site.
export function allowedUrl(value, domains) {
  if (typeof value !== "string" || !value) return "";
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return "";
    const host = url.hostname;
    return domains.some((d) => host === d || host.endsWith(`.${d}`)) ? url.href : "";
  } catch {
    return "";
  }
}

// Strings are capped so an abnormal response can't fill the session storage
// (10 MB for the whole extension).
export function cleanText(value, max = 300) {
  return typeof value === "string" ? value.slice(0, max) : "";
}

export const MAX_LYRICS_CHARS = 20000;
export const MAX_LYRICS_LINES = 400;

export function cleanLyrics(lines) {
  if (!Array.isArray(lines)) return [];
  const out = [];
  let total = 0;
  for (const line of lines) {
    if (typeof line !== "string") continue;
    if (out.length >= MAX_LYRICS_LINES || total + line.length > MAX_LYRICS_CHARS) break;
    out.push(line);
    total += line.length;
  }
  return out;
}

// Expected domains per kind of data.
export const DOMAINS = {
  shazamPage: ["shazam.com"],
  appleMedia: ["mzstatic.com", "apple.com"],
  appleMusic: ["music.apple.com"],
  deezerPage: ["deezer.com"],
  deezerMedia: ["dzcdn.net"],
  youtubeImage: ["ytimg.com"],
};
