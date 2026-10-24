import { getEngine } from "./lib/engines.js";
import { blobToDataURL, cropScreenshot, loadImage, shrinkDataURL, storeImage } from "./lib/image.js";
import { LISTEN_SECONDS, storeRecording } from "./lib/recordings.js";

const MENU_ID = "seehear-image";

// YouTube only answers requests that look like they come from its own site. These header rules are restricted to Seehear's own requests
// (initiatorDomains = this extension), so web pages can't use them.
const HEADER_RULES = [
  { id: 2, url: "||www.youtube.com/youtubei/v1/search", origin: "https://www.youtube.com", referer: "https://www.youtube.com/" },
].map(({ id, url, origin, referer }) => ({
  id,
  priority: 1,
  action: {
    type: "modifyHeaders",
    requestHeaders: [
      { header: "Origin", operation: "set", value: origin },
      { header: "Referer", operation: "set", value: referer },
    ],
  },
  condition: {
    urlFilter: url,
    initiatorDomains: [chrome.runtime.id],
    requestMethods: ["post"],
    resourceTypes: ["xmlhttprequest"],
  },
}));

chrome.runtime.onInstalled.addListener(() => {
  chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [1, 2], // 1 = former Bing description rule, removed on update
    addRules: HEADER_RULES,
  });
  chrome.contextMenus.create({
    id: MENU_ID,
    title: "Search this image with Seehear",
    contexts: ["image"],
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== MENU_ID || !info.srcUrl) return;
  const id = await storeImage({ srcUrl: info.srcUrl, pageUrl: info.pageUrl, origin: "menu" });
  openSearchPage(id, tab);
});

chrome.commands.onCommand.addListener(async (command, tab) => {
  const target = tab || (await getActiveTab());
  if (!target) return;
  if (command === "start-capture") await startCapture(target).catch(() => {});
  if (command === "listen-tab") {
    // Same shortcut again while listening = stop now and show the results.
    if (listening) stopListening(true);
    else await startListening(target).catch((err) => console.error("Seehear listen failed:", err));
  }
});

// Defense in depth: each message type is only accepted from the part of the
// extension that is supposed to send it.
const OFFSCREEN_URL = chrome.runtime.getURL("offscreen/offscreen.html");
const SUBMIT_URL = chrome.runtime.getURL("search/submit.html");
const isExtensionPage = (sender) => sender.id === chrome.runtime.id && (sender.url || "").startsWith(chrome.runtime.getURL(""));
const fromOffscreen = (sender) => sender.id === chrome.runtime.id && (sender.url || "").startsWith(OFFSCREEN_URL);

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || typeof msg?.type !== "string") return false;

  if (msg.type === "fs:start-capture" && isExtensionPage(sender)) {
    getActiveTab()
      .then((tab) => startCapture(tab))
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (msg.type === "fs:site-upload" && sender.tab && (sender.url || "").startsWith(SUBMIT_URL)) {
    siteUpload(msg, sender.tab.id);
    return false;
  }

  // Only accepted from a tab where the user just started a capture.
  if (msg.type === "fs:region" && sender.tab) {
    handleRegion(msg, sender.tab).catch((err) => console.error("Seehear capture failed:", err));
    return false;
  }

  // --- Audio: identify what a tab is playing ---
  if (msg.type === "fs:listen-tab" && isExtensionPage(sender)) {
    // The popup gets the stream id itself: only the user's click allows it.
    startListening(msg.tab, msg.streamId)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  if (msg.type === "fs:listen-state") {
    sendResponse({ listening: Boolean(listening), tabId: listening?.tabId });
    return false;
  }
  if (msg.type === "fs:listen-stop" && (isExtensionPage(sender) || (listening && sender.tab?.id === listening.tabId))) {
    stopListening(Boolean(msg.finish));
    return false;
  }
  if (msg.type === "fs:listen-progress" && listening && fromOffscreen(sender)) {
    toListeningTab({ ...msg, total: LISTEN_SECONDS });
    return false;
  }
  if ((msg.type === "fs:listen-done" || msg.type === "fs:listen-error") && fromOffscreen(sender)) {
    finishListening(msg).catch((err) => console.error("Seehear listen failed:", err));
    return false;
  }
});

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

// Tabs where the area selector was injected (in session storage: the service
// worker may be stopped while the user is still framing the area).
const captureKey = (tabId) => `capture:${tabId}`;

async function startCapture(tab) {
  if (!tab?.id) throw new Error("No active tab.");
  await chrome.storage.session.set({ [captureKey(tab.id)]: Date.now() });
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content/selector.js"],
    });
  } catch {
    await chrome.storage.session.remove(captureKey(tab.id));
    throw new Error(
      "This page is protected by the browser (internal pages, extension store…). Open a regular website or import the image."
    );
  }
}

async function handleRegion({ rect, viewportWidth, pageUrl }, tab) {
  const key = captureKey(tab.id);
  const started = (await chrome.storage.session.get(key))[key];
  await chrome.storage.session.remove(key);
  if (!started || Date.now() - started > 10 * 60 * 1000) return; // no capture was started here
  // The region must be a real, finite rectangle inside a real viewport.
  const finite = (v) => typeof v === "number" && Number.isFinite(v);
  if (
    !rect || ![rect.x, rect.y, rect.width, rect.height, viewportWidth].every(finite) ||
    rect.width < 1 || rect.height < 1 || viewportWidth < 1 || rect.x < 0 || rect.y < 0
  ) return;
  if (typeof pageUrl !== "string") pageUrl = "";
  const screenshot = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
  const { blob, width, height } = await cropScreenshot(screenshot, rect, viewportWidth);
  const dataUrl = await blobToDataURL(blob);
  const id = await storeImage({ dataUrl, width, height, size: blob.size, type: blob.type, pageUrl, origin: "capture" });
  openSearchPage(id, tab);
}

// Some engines only accept uploads made from their own site: open it in the
// tab, then run the engine's upload function inside the page.
async function siteUpload({ engine: engineId, id }, tabId) {
  const engine = getEngine(engineId);
  if (!engine?.site) return;
  try {
    const entry = await loadImage(id);
    if (!entry?.dataUrl) throw new Error("image not found");
    await chrome.tabs.update(tabId, { url: engine.site.home });
    await waitForTabLoad(tabId);
    // Only hand the image to the engine's own page: if the site redirected the
    // tab elsewhere (consent page, another domain…), stop here.
    const loaded = await chrome.tabs.get(tabId);
    if (!loaded.url || new URL(loaded.url).origin !== new URL(engine.site.home).origin) {
      throw new Error(`${engine.name} redirected to another page; open it once in a tab, then try again`);
    }
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: engine.site.upload,
      args: [await shrinkDataURL(entry.dataUrl)],
    });
    // A failed upload throws in the page, which leaves no string result here.
    if (typeof result?.result !== "string") throw new Error(`${engine.name} did not accept the image`);
    // The engine page answers with where to go next: never leave the engine's own site.
    const next = new URL(result.result, engine.site.home);
    if (next.origin !== new URL(engine.site.home).origin) throw new Error(`${engine.name} returned an unexpected address`);
    await chrome.tabs.update(tabId, { url: next.href });
  } catch (err) {
    const url = chrome.runtime.getURL(
      `search/submit.html?engine=${engineId}&id=${id}&error=${encodeURIComponent(err.message)}`
    );
    chrome.tabs.update(tabId, { url }).catch(() => {});
  }
}

function waitForTabLoad(tabId) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error("the site is taking too long to respond"));
    }, 20000);
    function listener(id, info) {
      if (id === tabId && info.status === "complete") {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

// --- Audio --------------------------------------------------------------------

let listening = null; // { tabId, index, pageUrl, pageTitle } while a tab is being listened to

async function startListening(tab, streamId) {
  if (!tab?.id) throw new Error("No active tab.");
  if (listening) throw new Error("Seehear is already listening to a tab.");
  try {
    streamId ||= await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
  } catch {
    throw new Error("This tab can't be listened to (page protected by the browser?). Try the microphone.");
  }
  listening = { tabId: tab.id, index: tab.index, pageUrl: tab.url, pageTitle: tab.title, favicon: tab.favIconUrl };

  try {
    // Floating "listening" card on the page (not possible on protected pages: fine).
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content/listening.js"] }).catch(() => {});
    // Text next to the playing video (a Facebook caption often names the song):
    // the fallback search when the sound itself isn't recognized.
    const [context] = await chrome.scripting
      .executeScript({ target: { tabId: tab.id }, func: readMediaContext })
      .catch(() => []);
    listening.context = context?.result || "";

    if (!(await chrome.offscreen.hasDocument())) {
      await chrome.offscreen.createDocument({
        url: "offscreen/offscreen.html",
        reasons: ["USER_MEDIA"],
        justification: "Listen to the tab's audio to identify the music playing.",
      });
    }
    chrome.runtime.sendMessage({ target: "offscreen", type: "fs:listen", streamId, lang: chrome.i18n.getUILanguage() }).catch(() => {});
  } catch (err) {
    listening = null;
    chrome.offscreen.closeDocument().catch(() => {});
    throw err;
  }
}

// Runs in the page (must be self-contained): returns the caption of the post
// or video that is playing, without the "Like / Comment / Share" clutter.
function readMediaContext() {
  const media = [...document.querySelectorAll("video, audio")];
  const playing = media.find((m) => !m.paused && m.currentTime > 0) || media.find((m) => !m.paused);
  if (!playing) return "";
  let node = playing;
  for (let i = 0; i < 15 && node.parentElement; i++) {
    node = node.parentElement;
    if (node.matches('[role="article"], article, ytd-watch-metadata, ytd-reel-video-renderer')) break;
  }
  const message = node.querySelector('[data-ad-comet-preview="message"], [data-ad-preview="message"], h1');
  const text = message?.innerText || node.innerText || "";
  const ui = /^(j'aime|commenter|partager|envoyer|suivre|s'abonner|plus|voir|like|comment|share|send|follow|subscribe|more|reels?|\d[\d\s,.]*\s*\w{0,12})$/i;
  return text
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line.length >= 6 && line.length <= 220 && !ui.test(line))
    .slice(0, 2)
    .join(" · ")
    .slice(0, 240);
}

// The listened tab was closed: cancel, which also closes the offscreen document.
chrome.tabs.onRemoved.addListener((tabId) => {
  if (listening?.tabId === tabId) stopListening(false);
});

function stopListening(finish) {
  if (!listening) return;
  chrome.runtime.sendMessage({ target: "offscreen", type: "fs:listen-stop", finish }).catch(() => {});
}

function toListeningTab(msg) {
  if (listening) chrome.tabs.sendMessage(listening.tabId, msg).catch(() => {});
}

async function finishListening(msg) {
  const session = listening;
  listening = null;
  chrome.offscreen.closeDocument().catch(() => {});
  if (!session) return;

  if (msg.type === "fs:listen-error") {
    chrome.tabs.sendMessage(session.tabId, msg).catch(() => {});
    return;
  }
  const { result } = msg;
  chrome.tabs.sendMessage(session.tabId, { type: "fs:listen-done", track: result.track, cancelled: result.cancelled }).catch(() => {});
  if (result.cancelled) return;

  const { tabId, ...page } = session;
  const id = await storeRecording({ ...result, ...page, origin: "tab" });
  chrome.tabs.create({ url: chrome.runtime.getURL(`search/audio.html?id=${id}`), index: session.index + 1, openerTabId: tabId });
}

function openSearchPage(id, tab) {
  chrome.tabs.create({
    url: chrome.runtime.getURL(`search/search.html?id=${id}`),
    index: tab ? tab.index + 1 : undefined,
    openerTabId: tab?.id,
  });
}
