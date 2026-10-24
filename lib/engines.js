// Reverse image search engines.
// `upload` describes a multipart form POST (used when we have the image bytes);
// `site` is used instead for engines whose upload API only works from their
// own pages; `byUrl` builds a GET url (used when we only know the image's
// public URL).

export const ENGINES = [
  {
    id: "lens",
    name: "Google Lens",
    tagline: "The most complete: sources, objects, products, text (OCR) and translation.",
    tags: ["All-round", "Text"],
    color: "#4285f4",
    upload: {
      action: () => `https://lens.google.com/v3/upload?hl=en&re=df&st=${Date.now()}&ep=gsbubb`,
      field: "encoded_image",
    },
    byUrl: (url) => `https://lens.google.com/uploadbyurl?url=${encodeURIComponent(url)}&hl=en`,
  },
  {
    id: "bing",
    name: "Bing Visual Search",
    tagline: "Pages containing the image, similar images, text and shopping.",
    tags: ["All-round"],
    color: "#00809d",
    // Bing only accepts uploads coming from bing.com itself: the extension opens
    // `home`, then runs `upload` inside that page (it must be self-contained) and opens
    // the results URL it returns.
    site: {
      home: "https://www.bing.com/images/",
      upload: async (dataUrl) => {
        const body = new FormData();
        body.append("imgurl", "");
        body.append("cbir", "sbi");
        body.append("imageBin", dataUrl.slice(dataUrl.indexOf(",") + 1));
        const res = await fetch("/images/kblob", { method: "POST", body });
        const data = await res.json();
        if (data.redirectUrl) return data.redirectUrl;
        const token = data.processedBlobId || data.blobId;
        if (!token) throw new Error("unexpected response from Bing");
        return `/images/search?view=detailv2&iss=sbiupload&FORM=SBIIDP&sbisrc=ImgDropper&idpbck=1&insightsToken=bcid_${token}`;
      },
    },
    byUrl: (url) =>
      `https://www.bing.com/images/search?view=detailv2&iss=sbi&FORM=SBIIDP&q=imgurl:${encodeURIComponent(url)}`,
  },
  {
    id: "yandex",
    name: "Yandex Images",
    tagline: "Faces, places, objects, illustrations and sites that publish the image.",
    tags: ["All-round"],
    color: "#fc3f1d",
    // Same as Bing: Yandex's JSON upload endpoint must be called from yandex.com.
    site: {
      home: "https://yandex.com/images/",
      upload: async (dataUrl) => {
        const [meta, b64] = dataUrl.split(",");
        const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        const blob = new Blob([bytes], { type: meta.slice(5, meta.indexOf(";")) });
        const body = new FormData();
        body.append("upfile", blob, "image");
        const request = encodeURIComponent(JSON.stringify({ blocks: [{ block: "b-page_type_search-by-image__link" }] }));
        const res = await fetch(`/images/search?rpt=imageview&format=json&request=${request}`, { method: "POST", body });
        const data = await res.json();
        const params = data.blocks?.[0]?.params || {};
        if (params.cbirId) {
          const query = new URLSearchParams({ cbir_id: params.cbirId, rpt: "imageview", url: params.originalImageUrl || "" });
          return `/images/search?${query}`;
        }
        if (params.url) return `/images/search?${params.url}`; // older response format
        // Anti-bot check: show it so the user can solve it and retry.
        if (data.captcha?.["captcha-page"]) return data.captcha["captcha-page"];
        throw new Error("unexpected response from Yandex");
      },
    },
    byUrl: (url) => `https://yandex.com/images/search?rpt=imageview&url=${encodeURIComponent(url)}`,
  },
];

export function getEngine(id) {
  return ENGINES.find((e) => e.id === id);
}
