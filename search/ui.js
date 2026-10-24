// UI pieces shared by the image and sound result pages.
import { SOCIAL_LINKS, searchShorts, searchThisWeek } from "../lib/trends.js";

export const $ = (id) => document.getElementById(id);

export function videoCard(v) {
  const a = document.createElement("a");
  a.className = "video";
  const id = encodeURIComponent(v.id);
  a.href = `https://www.youtube.com/watch?v=${id}`;
  a.target = "_blank";
  a.rel = "noopener";
  a.innerHTML = `
    <div class="thumb"><img loading="lazy" alt=""><span class="duration"></span></div>
    <p class="title"></p>
    <p class="info"></p>`;
  a.querySelector("img").src = `https://i.ytimg.com/vi/${id}/mqdefault.jpg`;
  const duration = a.querySelector(".duration");
  duration.textContent = v.length;
  duration.hidden = !v.length;
  a.querySelector(".title").textContent = v.title;
  a.title = v.title;
  a.querySelector(".info").textContent = [v.channel, v.views, v.published].filter(Boolean).join(" · ");
  return a;
}

export function videoMessage(text) {
  return Object.assign(document.createElement("p"), { className: "video-msg", textContent: text });
}

export function videoSkeletons(count = 3) {
  return Array.from({ length: count }, () => {
    const div = document.createElement("div");
    div.className = "video skeleton";
    div.innerHTML = `<div class="thumb"></div><p class="title"></p><p class="info"></p>`;
    return div;
  });
}

export function linkPill(name, href) {
  return Object.assign(document.createElement("a"), { href, textContent: name, target: "_blank", rel: "noopener" });
}

export function shortCard(s) {
  const a = document.createElement("a");
  a.className = "short";
  a.href = `https://www.youtube.com/shorts/${encodeURIComponent(s.id)}`;
  a.target = "_blank";
  a.rel = "noopener";
  a.title = s.title;
  a.innerHTML = `<div class="thumb"><img loading="lazy" alt=""><span class="views"></span></div><p class="title"></p>`;
  a.querySelector("img").src = s.thumb;
  a.querySelector(".views").textContent = s.views;
  a.querySelector(".views").hidden = !s.views;
  a.querySelector(".title").textContent = s.title;
  return a;
}

function shortSkeletons(count = 6) {
  return Array.from({ length: count }, () => {
    const div = document.createElement("div");
    div.className = "short skeleton";
    div.innerHTML = `<div class="thumb"></div><p class="title"></p>`;
    return div;
  });
}

// Wires the prev/next buttons of a .rail and keeps its .can-prev / .can-next
// classes in sync with the scroll position, the size and the content.
function initRail(rail) {
  if (rail.dataset.ready) return;
  rail.dataset.ready = "1";
  const scroller = rail.querySelector(".shorts");
  const update = () => {
    const max = scroller.scrollWidth - scroller.clientWidth;
    rail.classList.toggle("can-prev", scroller.scrollLeft > 4);
    rail.classList.toggle("can-next", scroller.scrollLeft < max - 4);
  };
  const page = (dir) => scroller.scrollBy({ left: dir * scroller.clientWidth * 0.85 });
  rail.querySelector(".prev").addEventListener("click", () => page(-1));
  rail.querySelector(".next").addEventListener("click", () => page(1));
  scroller.addEventListener("scroll", update, { passive: true });
  new ResizeObserver(update).observe(scroller);
  new MutationObserver(update).observe(scroller, { childList: true });
  update();
}

// "On social media": TikTok / Instagram / Facebook links, popular Shorts and
// this week's uploads for `query`. Needs the #socialCard markup in the page.
let socialRun = 0;

export function renderSocial(query) {
  const run = ++socialRun;
  $("socialCard").hidden = false;
  initRail($("shortsRail"));
  $("socialLinks").replaceChildren(
    ...SOCIAL_LINKS.map((l) => {
      const a = linkPill(l.name, l.url(query));
      a.style.setProperty("--dot", l.color);
      return a;
    })
  );
  $("shorts").replaceChildren(...shortSkeletons());
  $("recent").replaceChildren(...videoSkeletons());

  const fill = (id, promise, card, empty) =>
    promise
      .then((items) => run === socialRun && $(id).replaceChildren(...(items.length ? items.map(card) : [videoMessage(empty)])))
      .catch(() => run === socialRun && $(id).replaceChildren(videoMessage("Can't load these videos right now.")));
  fill("shorts", searchShorts(query), shortCard, "No Shorts found for this search.");
  fill("recent", searchThisWeek(query), videoCard, "Nothing new this week for this search.");
}

export function hideSocial() {
  socialRun++;
  $("socialCard").hidden = true;
}

let toastTimer;
export function toast(text) {
  const el = $("toast");
  el.textContent = text;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2200);
}
