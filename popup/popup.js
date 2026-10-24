import { blobToDataURL, ImageTooLargeError, normalizeImage, storeImage } from "../lib/image.js";

const $ = (id) => document.getElementById(id);

// Show the shortcuts the user actually configured (they can be changed in the browser).
chrome.commands.getAll().then((cmds) => {
  for (const [name, el] of [["start-capture", "captureKey"], ["listen-tab", "listenKey"]]) {
    const cmd = cmds.find((c) => c.name === name);
    if (cmd?.shortcut) $(el).textContent = cmd.shortcut;
    else $(el).hidden = true;
  }
});

// While a tab is being listened to, the same button stops and shows the results.
let listening = false;
chrome.runtime.sendMessage({ type: "fs:listen-state" }).then((state) => {
  if (!state?.listening) return;
  listening = true;
  $("listenBtn").classList.add("listening");
  $("listenLabel").textContent = "Stop and see the result";
  $("listenHint").textContent = "Seehear is listening to a tab…";
});

$("listenBtn").addEventListener("click", async () => {
  if (listening) {
    chrome.runtime.sendMessage({ type: "fs:listen-stop", finish: true });
    window.close();
    return;
  }
  $("listenBtn").disabled = true;
  try {
    if (!chrome.tabCapture || !chrome.offscreen) {
      // New permissions only apply once the extension is reloaded (or the browser is too old).
      throw new Error(
        "Tab listening isn't active yet: reload Seehear in edge://extensions (↻ button), or update your browser (version 116 or later)."
      );
    }
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    // Must be requested here: the user's click on the extension is what allows it.
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id }).catch(() => {
      throw new Error("This tab can't be listened to (page protected by the browser). Use the microphone instead.");
    });
    const res = await chrome.runtime.sendMessage({ type: "fs:listen-tab", tab, streamId });
    if (!res?.ok) throw new Error(res?.error || "Listening failed.");
    window.close();
  } catch (err) {
    showError(err.message);
    $("listenBtn").disabled = false;
  }
});

$("micBtn").addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  await chrome.tabs.create({
    url: chrome.runtime.getURL("search/audio.html?listen=mic"),
    index: tab ? tab.index + 1 : undefined,
  });
  window.close();
});

$("captureBtn").addEventListener("click", async () => {
  $("captureBtn").disabled = true;
  const res = await chrome.runtime.sendMessage({ type: "fs:start-capture" });
  if (res?.ok) {
    window.close();
  } else {
    showError(res?.error || "Capture failed.");
    $("captureBtn").disabled = false;
  }
});

$("fileInput").addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (file) openWithFile(file);
});

const dropzone = $("dropzone");
dropzone.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    $("fileInput").click();
  }
});
dropzone.addEventListener("dragover", (e) => {
  e.preventDefault();
  dropzone.classList.add("over");
});
dropzone.addEventListener("dragleave", () => dropzone.classList.remove("over"));
dropzone.addEventListener("drop", (e) => {
  e.preventDefault();
  dropzone.classList.remove("over");
  const file = [...e.dataTransfer.files].find((f) => f.type.startsWith("image/"));
  if (file) openWithFile(file);
  else showError("This file is not an image.");
});

document.addEventListener("paste", (e) => {
  const file = [...(e.clipboardData?.files || [])].find((f) => f.type.startsWith("image/"));
  if (file) openWithFile(file);
});

async function openWithFile(file) {
  try {
    const { blob, width, height } = await normalizeImage(file);
    const dataUrl = await blobToDataURL(blob);
    const id = await storeImage({ dataUrl, width, height, size: blob.size, type: blob.type, origin: "import" });
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    await chrome.tabs.create({
      url: chrome.runtime.getURL(`search/search.html?id=${id}`),
      index: tab ? tab.index + 1 : undefined,
    });
    window.close();
  } catch (err) {
    showError(err instanceof ImageTooLargeError ? err.message : "Can't read this image.");
  }
}

function showError(text) {
  $("error").textContent = text;
  $("error").hidden = false;
}
