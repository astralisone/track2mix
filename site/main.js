/* Track2Mix site — the download form, the tip links, the live Camelot wheel, the hover
 * descriptions in "Everything it does", and the entrances.
 *
 * One constant needs filling in before launch: PAYMENTS, documented in site/README.md.
 */

/* ------------------------------------------------------------------ config */

/** The site's own Worker (worker/contact.js), which stores the contact and returns the link. */
const CONTACT_ENDPOINT = "/api/contact";

/**
 * Payment methods for the tip links. paypalMe is the paypal.me handle; koFi and githubSponsors are
 * optional and unused by the page unless set.
 */
const PAYMENTS = {
  paypalMe: "astralisboss",
  koFi: "",
  githubSponsors: "",
};

const TIP_CURRENCY = "USD";

/** PayPal.me carries the amount as a path segment, not a query parameter. */
function paypalUrlFor(amount) {
  return `https://paypal.me/${encodeURIComponent(PAYMENTS.paypalMe)}/${amount}${TIP_CURRENCY}`;
}

/* ------------------------------------------------------------------- utils */

function setMsg(el, state, text) {
  if (!el) return;
  el.dataset.state = state;
  el.textContent = text;
}

const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/* ------------------------------------------- gated download: name + email */

const form = document.getElementById("signup-form");
const nameInput = document.getElementById("name");
const input = document.getElementById("email");
const submit = document.getElementById("signup-submit");
const formMsg = document.getElementById("form-msg");
const downloadReady = document.getElementById("download-ready");
const downloadLink = document.getElementById("dl-link");

/** Deliberately permissive: reject only what is obviously not an address. */
function looksLikeEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value);
}

if (form) {
  form.addEventListener("submit", async (event) => {
    event.preventDefault();

    const name = nameInput.value.trim();
    if (name.length < 2) {
      setMsg(formMsg, "error", "Please enter your name.");
      nameInput.focus();
      return;
    }

    const email = input.value.trim();
    if (!looksLikeEmail(email)) {
      setMsg(formMsg, "error", "That doesn't look like an email address. Check it and try again.");
      input.focus();
      return;
    }

    submit.disabled = true;
    const originalLabel = submit.textContent;
    submit.textContent = "Sending…";
    setMsg(formMsg, "", "");

    try {
      const response = await fetch(CONTACT_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ name, email }),
      });

      let payload = null;
      try {
        payload = await response.json();
      } catch {
        // A non-JSON body means the endpoint didn't run; the status message below covers it.
      }

      if (!response.ok) {
        throw new Error(payload?.error || `${response.status} ${response.statusText}`);
      }
      if (!payload?.download_url) {
        throw new Error("the server didn't return a download link");
      }

      downloadLink.href = payload.download_url;
      form.hidden = true;
      downloadReady.hidden = false;
      setMsg(formMsg, "ok", `Thanks ${name}, you're on the list.`);
      downloadLink.focus();

      if (Array.isArray(payload.warnings) && payload.warnings.length) {
        console.warn("Track2Mix site: contact saved with warnings:", payload.warnings);
      }
    } catch (error) {
      setMsg(formMsg, "error", `Couldn't sign you up: ${error.message}. Please try again.`);
      console.error("Track2Mix site: contact POST failed.", error);
    } finally {
      submit.disabled = false;
      submit.textContent = originalLabel;
    }
  });
}

/* ------------------------------------------------------------- tip links */

const tipMsg = document.getElementById("tip-msg");
const tiers = Array.from(document.querySelectorAll("a.tier[data-amount]"));

if (PAYMENTS.paypalMe) {
  // A business account's PayPal.Me lands on its profile and drops the amount, so the payer taps Pay
  // and types it; the note below keeps that from looking like a broken link.
  for (const tier of tiers) {
    tier.href = paypalUrlFor(tier.dataset.amount);
    tier.target = "_blank";
    tier.rel = "noopener noreferrer";
  }
  setMsg(tipMsg, "", "Each opens PayPal. Tap Pay there and enter the amount you picked.");
} else {
  for (const tier of tiers) {
    tier.removeAttribute("href");
    tier.setAttribute("aria-disabled", "true");
  }
  setMsg(tipMsg, "error", "The tip links aren't connected yet. The app is still free to download.");
  console.error("Track2Mix site: PAYMENTS.paypalMe is empty (see site/README.md).");
}

/* ------------------------------------------------- the live Camelot wheel */

/**
 * Tap a key: the four slots that mix with it light up and the shortlist beside the wheel re-ranks
 * from the sample library. Without script the wheel shows 8A, which is what the static rows say.
 */
const wheel = document.getElementById("wheel");
const wheelLabel = document.getElementById("wheel-label");
const shortlistRows = Array.from(document.querySelectorAll(".shortlist .tbl-row"));
const shortlistFoot = document.getElementById("shortlist-foot");

function keyParts(key) {
  const m = /^(\d{1,2})([AB])$/.exec(key);
  return m ? { n: Number(m[1]), l: m[2] } : null;
}
function keyName(n, l) {
  return `${((n + 11) % 12) + 1}${l}`;
}
function compatible(key) {
  const k = keyParts(key);
  if (!k) return [];
  return [key, keyName(k.n + 1, k.l), keyName(k.n - 1, k.l), keyName(k.n, k.l === "A" ? "B" : "A")];
}

// Sample rows for the panel, in the order the app would rank them for any anchor.
const SAMPLE = [
  { title: "Anchor · the track you’re on", artist: "Your library", bpm: 174, rel: "same", e: 78, anchor: true },
  { title: "Same key, harder", artist: "—", bpm: 174, rel: "same", e: 81 },
  { title: "Relative major", artist: "—", bpm: 173, rel: "rel", e: 72 },
  { title: "One step up the wheel", artist: "—", bpm: 176, rel: "up", e: 88 },
  { title: "Energy drop", artist: "—", bpm: 172, rel: "down", e: 41 },
  { title: "One step down", artist: "—", bpm: 175, rel: "down", e: 63 },
  { title: "Half time", artist: "—", bpm: 87, rel: "same", e: 35 },
];

function setAnchor(key) {
  const k = keyParts(key);
  if (!k || !wheel) return;
  const ok = new Set(compatible(key));
  for (const g of wheel.querySelectorAll("g[data-key]")) {
    const seg = g.querySelector(".seg");
    const label = g.querySelector(".wl");
    const isAnchor = g.dataset.key === key;
    seg.classList.toggle("seg-anchor", isAnchor);
    seg.classList.toggle("seg-ok", !isAnchor && ok.has(g.dataset.key));
    label.classList.toggle("wl-hot", ok.has(g.dataset.key));
    g.setAttribute("aria-pressed", String(isAnchor));
  }
  const rel = {
    same: key,
    rel: keyName(k.n, k.l === "A" ? "B" : "A"),
    up: keyName(k.n + 1, k.l),
    down: keyName(k.n - 1, k.l),
  };
  // Relative major reads differently when the anchor is already major.
  SAMPLE[2].title = k.l === "A" ? "Relative major" : "Relative minor";
  shortlistRows.forEach((row, i) => {
    const s = SAMPLE[i];
    if (!s) return;
    const chip = row.querySelector(".keychip");
    chip.textContent = rel[s.rel];
    chip.classList.toggle("match", s.rel === "same");
    row.querySelector(".cell-title").textContent = s.title;
  });
  if (wheelLabel) wheelLabel.textContent = `Anchor ${key} · four of twenty-four slots mix`;
  if (shortlistFoot) shortlistFoot.textContent = `${shortlistRows.length} of 8,412 tracks · ±3 BPM · harmonic with ${key}`;
}

if (wheel) {
  for (const g of wheel.querySelectorAll("g[data-key]")) {
    g.setAttribute("role", "button");
    g.setAttribute("tabindex", "0");
    g.setAttribute("aria-label", `Anchor ${g.dataset.key}`);
    g.addEventListener("click", () => setAnchor(g.dataset.key));
    g.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        setAnchor(g.dataset.key);
      }
    });
  }
  setAnchor("8A");
}

/* ----------------------------------------- everything it does: hover copy */

const namesDesc = document.getElementById("names-desc");
const nameButtons = Array.from(document.querySelectorAll(".names-list button[data-d]"));
let onButton = null;

function showDesc(button) {
  if (!namesDesc) return;
  if (onButton) onButton.classList.remove("is-on");
  onButton = button;
  button.classList.add("is-on");
  namesDesc.textContent = button.dataset.d;
}

for (const button of nameButtons) {
  button.addEventListener("pointerenter", () => showDesc(button));
  button.addEventListener("focus", () => showDesc(button));
  button.addEventListener("click", () => showDesc(button));
}

/* ------------------------------------------------------ cards: fallback */

// Without scroll-driven animations the cards stand in a row that scrolls sideways.
if (!CSS.supports("animation-timeline: view()")) {
  document.documentElement.classList.add("cards-static");
}

/* ------------------------------------------------------------- entrances */

/**
 * Each section's parts rise into place as they enter, driven by the scroll (styles.css, "reveal").
 * The classes are added here so nothing is ever held back without scripting.
 */
if (!prefersReducedMotion && CSS.supports("animation-timeline: view()")) {
  const groups = [
    ".band-head, .band .panel, .band-caption",
    ".names-head, .names-col, .names-desc",
    ".lineup-day, .lineup-row",
    ".reply-aside, .reply-card",
    ".q-row",
  ];
  for (const selector of groups) {
    let i = 0;
    for (const el of document.querySelectorAll(selector)) {
      el.classList.add("reveal");
      if (el.classList.contains("lineup-row")) el.classList.add("reveal-row");
      el.style.setProperty("--i", String(Math.min(i, 6)));
      i += 1;
    }
  }
}

/* ------------------------------------------------------- the moving picture */

const loop = document.querySelector(".verb-video");
if (loop) {
  if (prefersReducedMotion) {
    loop.removeAttribute("autoplay");
    loop.pause();
  } else {
    // Play only while on screen; a loop nobody can see is wasted work.
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting) loop.play().catch(() => {});
        else loop.pause();
      }
    });
    io.observe(loop);
  }
}
