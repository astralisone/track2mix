/* Track2Mix site — email capture and tip-jar wiring.
 *
 * Two constants need filling in before launch. Both are documented in
 * site/README.md. Neither fails silently: if a constant is empty, the affected
 * control tells the visitor it isn't wired up and logs the reason, rather than
 * pretending to work.
 */

/* ------------------------------------------------------------------ config */

/**
 * Where the contact form posts. This is the site's own Cloudflare Worker
 * (worker/contact.js, routed there by worker/index.js), which writes to the
 * central D1 contacts database and subscribes the person to the mailing list.
 * The database binding and the list credential live server-side, so nothing
 * secret appears in this file. The download URL is returned by that endpoint
 * rather than hardcoded here, so it is not in the page source before someone
 * fills the form in.
 */
const CONTACT_ENDPOINT = "/api/contact";

/**
 * Payment methods for the tip jar. Fill in the handles you actually have and
 * leave the rest empty — each renders only when configured, and the section
 * says so honestly when none are.
 *
 *   paypalMe        your paypal.me handle, e.g. "gregstarr" for paypal.me/gregstarr
 *                   Zero setup, and the only one of these that accepts a
 *                   prefilled amount, so the tier buttons deep-link to it.
 *   koFi            your ko-fi.com handle. 0% platform fee on one-off tips and
 *                   it takes cards and Apple Pay, which covers people without
 *                   a PayPal account.
 *   githubSponsors  your GitHub username. 0% fee, one-off or monthly, and it
 *                   fits an open-source project.
 */
const PAYMENTS = {
  paypalMe: "",
  koFi: "",
  githubSponsors: "",
};

/** Currency the suggested tier amounts are denominated in. */
const TIP_CURRENCY = "USD";

/**
 * PayPal.me carries the amount as a PATH segment, not a query parameter:
 * paypal.me/<handle>/15USD. A ?amount= would be ignored and the payer would
 * land on a blank amount field.
 */
function paypalUrlFor(amount) {
  return `https://paypal.me/${encodeURIComponent(PAYMENTS.paypalMe)}/${amount}${TIP_CURRENCY}`;
}

/* ------------------------------------------------------------------- utils */

function setMsg(el, state, text) {
  el.dataset.state = state;
  el.textContent = text;
}

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
    setMsg(formMsg, "error", "That doesn't look like an email address — check it and try again.");
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
      // A non-JSON body means the function didn't run — a deploy problem, not
      // a validation one. Fall through to the status-code message below.
    }

    if (!response.ok) {
      throw new Error(payload?.error || `${response.status} ${response.statusText}`);
    }
    if (!payload?.download_url) {
      throw new Error("the server didn't return a download link");
    }

    // The gate only opens here, and the link arrives with this response.
    downloadLink.href = payload.download_url;
    form.hidden = true;
    downloadReady.hidden = false;
    setMsg(formMsg, "ok", `Thanks ${name} — you're on the list.`);
    downloadLink.focus();

    // A list outage still captured the contact and still grants the download,
    // but it means no email is coming, so don't let it pass unnoticed.
    if (Array.isArray(payload.warnings) && payload.warnings.length) {
      console.warn("Track2Mix site: contact saved with warnings:", payload.warnings);
    }
  } catch (error) {
    // Show the real failure: a vague "something went wrong" costs signups and
    // hides outages.
    setMsg(formMsg, "error", `Couldn't sign you up: ${error.message}. Please try again.`);
    console.error("Track2Mix site: contact POST failed.", error);
  } finally {
    submit.disabled = false;
    submit.textContent = originalLabel;
  }
});

/* ------------------------------------------------------------- tip jar */

const tipMsg = document.getElementById("tip-msg");
const tiers = Array.from(document.querySelectorAll("#tip-tiers .tier"));
const altPayments = document.getElementById("alt-payments");

/** Wire one alternative-method link, or remove it if it isn't configured. */
function wireAlt(id, url) {
  const el = document.getElementById(id);
  if (!el) return false;
  if (!url) {
    el.remove();
    return false;
  }
  el.href = url;
  el.target = "_blank";
  el.rel = "noopener noreferrer";
  return true;
}

const koFiUrl = PAYMENTS.koFi ? `https://ko-fi.com/${encodeURIComponent(PAYMENTS.koFi)}` : "";
const sponsorsUrl = PAYMENTS.githubSponsors
  ? `https://github.com/sponsors/${encodeURIComponent(PAYMENTS.githubSponsors)}`
  : "";

const haveKoFi = wireAlt("pay-kofi", koFiUrl);
const haveSponsors = wireAlt("pay-sponsors", sponsorsUrl);

// With both links removed the row would render as a bare "Or".
if (altPayments && !haveKoFi && !haveSponsors) altPayments.hidden = true;

if (PAYMENTS.paypalMe) {
  // PayPal is the only provider that takes a prefilled amount, so the tiers
  // point at it.
  for (const tier of tiers) {
    const amount = tier.dataset.amount;
    if (!amount) {
      console.error("Track2Mix site: a .tier element is missing data-amount.", tier);
      continue;
    }
    tier.href = paypalUrlFor(amount);
    tier.target = "_blank";
    tier.rel = "noopener noreferrer";
  }
} else if (haveKoFi || haveSponsors) {
  // No PayPal handle, but another method exists: send the tiers there. The
  // amount can't be prefilled, so say so rather than letting it look broken.
  const fallback = koFiUrl || sponsorsUrl;
  for (const tier of tiers) {
    tier.href = fallback;
    tier.target = "_blank";
    tier.rel = "noopener noreferrer";
  }
  setMsg(tipMsg, "", "Pick any amount on the next page.");
} else {
  // Nothing configured: disable rather than link nowhere, and name the fix.
  for (const tier of tiers) {
    tier.setAttribute("aria-disabled", "true");
    tier.removeAttribute("href");
  }
  if (altPayments) altPayments.hidden = true;
  setMsg(tipMsg, "error", "The tip jar isn't connected yet — the app is still free to download.");
  console.error(
    "Track2Mix site: no payment method is configured in main.js. " +
      "Set at least one of PAYMENTS.paypalMe, PAYMENTS.koFi or PAYMENTS.githubSponsors " +
      "(see site/README.md)."
  );
}

/* ------------------------------------------------------- animated figures */

/**
 * Figures render in their finished state by default; the animations in
 * styles.css only apply once `.in-view` is set here. So a visitor with JS
 * disabled, a thumbnail grab, or a reduced-motion preference all get the
 * completed picture rather than something frozen mid-flight.
 */
const prefersReducedMotion = window.matchMedia(
  "(prefers-reduced-motion: reduce)"
).matches;

const figures = document.querySelectorAll("[data-animate]");

if (!prefersReducedMotion && "IntersectionObserver" in window) {
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        if (entry.target.dataset.animate === "ranking") {
          playRanking();
        } else {
          entry.target.classList.add("in-view");
        }
        // One play per figure; the replay button is the way to see it again.
        observer.unobserve(entry.target);
      }
    },
    { threshold: 0.35, rootMargin: "0px 0px -8% 0px" }
  );

  for (const figure of figures) observer.observe(figure);
}

/**
 * Replay the ranking sort. The rows are parked at their alphabetical offsets,
 * a reflow commits that position without transitioning to it, and removing the
 * class lets them travel back to the order the DOM already holds.
 */
const ranking = document.querySelector('[data-animate="ranking"]');
const replayButton = document.querySelector(".rank-replay");

function playRanking() {
  if (!ranking || prefersReducedMotion) return;
  ranking.classList.add("rank-from");
  void ranking.offsetWidth; // commit the start state before transitioning away
  ranking.classList.remove("rank-from");
}

if (replayButton) {
  if (prefersReducedMotion) {
    // Nothing to replay when motion is off — don't offer a button that no-ops.
    replayButton.remove();
  } else {
    replayButton.addEventListener("click", playRanking);
  }
}
