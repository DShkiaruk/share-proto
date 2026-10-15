# Speed, before and after v2.7 — 2026-10-15

A client said the comments "freeze all the time and take a long time to
update". v2.7 changed how the comment picture is taken and when the overlay
reads. This checks both versions side by side, by the same steps, on the same
machine: the overlay from before (`8f1b8e3`, v2.6) and v2 at `d4cc415`.

## Pages

- **heavy** — `tests/fixtures/heavy.html`: 600 rows, live countdowns, ~7 000 nodes.
- **report** — a real client's report: 5.4 MB, 36 lazy screenshots.
- **app** — a real client's app prototype: 0.7 MB, one page.

The two real pages are client work and are not in this repo; `setup.sh`
takes their paths. Without them only **heavy** is built.

## Rerun

```bash
bash setup.sh [report.html] [app.html] [app-assets-dir]   # builds site-old-*/site-new-*
node bench.mjs post 3          # leaving a comment, 1× and 4× slower CPU (Chromium)
node bench.mjs slowread 2      # your own comment while every read takes 2 s
node bench.mjs idle 1          # someone else's comment after 20 min away (clock stepped)
node bench.mjs scroll 3        # 40 pins, at rest and scrolling, 4× slower CPU
node webkit.mjs                # Safari's engine, desktop and iPhone
LAB_URL=… LAB_TEAM=… LAB_CLIENT=… node live.mjs   # the lab on Vercel; deletes what it made
node summary.mjs --skip 19:51:00-19:54:30          # the tables below
```

Every run appends to `results.jsonl`; all rows are kept.

## How it is measured

- **Comment drawn**: in the page, from the Enter key to the first frame that
  has the comment.
- **Freeze**: Chromium's long tasks during and after posting.
  **Extra work** is main-thread time over the page's own idle rate.
  **Picture saved** is read from the server, outside the page.
- **Stuck** (WebKit, which has no long-task API): the longest gap in a 16 ms
  timer.
- **4× CPU** is Chromium's CPU throttling, standing in for a weaker laptop or
  phone. It is not a real device.
- **20 min away**: the reviewer's clock is fake and stepped in 30 s jumps, so
  the poll backs off exactly as it would. Then a comment is posted from
  another browser, and the reviewer clicks the page or brings the window back.

## Setup and caveats

- MacBook Pro M2, 8 GB, Node 26.7, Playwright 1.62.1, headless.
- The machine was in normal use at the same time (a browser, other Claude
  sessions), so absolute numbers carry that noise. Old and new ran
  alternately under the same conditions.
- Rows from 19:51:00–19:54:30 UTC are left out of the tables: the unit tests
  ran in parallel then. Those rows are still in `results.jsonl`. Scroll and
  WebKit were rerun afterwards.
- Medians, with n per row. One server and an empty store per run.

## Results

109 rows, 12 left out (19:51:00–19:54:30 UTC).

### Leaving a comment (Chromium)

| page | CPU | version | n | comment drawn | longest freeze | freezes in all | extra work | picture saved |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| heavy | 1× | old | 3 | 0.03 s | 2.5 s | 2.5 s | 2.4 s | 2.8 s |
| heavy | 1× | new | 3 | 0.03 s | 0.30 s | 0.30 s | 0.3 s | 0.54 s |
| heavy | 4× | old | 3 | 0.08 s | 10.9 s | 11.3 s | 10.6 s | none |
| heavy | 4× | new | 3 | 0.04 s | 1.3 s | 1.3 s | 1.5 s | 1.6 s |
| report | 1× | old | 3 | 0.02 s | 0.65 s | 0.68 s | 0.8 s | none |
| report | 1× | new | 3 | 0.03 s | 0.06 s | 0.06 s | 0.1 s | 0.54 s |
| report | 4× | old | 3 | 0.03 s | 2.6 s | 2.6 s | 2.9 s | none |
| report | 4× | new | 3 | 0.03 s | 0.18 s | 0.24 s | 0.3 s | 0.80 s |
| app | 1× | old | 3 | 0.02 s | 0.24 s | 0.34 s | 0.4 s | 0.82 s |
| app | 1× | new | 3 | 0.03 s | 0.18 s | 0.26 s | 0.2 s | 0.79 s |
| app | 4× | old | 3 | 0.03 s | 0.99 s | 1.4 s | 1.5 s | 1.8 s |
| app | 4× | new | 3 | 0.03 s | 0.78 s | 1.1 s | 1.1 s | 1.6 s |

### Your own comment when reads are slow (2 s per read)

| page | version | n | comment drawn |
| --- | --- | --- | --- |
| heavy | old | 2 | 3.0 s |
| heavy | new | 2 | 0.03 s |
| app | old | 2 | 2.1 s |
| app | new | 2 | 0.03 s |

### Someone else’s comment, after 20 minutes away

| back by | version | n | seen after |
| --- | --- | --- | --- |
| a click on the page | old | 1 | 190 s |
| a click on the page | new | 1 | 23 s |
| the window back in front | old | 1 | 191 s |
| the window back in front | new | 1 | 0 s |

### 40 pins, scrolling, 4× slower CPU

| screen | version | n | CPU at rest | CPU scrolling | frame p50 | frame p95 | frames > 50 ms |
| --- | --- | --- | --- | --- | --- | --- | --- |
| desktop | old | 4 | 7.4% | 43.4% | 17 ms | 34 ms | 3.5 |
| desktop | new | 4 | 6.6% | 40.5% | 17 ms | 25.5 ms | 3.5 |
| phone | old | 4 | 6.2% | 37.6% | 17 ms | 33 ms | 3 |
| phone | new | 4 | 6.4% | 39.1% | 17 ms | 33 ms | 3 |

### Safari’s engine (WebKit), leaving a comment

| page | screen | version | n | longest stuck | stuck in all (gaps > 100 ms) | picture saved |
| --- | --- | --- | --- | --- | --- | --- |
| heavy | desktop | old | 3 | 2.2 s | 2.4 s | 2.7 s |
| heavy | desktop | new | 3 | 0.31 s | 0.33 s | 0.68 s |
| heavy | iPhone | old | 3 | 2.2 s | 2.4 s | 3.1 s |
| heavy | iPhone | new | 3 | 0.22 s | 0.24 s | 0.66 s |
| report | desktop | old | 3 | 0.57 s | 1.1 s | none |
| report | desktop | new | 3 | 0.04 s | 0.00 s | 0.64 s |
| report | iPhone | old | 3 | 0.82 s | 1.8 s | none |
| report | iPhone | new | 3 | 0.04 s | 0.00 s | 0.88 s |

### The lab on Vercel (real network, this code)

overlay.js same as this checkout; overlay.css same as this checkout.

| n | saved | comment drawn | longest freeze | picture saved | a designer at the page sees it |
| --- | --- | --- | --- | --- | --- |
| 3 | 0.53 s | 0.53 s | 0.29 s | 1.6 s | 11.9 s |

## What it says

- **The freeze after a comment is gone where it was worst.** On heavy:
  2.5 s → 0.3 s, and on a 4× slower CPU 10.9 s → 1.3 s. On the report the
  page was only briefly stuck (0.65 s → 0.06 s), but the old version never
  saved its picture, in either engine. The new one saves it in under 1 s.
- **Your own comment does not wait for a slow read.** With 2 s reads it showed
  after 2–3 s; now it shows in 0.03 s. On the lab it shows as soon as the
  write returns (~0.5 s).
- **Coming back to the tab.** Bringing the window to the front reads at once
  (0 s; before, up to the next poll — 191 s here, up to 4 min). A click on the
  page moves the next read to within 25 s rather than reading at once (23 s
  here). That is by design: on a free storage tier every read counts.
- **Scrolling with 40 pins**: no measurable difference between old and new.
- **Not solved**: on the heavy page with a 4× slower CPU the picture still
  costs one 1.3 s freeze. The app page gained little (0.99 s → 0.78 s at 4×):
  its cost is not in the part v2.7 changed.

---

## v2.8.2 — copying the page in turns

**What changed.** The profile of the remaining freeze (heavy page, 4× slower CPU)
showed a single 1.6 s task. All of it was the screenshot library copying
computed styles node by node, in one unbroken run of promise callbacks. The
real app prototype showed the same pattern at 1.3 s.

The library waits on its `onCloneEachNode` hook after each node it copies. The
overlay now uses that wait to give the event loop a turn every 12 ms.

The library walks siblings by `nextSibling`, so removing an element that is
being copied would cut the walk short and leave holes in the picture. The
overlay tracks which elements are being copied: the filter sees each one go
in, the hook sees it come out. If one of them is removed, the copy is redone
in one go, as before. SVG subtrees are copied without a break, because the
real app redraws an SVG every 16 ms.

**Pictures.** Compared pixel by pixel against the one-go copy. Pictures are in
the scratchpad and not committed, since they show client pages.

- heavy, at rest: 0.002% of pixels differ (the spinner had turned).
- heavy, scrolled: identical.
- report: identical.
- app: identical.
- a list rebuilt every 150 ms: the copy was redone in one go, as intended.
  0.005% of pixels differ (the countdowns).

**Numbers.** `new` = v2 at d4cc415, `next` = the copy in turns, run
alternately. Raw rows are in `results-turns.jsonl`:

```bash
RESULTS=results-turns.jsonl VERSIONS=new,next node bench.mjs post 3
RESULTS=results-turns.jsonl VERSIONS=new,next node webkit.mjs
RESULTS=results-turns.jsonl node summary.mjs --skip 20:16:00-20:22:00
```

The 36 rows from 20:16–20:22 UTC are a first attempt that treated *any*
removal as damage. They are kept in the file and left out of the tables.

### Leaving a comment (Chromium)

| page | CPU | version | n | comment drawn | longest freeze | freezes in all | extra work | picture saved |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| heavy | 1× | new | 3 | 0.02 s | 0.31 s | 0.31 s | 0.4 s | 0.54 s |
| heavy | 1× | next | 3 | 0.03 s | 0.06 s | 0.06 s | 0.4 s | 0.54 s |
| heavy | 4× | new | 3 | 0.05 s | 1.4 s | 1.4 s | 1.5 s | 1.6 s |
| heavy | 4× | next | 3 | 0.05 s | 0.24 s | 0.30 s | 1.8 s | 1.9 s |
| report | 1× | new | 3 | 0.03 s | 0.07 s | 0.07 s | 0.1 s | 0.54 s |
| report | 1× | next | 3 | 0.03 s | 0.00 s | 0.00 s | 0.1 s | 0.54 s |
| report | 4× | new | 3 | 0.03 s | 0.18 s | 0.24 s | 0.3 s | 0.80 s |
| report | 4× | next | 3 | 0.07 s | 0.18 s | 0.50 s | 0.5 s | 0.84 s |
| app | 1× | new | 3 | 0.03 s | 0.19 s | 0.27 s | 0.3 s | 0.79 s |
| app | 1× | next | 3 | 0.03 s | 0.08 s | 0.08 s | 0.4 s | 0.81 s |
| app | 4× | new | 3 | 0.03 s | 0.82 s | 1.2 s | 1.2 s | 1.6 s |
| app | 4× | next | 3 | 0.04 s | 0.33 s | 0.64 s | 1.3 s | 1.8 s |


### Safari’s engine (WebKit), leaving a comment

| page | screen | version | n | longest stuck | stuck in all (gaps > 100 ms) | picture saved |
| --- | --- | --- | --- | --- | --- | --- |
| heavy | desktop | new | 2 | 0.29 s | 0.30 s | 0.45 s |
| heavy | desktop | next | 2 | 0.11 s | 0.10 s | 0.80 s |
| heavy | iPhone | new | 2 | 0.24 s | 0.26 s | 0.67 s |
| heavy | iPhone | next | 2 | 0.04 s | 0.00 s | 0.68 s |
| report | desktop | new | 2 | 0.07 s | 0.05 s | 0.68 s |
| report | desktop | next | 2 | 0.15 s | 0.32 s | 1.1 s |
| report | iPhone | new | 2 | 0.11 s | 0.15 s | 1.0 s |
| report | iPhone | next | 2 | 0.03 s | 0.00 s | 0.89 s |

**What it says.**

- **Big gains where the freeze was big.** At 4× CPU the longest freeze went
  from 1.4 s to 0.24 s on the heavy page and from 0.82 s to 0.33 s on the app.
  At normal speed every page is at 0.08 s or less.
- **No gain on the report**, which was already under 0.2 s. At 4× CPU its
  short freezes add up to more than before (0.24 s → 0.50 s in total).
- **Costs.** Total work is up a little (heavy, 4×: 1.5 s → 1.8 s), and the
  picture is saved a little later (1.6 s → 1.9 s).
- **Safari's engine:** heavy page 0.29 s → 0.11 s on desktop and 0.24 s →
  0.04 s on an iPhone. The report on desktop got slightly worse, 0.07 s →
  0.15 s (n = 2).
- **What is left** are steps that cannot be split: turning the copy into an
  image and drawing it, 0.2–0.3 s on a 4× slower CPU.
