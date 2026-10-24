import { YT_FILTERS, searchYouTube, youtubeSearchRaw } from "./insights.js";
import { DOMAINS, allowedUrl, cleanText } from "./safe.js";

// What is popular around a search: short videos (YouTube Shorts are largely
// TikTok / Instagram Reels content re-posted), this week's uploads, and links
// to the social networks.

const enc = encodeURIComponent;

// TikTok, Instagram and Facebook can't be read without an account: links only.
export const SOCIAL_LINKS = [
  { name: "TikTok", color: "#ff0050", url: (q) => `https://www.tiktok.com/search?q=${enc(q)}` },
  { name: "Instagram", color: "#e1306c", url: (q) => `https://www.instagram.com/explore/search/keyword/?q=${enc(q)}` },
  { name: "Facebook", color: "#1877f2", url: (q) => `https://www.facebook.com/search/videos/?q=${enc(q)}` },
  { name: "Shorts", color: "#ff0033", url: (q) => `https://www.youtube.com/results?search_query=${enc(q)}&sp=${YT_FILTERS.shorts}` },
  { name: "Google Trends", color: "#4285f4", url: (q) => `https://trends.google.com/trends/explore?q=${enc(q)}&date=today%203-m` },
];

export async function searchShorts(query, limit = 10) {
  const data = await youtubeSearchRaw(query, YT_FILTERS.shorts);
  const shorts = [];
  const seen = new Set();
  (function walk(node) {
    if (!node || typeof node !== "object" || shorts.length >= limit) return;
    const s = node.shortsLockupViewModel;
    if (s) {
      const endpoint = s.onTap?.innertubeCommand?.reelWatchEndpoint;
      const id = endpoint?.videoId;
      if (id && !seen.has(id)) {
        seen.add(id);
        shorts.push({
          id,
          title: cleanText(s.overlayMetadata?.primaryText?.content || s.accessibilityText || ""),
          views: cleanText(s.overlayMetadata?.secondaryText?.content || "", 40),
          thumb:
            allowedUrl(endpoint.thumbnail?.thumbnails?.[0]?.url, DOMAINS.youtubeImage) ||
            `https://i.ytimg.com/vi/${enc(id)}/hqdefault.jpg`,
        });
      }
      return;
    }
    for (const key in node) walk(node[key]);
  })(data);
  return shorts;
}

// The "this week" filter is loose: keep videos whose title shares a word with
// the query (accents and case ignored), unless that leaves nothing.
const words = (text) =>
  text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3);

export async function searchThisWeek(query, limit = 6) {
  const videos = await searchYouTube(query, limit * 3, YT_FILTERS.thisWeek);
  const wanted = new Set(words(query));
  const relevant = videos.filter((v) => words(v.title).some((w) => wanted.has(w)));
  return (relevant.length ? relevant : videos).slice(0, limit);
}
