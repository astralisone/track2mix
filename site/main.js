/* Track2Mix site: the download form, the tip links, and the event display. */

/* ------------------------------------------------------------------ config */

/** The site's own Worker (worker/contact.js), which stores the contact and returns the link. */
const CONTACT_ENDPOINT = "/api/contact";

/** paypalMe is the paypal.me handle of the account that receives tips. */
const PAYMENTS = {
  paypalMe: "astralisboss",
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
      setMsg(formMsg, "error", "Enter your name to get the link.");
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
      setMsg(formMsg, "error", `Couldn't sign you up: ${error.message}. Try again in a moment.`);
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
  // and types it; the note keeps that from looking like a broken link.
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
}

/* --------------------------------------------------------- event display */

/**
 * The signature interaction: a track under the pointer, focused, or tapped isolates itself and
 * dims the rest; leaving restores the whole event. Keyboard: Tab to a track, Enter or Space to
 * hold it, Escape to release. The draw-in on load is CSS; this only adds the ticks and the state.
 */
const display = document.getElementById("display");

if (display) {
  const svg = display.querySelector("svg");
  const hits = Array.from(svg.querySelectorAll(".hit"));
  const ticks = svg.querySelector(".ticks");

  // Fine ticks around the outer ring, like a detector's segmentation.
  if (ticks) {
    const parts = [];
    for (let i = 0; i < 72; i += 1) {
      const a = (i / 72) * Math.PI * 2;
      const long = i % 6 === 0;
      const r1 = long ? 426 : 433;
      const x1 = Math.cos(a) * r1, y1 = Math.sin(a) * r1;
      const x2 = Math.cos(a) * 440, y2 = Math.sin(a) * 440;
      parts.push(`<line class="ring-tick" x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}"/>`);
    }
    ticks.innerHTML = parts.join("");
  }

  // The calorimeter barrel: a ring of segments just outside the outer ring, where the energy
  // stacks of the surviving tracks start.
  const barrel = svg.querySelector(".barrel");
  if (barrel) {
    const segs = [];
    const n = 60, r1 = 444, r2 = 451, gap = 0.012;
    for (let i = 0; i < n; i += 1) {
      const a0 = (i / n) * Math.PI * 2 + gap, a1 = ((i + 1) / n) * Math.PI * 2 - gap;
      const p = (r, a) => `${(Math.cos(a) * r).toFixed(1)} ${(Math.sin(a) * r).toFixed(1)}`;
      segs.push(`<path d="M${p(r1, a0)} A${r1} ${r1} 0 0 1 ${p(r1, a1)} L${p(r2, a1)} A${r2} ${r2} 0 0 0 ${p(r2, a0)} Z"/>`);
    }
    barrel.innerHTML = segs.join("");
  }

  let held = null;

  function isolate(hit) {
    svg.classList.toggle("isolating", !!hit);
    for (const h of hits) h.classList.toggle("is-on", h === hit);
  }

  for (const hit of hits) {
    hit.addEventListener("pointerenter", () => { if (!held) isolate(hit); });
    hit.addEventListener("pointerleave", () => { if (!held) isolate(null); });
    hit.addEventListener("focus", () => isolate(hit));
    hit.addEventListener("blur", () => { if (held !== hit) isolate(null); });
    hit.addEventListener("click", () => {
      held = held === hit ? null : hit;
      isolate(held || hit);
      if (!held) isolate(null);
    });
    hit.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); hit.click(); }
      if (event.key === "Escape") { held = null; isolate(null); hit.blur(); }
    });
  }

  // The tracks draw outward from the collision once, on load.
  if (!prefersReducedMotion) {
    for (const path of svg.querySelectorAll(".track")) {
      const length = path.getTotalLength();
      path.style.setProperty("--len", length.toFixed(1));
    }
    svg.classList.add("draw");
  }
}
