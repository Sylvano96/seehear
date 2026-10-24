// Injected while Seehear listens to the tab: a small floating card with a live
// sound meter, so the user can stay on the page (Facebook, YouTube…) and see
// what is happening. Lives in a closed shadow root so page CSS can't touch it.
(() => {
  window.__seehearListening?.remove();

  const host = document.createElement("div");
  host.style.cssText = "all:initial;position:fixed;right:20px;bottom:20px;z-index:2147483647;";
  const root = host.attachShadow({ mode: "closed" });
  const BARS = 5;

  root.innerHTML = `
    <style>
      :host { all: initial; }
      .card {
        width: 320px; box-sizing: border-box; padding: 14px; border-radius: 18px;
        display: grid; grid-template-columns: auto 1fr auto; gap: 12px; align-items: center;
        background: rgba(18, 17, 28, 0.94); color: #f4f3fa;
        font: 13px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif;
        box-shadow: 0 18px 50px rgba(0, 0, 0, .45), inset 0 0 0 1px rgba(255, 255, 255, .08);
        backdrop-filter: blur(14px);
        animation: in .35s cubic-bezier(.2, .9, .3, 1.2);
      }
      .card.out { animation: out .3s ease forwards; }
      @keyframes in { from { opacity: 0; transform: translateY(16px) scale(.96); } }
      @keyframes out { to { opacity: 0; transform: translateY(16px) scale(.96); } }

      .orb {
        position: relative; width: 48px; height: 48px; border-radius: 50%;
        display: grid; place-items: center; overflow: visible;
        background: linear-gradient(135deg, #5b5cff, #9b4dff 55%, #ff4f8b);
      }
      .orb::before, .orb::after {
        content: ""; position: absolute; inset: 0; border-radius: 50%;
        border: 2px solid rgba(155, 77, 255, .55);
        animation: ring 1.8s ease-out infinite;
      }
      .orb::after { animation-delay: .9s; }
      .done .orb::before, .done .orb::after, .error .orb::before, .error .orb::after { display: none; }
      @keyframes ring { from { transform: scale(1); opacity: .9; } to { transform: scale(1.9); opacity: 0; } }
      .bars { display: flex; align-items: center; gap: 3px; height: 22px; }
      .bars i { width: 3px; height: 4px; border-radius: 2px; background: #fff; transition: height .1s; }
      .cover { width: 48px; height: 48px; border-radius: 10px; object-fit: cover; display: none; }
      .done.has-cover .orb { display: none; }
      .done.has-cover .cover { display: block; }

      .text { min-width: 0; }
      .title { font-weight: 700; font-size: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .sub {
        color: #b6b3cc; font-size: 12px; margin-top: 2px;
        display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
      }
      .progress { height: 3px; margin-top: 8px; border-radius: 3px; background: rgba(255, 255, 255, .12); overflow: hidden; }
      .progress div { height: 100%; width: 0; background: linear-gradient(90deg, #5b5cff, #9b4dff, #ff4f8b); transition: width .1s linear; }
      .done .progress, .error .progress { display: none; }

      .actions { display: grid; gap: 6px; }
      button {
        all: unset; cursor: pointer; text-align: center;
        padding: 5px 10px; border-radius: 8px; font: 600 12px/1.2 system-ui, sans-serif;
        background: rgba(255, 255, 255, .1); color: #fff;
      }
      button:hover { background: rgba(255, 255, 255, .18); }
      button:focus-visible { outline: 2px solid #c9a8ff; }
      button.primary { background: linear-gradient(135deg, #5b5cff, #9b4dff); }
      button.primary:hover { filter: brightness(1.1); }
      .done .finish { display: none; }
    </style>
    <div class="card" role="status" aria-live="polite">
      <div class="orb"><div class="bars">${"<i></i>".repeat(BARS)}</div></div>
      <img class="cover" alt="">
      <div class="text">
        <div class="title">Seehear is listening…</div>
        <div class="sub">Let the music play…</div>
        <div class="progress"><div></div></div>
      </div>
      <div class="actions">
        <button class="primary finish" type="button">Finish</button>
        <button class="close" type="button">Cancel</button>
      </div>
    </div>
  `;

  const $ = (sel) => root.querySelector(sel);
  const card = $(".card");
  const bars = [...root.querySelectorAll(".bars i")];
  let closed = false;

  function remove(delay = 0) {
    if (closed) return;
    closed = true;
    clearTimeout(watchdog);
    chrome.runtime.onMessage.removeListener(onMessage);
    setTimeout(() => {
      card.classList.add("out");
      setTimeout(() => host.remove(), 300);
    }, delay);
  }
  window.__seehearListening = {
    remove() {
      chrome.runtime.onMessage.removeListener(onMessage);
      host.remove();
    },
  };

  $(".finish").addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "fs:listen-stop", finish: true });
    $(".sub").textContent = "Analyzing what was heard…";
  });
  $(".close").addEventListener("click", () => {
    if (!card.classList.contains("done") && !card.classList.contains("error")) {
      chrome.runtime.sendMessage({ type: "fs:listen-stop", finish: false });
    }
    remove();
  });

  // Safety net: if the extension stops talking to us (reloaded, crashed),
  // don't leave the card and its listener on the page.
  let watchdog = setTimeout(() => remove(), 30000);

  function onMessage(msg) {
    clearTimeout(watchdog);
    if (!closed) watchdog = setTimeout(() => remove(), 30000);
    if (msg?.type === "fs:listen-progress") {
      bars.forEach((bar, i) => {
        const wave = 0.55 + 0.45 * Math.sin(Date.now() / 120 + i * 1.3);
        bar.style.height = `${4 + Math.round(msg.level * wave * 18)}px`;
      });
      $(".progress div").style.width = `${Math.min(100, (msg.elapsed / msg.total) * 100)}%`;
      if (msg.transcript) $(".sub").textContent = `“${msg.transcript.slice(-90)}”`;
    }

    if (msg?.type === "fs:listen-done") {
      if (msg.cancelled) return remove();
      card.classList.add("done");
      $(".close").textContent = "Close";
      if (msg.track) {
        $(".title").textContent = msg.track.title;
        $(".sub").textContent = `${msg.track.artist} · opening results…`;
        if (msg.track.cover) {
          $(".cover").src = msg.track.cover;
          card.classList.add("has-cover");
        }
      } else {
        $(".title").textContent = "Done listening";
        $(".sub").textContent = "Opening results…";
      }
      remove(3500);
    }

    if (msg?.type === "fs:listen-error") {
      card.classList.add("error");
      $(".title").textContent = "Can't listen";
      $(".sub").textContent = msg.error;
      $(".finish").style.display = "none";
      $(".close").textContent = "Close";
      remove(7000);
    }
  }

  chrome.runtime.onMessage.addListener(onMessage);
  (document.body || document.documentElement).appendChild(host);
})();
