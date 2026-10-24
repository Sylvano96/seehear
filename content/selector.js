// Injected on demand: draws a full-viewport overlay so the user can frame a
// region. The overlay lives in a closed shadow root so page CSS can't touch it.
(() => {
  if (window.__seehearSelecting) return;
  window.__seehearSelecting = true;

  const host = document.createElement("div");
  host.style.cssText = "all:initial;position:fixed;inset:0;z-index:2147483647;";
  const root = host.attachShadow({ mode: "closed" });

  root.innerHTML = `
    <style>
      :host { all: initial; }
      .layer {
        position: fixed; inset: 0; cursor: crosshair;
        background: rgba(10, 12, 20, 0.45);
        font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
        user-select: none; -webkit-user-select: none;
      }
      .layer.dragging { background: transparent; }
      .box {
        position: fixed; display: none;
        border: 2px solid #9b4dff; border-radius: 4px;
        box-shadow: 0 0 0 100vmax rgba(10, 12, 20, 0.45);
        background: transparent;
      }
      .size {
        position: absolute; right: -2px; bottom: -28px;
        padding: 3px 8px; border-radius: 6px;
        background: linear-gradient(135deg, #5b5cff, #9b4dff); color: #fff; font-size: 12px; font-weight: 600;
        white-space: nowrap;
      }
      .hint {
        position: fixed; top: 18px; left: 50%; transform: translateX(-50%);
        padding: 10px 18px; border-radius: 999px;
        background: rgba(20, 20, 30, 0.92); color: #fff; font-size: 14px;
        box-shadow: 0 8px 24px rgba(0,0,0,.35);
        pointer-events: none; white-space: nowrap;
      }
      .hint b { color: #c9a8ff; }
      .layer.dragging .hint { opacity: 0; }
    </style>
    <div class="layer">
      <div class="hint">Drag around the image to search · <b>Click</b> = whole screen · <b>Esc</b> to cancel</div>
      <div class="box"><span class="size"></span></div>
    </div>
  `;

  const layer = root.querySelector(".layer");
  const box = root.querySelector(".box");
  const sizeLabel = root.querySelector(".size");
  let start = null;
  let rect = null;

  function cleanup() {
    window.removeEventListener("keydown", onKey, true);
    host.remove();
    window.__seehearSelecting = false;
  }

  function onKey(e) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      cleanup();
    }
  }

  // Only real user input counts: synthetic events (dispatched by a script) are ignored.
  layer.addEventListener("pointerdown", (e) => {
    if (!e.isTrusted || e.button !== 0) return;
    e.preventDefault();
    layer.setPointerCapture(e.pointerId);
    start = { x: e.clientX, y: e.clientY };
    rect = null;
  });

  layer.addEventListener("pointermove", (e) => {
    if (!e.isTrusted || !start) return;
    const x = Math.min(start.x, e.clientX);
    const y = Math.min(start.y, e.clientY);
    const width = Math.abs(e.clientX - start.x);
    const height = Math.abs(e.clientY - start.y);
    if (width < 4 && height < 4) return;
    rect = { x, y, width, height };
    layer.classList.add("dragging");
    box.style.display = "block";
    box.style.left = `${x}px`;
    box.style.top = `${y}px`;
    box.style.width = `${width}px`;
    box.style.height = `${height}px`;
    sizeLabel.textContent = `${Math.round(width)} × ${Math.round(height)}`;
  });

  layer.addEventListener("pointerup", async (e) => {
    if (!e.isTrusted || !start) return;
    start = null;
    // A simple click (no drag, or a tiny box) captures the whole visible page.
    const region =
      rect && rect.width >= 10 && rect.height >= 10
        ? rect
        : { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight };

    cleanup();
    // Let the browser repaint without the overlay before the screenshot.
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    await new Promise((r) => setTimeout(r, 40));

    chrome.runtime.sendMessage({
      type: "fs:region",
      rect: region,
      viewportWidth: window.innerWidth,
      pageUrl: location.href,
    });
  });

  window.addEventListener("keydown", onKey, true);
  (document.body || document.documentElement).appendChild(host);
})();
