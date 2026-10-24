// Hidden document that owns the tab audio capture: service workers can't use
// getUserMedia or Web Audio. The captured audio is played back so the tab
// stays audible while Seehear listens.
import { listen, samplesToBase64 } from "../lib/listen.js";

let controller = null;
const send = (msg) => chrome.runtime.sendMessage(msg).catch(() => {});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.target !== "offscreen") return;
  if (msg.type === "fs:listen") run(msg);
  if (msg.type === "fs:listen-stop") controller?.abort(msg.finish ? "finish" : "cancel");
});

async function run({ streamId, lang }) {
  controller = new AbortController();
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId } },
      video: false,
    });
    const result = await listen(stream, {
      playback: true,
      transcribe: "track",
      lang,
      signal: controller.signal,
      onProgress: (p) => send({ type: "fs:listen-progress", ...p }),
    });
    const { samples, ...rest } = result;
    send({ type: "fs:listen-done", result: { ...rest, samples: samplesToBase64(samples) } });
  } catch (err) {
    send({ type: "fs:listen-error", error: err.message || String(err) });
  } finally {
    stream?.getTracks().forEach((t) => t.stop());
    controller = null;
  }
}
