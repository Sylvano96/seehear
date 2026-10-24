// YouTube search (videos for a song or a typed query).

// Uses the JSON search endpoint YouTube's own web app calls (fetching the HTML
// results page gets flagged by Google's bot check far more often).
// `params` is YouTube's encoded search filter (see YT_FILTERS).
export async function youtubeSearchRaw(query, params) {
  const res = await fetch("https://www.youtube.com/youtubei/v1/search?prettyPrint=false", {
    method: "POST",
    credentials: "omit",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      context: { client: { clientName: "WEB", clientVersion: "2.20251001.00.00", hl: "en" } },
      query,
      ...(params ? { params } : {}),
    }),
  });
  if (!res.ok) throw new Error(`YouTube ${res.status}`);
  return res.json();
}

export const YT_FILTERS = {
  shorts: "EgIQCQ%3D%3D",
  thisWeek: "EgIIAw%3D%3D",
};

export async function searchYouTube(query, limit = 6, params) {
  const data = await youtubeSearchRaw(query, params);

  const videos = [];
  (function walk(node) {
    if (!node || typeof node !== "object" || videos.length >= limit) return;
    const v = node.videoRenderer;
    if (v?.videoId) {
      videos.push({
        id: v.videoId,
        title: v.title?.runs?.map((r) => r.text).join("") || "",
        channel: v.ownerText?.runs?.[0]?.text || "",
        length: v.lengthText?.simpleText || "",
        views: v.shortViewCountText?.simpleText || "",
        published: v.publishedTimeText?.simpleText || "",
      });
      return;
    }
    for (const key in node) walk(node[key]);
  })(data);
  return videos;
}
