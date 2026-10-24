import { ENGINES } from "../lib/engines.js";
import { blobToDataURL, dataURLToBlob, ImageTooLargeError, loadImage, normalizeImage, storeImage } from "../lib/image.js";
import { updateEntry } from "../lib/session.js";
import { $, toast } from "./ui.js";

const ORIGIN_LABELS = { capture: "Screen capture", import: "Imported image", menu: "Right-clicked image" };

let imageId = new URLSearchParams(location.search).get("id");
let entry = null;

renderEngines();
init();

async function init() {
  entry = imageId ? await loadImage(imageId) : null;
  if (!entry) {
    showPlaceholder("No image yet. Paste, drop or import an image to start.");
    return;
  }
  // Right-clicked image: try to grab the bytes so engines get a real upload.
  if (!entry.dataUrl && entry.srcUrl) {
    await tryDownloadRemote();
  }
  render();
}

async function tryDownloadRemote() {
  try {
    const res = await fetch(entry.srcUrl, { credentials: "omit" });
    if (!res.ok) throw new Error(res.status);
    const { blob, width, height } = await normalizeImage(await res.blob());
    entry = { ...entry, dataUrl: await blobToDataURL(blob), width, height, size: blob.size, type: blob.type };
    await updateEntry("img", imageId, entry);
  } catch {
    // Cross-origin image we can't read: engines will search by URL instead.
  }
}

function render() {
  const img = $("previewImg");
  img.src = entry.dataUrl || entry.srcUrl;
  img.hidden = false;
  $("placeholder").hidden = true;

  img.onload = () => {
    if (!entry.width) {
      entry.width = img.naturalWidth;
      entry.height = img.naturalHeight;
      renderMeta();
    }
  };
  renderMeta();

  const notice = $("notice");
  if (!entry.dataUrl) {
    notice.hidden = false;
    notice.textContent =
      "This site blocks direct image downloads: engines will search by the image's address. If one finds nothing, use the area capture instead.";
  } else {
    notice.hidden = true;
  }

  const hasBytes = Boolean(entry.dataUrl);
  $("allBtn").disabled = false;
  $("downloadBtn").disabled = !hasBytes;
  $("copyBtn").disabled = !hasBytes;
  document.querySelectorAll(".engine").forEach((b) => (b.disabled = false));
}

function renderMeta() {
  const rows = [];
  if (entry.width) rows.push(["Dimensions", `${entry.width} × ${entry.height} px`]);
  if (entry.size) rows.push(["Weight", formatBytes(entry.size)]);
  if (entry.type) rows.push(["Format", entry.type.replace("image/", "").toUpperCase()]);
  rows.push(["Origin", ORIGIN_LABELS[entry.origin] || "—"]);
  if (entry.pageUrl && /^https?:/.test(entry.pageUrl)) rows.push(["Page", link(entry.pageUrl)]);
  if (entry.srcUrl && /^https?:/.test(entry.srcUrl)) rows.push(["File", link(entry.srcUrl)]);

  $("meta").replaceChildren(
    ...rows.flatMap(([k, v]) => {
      const dt = document.createElement("dt");
      dt.textContent = k;
      const dd = document.createElement("dd");
      if (typeof v === "string") dd.textContent = v;
      else dd.append(v);
      return [dt, dd];
    })
  );
}

function link(url) {
  const a = document.createElement("a");
  a.href = url;
  a.target = "_blank";
  a.rel = "noopener";
  a.title = url;
  a.textContent = new URL(url).hostname + new URL(url).pathname;
  return a;
}

function renderEngines() {
  const container = $("engines");
  for (const [i, engine] of ENGINES.entries()) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "engine" + (i === 0 ? " featured" : "");
    btn.disabled = true;
    btn.style.setProperty("--engine-color", engine.color);
    btn.innerHTML = `
      <div class="engine-top">
        <span class="engine-dot"></span>
        <span class="engine-name"></span>
      </div>
      <div class="engine-body">
        <p class="engine-desc"></p>
        <div class="tags"></div>
      </div>`;
    btn.querySelector(".engine-dot").textContent = engine.name[0];
    btn.querySelector(".engine-name").textContent = engine.name;
    btn.querySelector(".engine-desc").textContent = engine.tagline;
    btn.querySelector(".tags").append(
      ...engine.tags.map((t) => Object.assign(document.createElement("span"), { className: "tag", textContent: t }))
    );
    if (i === 0) {
      // Featured layout: name + description stacked next to the logo.
      const top = btn.querySelector(".engine-top");
      const body = btn.querySelector(".engine-body");
      body.prepend(btn.querySelector(".engine-name"));
      top.after(body);
      btn.append(Object.assign(document.createElement("span"), { className: "btn primary go", textContent: "Search" }));
    }
    btn.addEventListener("click", () => openEngines([engine.id]));
    container.append(btn);
  }
}

async function openEngines(ids) {
  const [current] = await chrome.tabs.query({ active: true, currentWindow: true });
  ids.forEach((engineId, i) => {
    chrome.tabs.create({
      url: chrome.runtime.getURL(`search/submit.html?engine=${engineId}&id=${imageId}`),
      active: i === 0,
      index: current ? current.index + 1 + i : undefined,
      openerTabId: current?.id,
    });
  });
}

$("allBtn").addEventListener("click", () => openEngines(ENGINES.map((e) => e.id)));

// --- Download / copy ---

$("downloadBtn").addEventListener("click", () => {
  const a = document.createElement("a");
  a.href = entry.dataUrl;
  a.download = `seehear-${Date.now()}.${entry.type === "image/jpeg" ? "jpg" : "png"}`;
  a.click();
});

$("copyBtn").addEventListener("click", async () => {
  try {
    let blob = await dataURLToBlob(entry.dataUrl);
    if (blob.type !== "image/png") {
      // The clipboard only reliably accepts PNG.
      const bitmap = await createImageBitmap(blob);
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      canvas.getContext("2d").drawImage(bitmap, 0, 0);
      blob = await canvas.convertToBlob({ type: "image/png" });
    }
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    toast("Image copied to the clipboard");
  } catch {
    toast("Can't copy the image");
  }
});

// --- Replace image: file picker, paste, drag & drop ---

$("replaceBtn").addEventListener("click", () => $("fileInput").click());
$("fileInput").addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (file) useNewImage(file, "import");
  e.target.value = "";
});

document.addEventListener("paste", (e) => {
  const file = [...(e.clipboardData?.files || [])].find((f) => f.type.startsWith("image/"));
  if (file) useNewImage(file, "import");
});

let dragDepth = 0;
document.addEventListener("dragenter", (e) => {
  if (![...e.dataTransfer.types].includes("Files")) return;
  dragDepth++;
  $("dropOverlay").hidden = false;
});
document.addEventListener("dragleave", () => {
  if (--dragDepth <= 0) {
    dragDepth = 0;
    $("dropOverlay").hidden = true;
  }
});
document.addEventListener("dragover", (e) => e.preventDefault());
document.addEventListener("drop", (e) => {
  e.preventDefault();
  dragDepth = 0;
  $("dropOverlay").hidden = true;
  const file = [...e.dataTransfer.files].find((f) => f.type.startsWith("image/"));
  if (file) useNewImage(file, "import");
  else toast("This file is not an image");
});

async function useNewImage(file, origin) {
  try {
    const { blob, width, height } = await normalizeImage(file);
    const dataUrl = await blobToDataURL(blob);
    entry = { dataUrl, width, height, size: blob.size, type: blob.type, origin };
    imageId = await storeImage(entry);
    history.replaceState(null, "", `?id=${imageId}`);
    render();
    toast("New image ready");
  } catch (err) {
    toast(err instanceof ImageTooLargeError ? err.message : "Can't read this image");
  }
}

// --- Helpers ---

function showPlaceholder(text) {
  $("placeholder").textContent = text;
  $("placeholder").hidden = false;
  $("previewImg").hidden = true;
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
