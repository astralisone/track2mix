# Track2Mix — go-to-market

Working plan for turning the analyzer into a product people use and tip for.
Model: **pay what you want, free if you can't afford it.** Budget: **$100.**

---

## 1. What we're actually selling

Not "AI for DJs". The claim is narrower and checkable:

> **Track2Mix tells you which tracks in your own library mix with the one you're
> playing — by key, by BPM, and by how hard they hit.**

The third of those is the differentiator. Rekordbox already gives you key and
BPM. It has no honest measure of energy, so every "compatible" list it produces
is hundreds of tracks long and unordered by feel. Track2Mix measures energy from
the audio itself and uses it to rank.

**One-line pitch:** *Rekordbox knows your keys. It doesn't know which of your
8,000 tracks belong next to each other.*

### Who it's for, in priority order

1. **DJs with 3,000+ tracks in Rekordbox who play harmonically.** Drum & bass,
   techno, tech house, trance, liquid — genres where key mixing is normal and
   libraries get large. This is the bullseye.
2. **Technical DJs who like tools.** They'll use the CLI, read the source, and
   are the ones who post about it. Disproportionately valuable per person.
3. **DJs with library anxiety.** Bought a lot, play a little, feel guilty. Large
   group, softer intent.

Not for: controllerists on 500-track libraries, open-format wedding DJs who
don't key-mix, or anyone on Serato/Traktor until a parser exists.

---

## 2. The thing that has to be true before any of this works

**The energy score has to match your ear, and the compat list has to beat
Rekordbox's Related Tracks.** The README's own validation checklist is still
unchecked. No amount of campaign fixes a tool whose suggestions are no better
than what's already free in Rekordbox.

So the first deliverable is not a launch post. It's this:

- [ ] Run a full analysis on your real library (not 500 tracks — all of it).
- [ ] Sort by energy descending. Are the top 20 genuinely your hardest tracks?
      Bottom 20 your intros and deep cuts? If it's noise, retune the weights in
      `src/features.rs` before telling anyone about this.
- [ ] Pick 5 anchor tracks you know cold. For each, write down what you'd
      actually mix into it. Then run `track2mix compat` and compare. **Record the
      hit rate.** That number is your marketing.
- [ ] Do the same 5 anchors in Rekordbox's Related Tracks. Screenshot both.

That last item is your single most valuable marketing asset: a side-by-side of
Rekordbox's suggestions against Track2Mix's, for a track the viewer can judge
themselves. It converts better than any copy on the landing page, and it's free.

If the hit rate is bad, **stop and fix the features.** That's not a delay, it's
the whole product.

---

## 3. Where the $100 goes

Paid acquisition is off the table and it's important to be blunt about why: DJ
software keywords run roughly $1–3 a click, so $100 buys somewhere around 40–90
visitors. At a generous 3% download rate that's one or two downloads. It buys
you nothing you can learn from.

Attention in this niche is free and extremely concentrated. The money should buy
**credibility and the removal of friction**, which are the two things that
actually cost money here.

### Recommended allocation

| Item | Cost | Why |
| --- | --- | --- |
| `track2mix.com` | ~$11/yr | Both `.com` and `.app` were free at time of writing. A real domain is the cheapest credibility you can buy. |
| Apple Developer Program | $99/yr | See below. The single biggest conversion lever on macOS. |
| Hosting (Cloudflare Pages) | $0 | Free TLS, free bandwidth, deploys on push. |
| Email list (Buttondown / MailerLite) | $0 | Free to 100 / 1,000 subscribers. |
| Tip jar (Ko-fi) | $0 | 0% platform fee on one-off tips. |
| Analytics (Cloudflare Web Analytics) | $0 | No cookie banner needed. |
| Binary hosting (GitHub Releases) | $0 | Versioned, fast, free. |
| Contacts store (Cloudflare D1) | $0 | Free tier covers far more than you'll need; same platform as the site. |
| Payments (PayPal.me + Ko-fi) | $0 upfront | PayPal's standard fees per transaction, 0% platform fee on Ko-fi. |
| **Total** | **~$110** | $10 over. Resolve it one of the two ways below. |

### The $10 problem, and how to resolve it

Domain plus Apple enrolment is $110 against a $100 ceiling. Two honest options:

**Option A — domain now, Apple Developer when the list is real (recommended).**
Spend $11 today. Ship the beta unsigned with clear right-click-to-open
instructions (`docs/INSTALL.md` covers this). Buy the $99 enrolment once you have
~50 subscribers or the first tips land — by then it pays for itself. Keeps ~$89
in reserve and you get the brand immediately.

**Option B — Apple Developer now, launch on `track2mix.pages.dev`.**
Frictionless notarized installs from day one; buy the domain next month. Better
install experience, no brand domain yet.

### Why the $99 matters so much on macOS

An unsigned, un-notarized app on macOS doesn't show a mild warning. It shows
*"Track2Mix cannot be opened because the developer cannot be verified"* with the
only obvious button being **Move to Trash**. Getting past it needs a right-click
→ Open, or a trip into System Settings → Privacy & Security.

That is the largest single drop-off in the entire funnel, and it lands on people
who already wanted your app. Notarization deletes it. `.github/workflows/
release.yml` is already wired for the `APPLE_*` secrets and builds fine without
them, so nothing blocks shipping in the meantime.

### What to spend on only after the funnel works

Once the site converts visitors to downloads organically, the next $100 is worth
more as **one honest demo video from a DJ with an audience** than as ads. A
micro-creator (5–50k subs) doing a real walkthrough on their own library
outperforms any amount of self-published copy, because the credibility isn't
yours to claim.

---

## 4. Channels, in the order to use them

You have a small, informal audience, so the strategy is **borrowed audience**:
go where DJs already gather, be useful before being promotional, and convert
attention into an email list you own.

### Tier 1 — free, high intent, do these first

| Channel | Why it works | The move |
| --- | --- | --- |
| **r/DJs**, **r/Beatmatch** | Huge, and full of exactly the library-anxiety problem you solve. Both are hostile to ads and warm to free tools with visible sources. | Post the side-by-side comparison, not the product. Read each sub's self-promo rules first and comment for a week before posting. |
| **Genre subs** (r/DnB, r/techno, r/TechHouse, r/trance) | Key-mixing is normal here; libraries are large. Smaller but far higher intent. | Genre-specific framing: "I analysed 8,000 DnB tracks and the energy scores mapped surprisingly well to liquid vs. neuro." |
| **DJ Discords** | Where the tool-curious actually live. Conversational, no karma gatekeeping. | Be present in 3–4 for a fortnight. Ask for beta testers rather than announcing a launch. |
| **Rekordbox / Pioneer DJ Facebook groups** | Older, larger, less tooling-literate, extremely on-topic. | Lead with the pain: "Rekordbox Related Tracks never worked for me, so I built this." |
| **Hacker News (Show HN)** | Rust + Tauri + local-first + DSP is precisely its taste. Won't bring many DJs but brings contributors, stars, and credibility you can cite. | `Show HN: Track2Mix – local-first Rekordbox library analysis in Rust`. Post Tue–Thu, ~9am ET. |
| **Gearspace / DJTechTools forums** | Old-school, high-trust, indexes well in search for years. | One thorough thread you maintain, not a drive-by. |

### Tier 2 — free, slower, compounding

- **Build in public.** Short posts showing the energy distribution of a real
  library, what the features actually measure, where the scoring fails. Being
  publicly honest about limitations is the cheapest trust you can buy, and it's
  the thing that makes a stranger try your unsigned binary.
- **Open source as top-of-funnel.** The CLI being readable is a marketing asset.
  GitHub stars are social proof for the exact audience most likely to tip.
- **One genuinely useful artifact.** A plain-English explainer on *why energy
  matters more than key for set building* will get linked for years and bring
  people in without mentioning the product much.

### Tier 3 — costs money, only once Tier 1 works

- Micro-creator demo video ($50–150).
- Small DJ-newsletter sponsorship.
- Ads. Last, and only with a converting funnel and a known cost per download.

### Don't bother

Twitter/X cold posting with no following. TikTok unless you'll make video
weekly. Paid press. Product Hunt — it's a SaaS audience, not a DJ one.

---

## 5. Launch sequence

**Phase 0 — validate (do not skip).** Complete §2. Get the hit rate and the
side-by-side screenshots. Fix the feature weights if the score doesn't match
your ear.

**Phase 1 — 10 beta testers.** Recruit by DM from Discords and genre subs. Ask
each for one thing: *"Does the energy score match your ear? Where is it wrong?"*
Fix what they find. Ask the ones who liked it for a sentence you can quote. Ten
real users beat a thousand strangers, and you need the testimonials before any
public post.

**Phase 2 — site live.** Domain, email capture wired and tested, tip jar
connected, real screenshots in place of the placeholder preview, one signed or
clearly-documented download available. Announce to your own people first — warm
audience first is the whole point of having one.

**Phase 3 — community rollout.** One channel at a time, a few days apart, so you
can tell which one works and respond properly to each thread. Never post the
same text twice: each community gets copy written for it.

**Phase 4 — Show HN + forums.** Once the site has survived real traffic and you
have testimonials.

**Phase 5 — iterate on what they ask for.** The requests will cluster. Serato
support, key detection and set-arc planning are the likely three. Build the one
people tip for.

---

## 6. Ready-to-adapt copy

Rewrite these in your own voice before posting. Verbatim reuse reads like
marketing, which is exactly what these communities punish. **Replace every
bracketed figure with your real numbers — do not post a number you haven't
measured.**

### Reddit — r/DJs or a genre sub

> **I got frustrated with Rekordbox's Related Tracks, so I analysed my whole
> library myself**
>
> I play [genre] and I've got about [N] tracks in Rekordbox. I was playing maybe
> 200 of them. Related Tracks never helped — it'd give me a hundred things in the
> right key with no sense of which ones actually hit the same.
>
> So I wrote something that decodes every file and scores it for energy —
> loudness, dynamic range, brightness, how much the spectrum moves, onset
> density. Then when I pick a track it gives me the harmonically compatible
> stuff within a few BPM, ranked by energy.
>
> Here's the part I think is actually interesting: [side-by-side screenshot of
> Rekordbox Related Tracks vs. this, same anchor track]. On [N] anchors I know
> cold, it found what I'd have picked myself about [X]% of the time.
>
> It's free, it runs entirely offline (no account, nothing uploaded, there's no
> server), it exports M3U8 straight back into Rekordbox, and the source is up.
> macOS and Windows.
>
> Honest limitations: it doesn't detect key, it uses whatever Rekordbox already
> analysed. Rekordbox XML only, so no Serato or Traktor yet. And the energy
> weights are hand-tuned by me, on my music — which is exactly what I'd like
> people to tell me is wrong.
>
> [link]

### Show HN

> **Show HN: Track2Mix – local-first Rekordbox library analysis in Rust**
>
> DJ libraries get big and unusable. Rekordbox stores key and BPM but has no
> measure of how hard a track hits, so "compatible" lists run to hundreds of
> entries with no useful ordering.
>
> Track2Mix parses the Rekordbox XML export, decodes every track with Symphonia
> (pure Rust — MP3, FLAC, WAV, AIFF, M4A), and extracts RMS mean and variance,
> spectral centroid, spectral flux and onset rate via rustfft. It samples three
> 30-second windows at 20/50/80% rather than whole files, which characterises a
> track at a fraction of the cost, parallelised with rayon. Results go in SQLite.
> Given an anchor it returns Camelot-compatible neighbours (same key, ±1,
> relative major/minor) inside a BPM tolerance, ranked by energy, exportable as
> M3U8.
>
> Rust CLI plus a Tauri v2 + React GUI. Entirely offline — there is no backend.
>
> Where it's weak, since I'd rather you hear it from me: linear resampling
> (fine for MIR, wrong for playback), onset detection is a flux-spike heuristic
> rather than a proper complex-domain algorithm, and the energy weights are
> hand-tuned rather than learned. Learning them needs labelled data I don't have
> yet.
>
> [link]

### Discord / beta recruitment DM

> Hey — I built a thing that scores your whole Rekordbox library for energy and
> then tells you what mixes with what. I'm after about 10 people with big
> libraries to tell me whether the energy numbers match their ears, because
> mine are tuned on [genre] and I don't trust that they generalise. Free
> obviously, runs offline, nothing gets uploaded. Any interest?

### Micro-creator outreach email

> Subject: free tool for your Rekordbox library — no ask attached
>
> Hi [name],
>
> I built Track2Mix: it analyses your Rekordbox library, scores every track for
> energy off the actual audio, and then shows you what mixes with what. It's
> free and it runs offline.
>
> I'm not asking you to cover it. I'd genuinely just like to know whether the
> energy scores match your ear on a library that isn't mine — you play [genre]
> and mine's tuned on [genre], so if it's wrong you'll spot it immediately.
>
> If you do end up liking it enough to show people, that'd be great, but that's
> not why I'm writing.
>
> [link]

---

## 7. What to measure

Without numbers you're guessing about which channel works.

| Stage | Metric | Rough target to beat |
| --- | --- | --- |
| Site | Unique visitors by referrer | — |
| Site | Visitor → form submitted | 2–5% |
| Site | Form started → form completed | 60%+ |
| Product | Downloaded → completed an analysis run | **the one that matters most** |
| Product | Ran once → ran again within 2 weeks | 30%+ means it's useful |
| Money | Downloads → tipped | 1–3% is normal for PWYW |
| Money | Average tip | $8–15 typical |

### What the mandatory name-and-email gate costs you

Requiring contact details before the download is a real trade, and it's worth
being clear-eyed about both sides.

**What it costs.** Gating a free download typically cuts completion
substantially versus a direct link — the drop is large enough that you should
expect roughly half the downloads you'd otherwise get, and possibly fewer from
the privacy-minded technical DJs who are otherwise your best early users. That
group is also the most likely to notice the irony of handing over their details
to a tool whose pitch is "nothing leaves your machine", which is why the FAQ
now says plainly what is collected and why.

**What it buys.** A list you own, which is the only asset that survives a
channel drying up, and the ability to actually tell beta users when something
is fixed. Given you're not charging, the list *is* the return on this launch.

**What it can't do.** GitHub Releases is public, and the site links to the
source deliberately. Anyone can route around the form. Treat it as capturing
the majority who arrive through the site, not as access control — and don't be
alarmed when download counts exceed contact rows.

If completion looks bad after the first real traffic, the cheapest fix is
dropping the name field and keeping email only. Measure before deciding.

Set expectations honestly on that last pair: **pay-what-you-want with a genuine
free option converts in the low single digits.** A hundred downloads might mean
one to three tips and $10–40. That is not a failure of the model — it's what the
model does. What PWYW actually buys you is downloads, goodwill, feedback and a
list, which is exactly what you need right now and exactly what a $39 price tag
would cost you.

Revenue becomes realistic later, in one of three ways, and you'll know which by
what people ask for:

1. **The tablet apps**, already priced and in the stores (§7b), and later a
   paid desktop tier for genuinely heavier features (learned energy weights,
   Serato/Traktor support, key-lock time-stretching) while today's features
   stay free.
2. **Recurring support** from the small group for whom it becomes essential —
   Ko-fi monthly, GitHub Sponsors.
3. **Nothing.** It stays a free tool that builds your reputation as someone who
   ships. That has real value too, and it's a legitimate outcome to choose.

Cloudflare Web Analytics covers the site for free. For the product metrics,
note that the app makes no network calls by design — so either ask in the email
list, or if you ever add telemetry, make it opt-in and say so loudly. Quietly
adding tracking to a tool marketed on "nothing leaves your machine" would cost
you more than the data is worth.

---

## 7b. The tablet apps: a fixed price, and why

The desktop stays pay-what-you-want. The iPad and Android tablet builds go
through the App Store and Google Play, which don't do PWYW, so they carry a
price: **$19.99 one-time** (launch fortnight at $14.99), no subscription, no
in-app purchases. The full reasoning and the comparison set are in
[docs/MOBILE.md](docs/MOBILE.md#pricing); the short version:

- It's anchored to the $15 "most common" tip, so the FAQ's promise holds: a
  desktop user who tipped the typical amount doesn't pay more for the tablet.
- After the stores' 15 % small-business cut it nets ~$17 a sale. Halving the
  price would need twice the buyers just to break even, and this niche doesn't
  have them.
- It sits clearly under Mixed In Key ($58) and the subscription tools
  ($10–15/month) while reading as a real tool rather than a $2.99 utility.

Rules for the store listings and the site's tablet section: don't mention the
tip jar or pay-what-you-want there (the stores prohibit steering to outside
payment, and it muddies the offer); do say the free desktop analyser exists,
because the tablet app needs a library made with it. Someone who lands on the
store page and buys without ever seeing the site is the best case, not a leak.

What to measure: visits to `#tablet` → store badge clicks (Cloudflare Web
Analytics), store page views → purchases (App Store Connect / Play Console),
and the `store_interest` rows while the listings are still "coming soon" —
that count is the pre-order list.

## 8. The next three things to build

Ordered by how much they unlock, not by effort:

1. **Real screenshots and the side-by-side comparison.** Costs nothing, and it's
   the highest-converting asset you can have. Blocked only on running the
   validation in §2.
2. **A signed, notarized macOS build.** Turns "sketchy download" into "app".
   Blocked only on the $99.
3. **Serato support.** It will be the most-requested thing, and the analysis
   engine is already library-agnostic — it's a parser, not a rewrite.

Deliberately not on this list: accounts, cloud sync, a web version, or AI
set-generation. Each would undermine the offline, no-server promise that is
currently one of the most persuasive things about the product.
