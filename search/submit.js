// Opened in its own tab for each engine: posts the image to the engine in the
// same tab. Using a real tab (instead of form target=_blank) avoids popup
// blockers when "Search everywhere" opens every engine at once.
import { getEngine } from "../lib/engines.js";
import { dataURLToBlob, loadImage } from "../lib/image.js";

const status = document.getElementById("status");
const params = new URLSearchParams(location.search);
const engine = getEngine(params.get("engine"));

run().catch((err) => {
  status.textContent = `Sending failed: ${err.message}`;
  status.classList.add("error");
  document.querySelector(".spinner").remove();
});

async function run() {
  if (!engine) throw new Error("unknown engine");
  if (params.has("error")) throw new Error(params.get("error"));
  status.textContent = `Sending to ${engine.name}…`;
  document.title = `Seehear → ${engine.name}`;

  const entry = await loadImage(params.get("id"));
  if (!entry) throw new Error("image not found (the session may have expired)");

  // No local copy (remote image we couldn't download): search by URL.
  // Only public web addresses are sent: never a local file path or an internal URL.
  if (!entry.dataUrl) {
    if (!/^https?:\/\//i.test(entry.srcUrl || "")) throw new Error("this image can't be sent; use the area capture instead");
    location.replace(engine.byUrl(entry.srcUrl));
    return;
  }

  if (engine.site) {
    // The service worker navigates this tab to the engine and uploads from there.
    chrome.runtime.sendMessage({ type: "fs:site-upload", engine: engine.id, id: params.get("id") });
    return;
  }

  const blob = await dataURLToBlob(entry.dataUrl);

  const form = document.createElement("form");
  form.method = "POST";
  form.enctype = "multipart/form-data";
  form.action = engine.upload.action();
  form.hidden = true;

  const ext = blob.type === "image/jpeg" ? "jpg" : "png";
  const file = new File([blob], `seehear.${ext}`, { type: blob.type });
  const transfer = new DataTransfer();
  transfer.items.add(file);
  const input = document.createElement("input");
  input.type = "file";
  input.name = engine.upload.field;
  input.files = transfer.files;
  form.append(input);

  document.body.append(form);
  form.submit();
}
