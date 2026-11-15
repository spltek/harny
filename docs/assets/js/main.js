/* ============================================================================
   main.js — every interaction on the page, one module each.
   Nothing here is required to read the page: if it fails, the content stands
   and only the ornament stops moving.
   ========================================================================= */
(() => {
  "use strict";

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ------------------------------------------------------------------ 01 nav */
  const nav = $("#nav");
  const progress = $("#navProgress");
  const railFill = $("#scrollRailFill");

  function onScroll() {
    const y = window.scrollY || document.documentElement.scrollTop;
    const max = document.documentElement.scrollHeight - window.innerHeight;
    const pct = max > 0 ? Math.min(1, y / max) : 0;

    if (nav) nav.classList.toggle("is-stuck", y > 24);
    if (progress) progress.style.width = `${pct * 100}%`;
    if (railFill) railFill.style.height = `${pct * 100}%`;
  }
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  /* burger */
  const burger = $("#burger");
  const links = $(".nav__links");
  if (burger && links) {
    burger.addEventListener("click", () => {
      const open = links.classList.toggle("is-open");
      burger.setAttribute("aria-expanded", String(open));
      burger.setAttribute("aria-label", open ? "Close menu" : "Open menu");
    });
    $$("a", links).forEach((a) =>
      a.addEventListener("click", () => {
        links.classList.remove("is-open");
        burger.setAttribute("aria-expanded", "false");
      })
    );
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && links.classList.contains("is-open")) {
        links.classList.remove("is-open");
        burger.setAttribute("aria-expanded", "false");
        burger.focus();
      }
    });
  }

  /* active section in the nav */
  const navAnchors = $$(".nav__links a");
  const sections = navAnchors
    .map((a) => ({ a, el: document.getElementById(a.getAttribute("href").slice(1)) }))
    .filter((s) => s.el);

  if (sections.length && "IntersectionObserver" in window) {
    const spy = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          const id = entry.target.id;
          navAnchors.forEach((a) => a.classList.toggle("is-active", a.getAttribute("href") === `#${id}`));
        });
      },
      { rootMargin: "-45% 0px -50% 0px", threshold: 0 }
    );
    sections.forEach((s) => spy.observe(s.el));
  }

  /* ------------------------------------------------------- 02 pointer light */
  const spot = $("#spot");
  if (spot && !reduce) {
    let tx = window.innerWidth / 2;
    let ty = window.innerHeight * 0.3;
    let cx = tx;
    let cy = ty;
    let raf = 0;

    const ease = () => {
      cx += (tx - cx) * 0.08;
      cy += (ty - cy) * 0.08;
      spot.style.transform = `translate(${cx - 360}px, ${cy - 360}px)`;
      raf = Math.abs(tx - cx) + Math.abs(ty - cy) > 0.5 ? requestAnimationFrame(ease) : 0;
    };

    window.addEventListener(
      "pointermove",
      (e) => {
        tx = e.clientX;
        ty = e.clientY;
        if (!raf) raf = requestAnimationFrame(ease);
      },
      { passive: true }
    );
  }

  /* ------------------------------------------------------------- 03 reveals */
  const revealables = $$("[data-reveal]");
  if (revealables.length) {
    if (reduce || !("IntersectionObserver" in window)) {
      revealables.forEach((el) => el.classList.add("is-in"));
    } else {
      const io = new IntersectionObserver(
        (entries, obs) => {
          entries.forEach((entry) => {
            if (!entry.isIntersecting) return;
            entry.target.classList.add("is-in");
            obs.unobserve(entry.target);
          });
        },
        { threshold: 0.12, rootMargin: "0px 0px -6% 0px" }
      );
      revealables.forEach((el, i) => {
        el.style.transitionDelay = `${Math.min(i % 4, 3) * 70}ms`;
        io.observe(el);
      });
    }
  }

  /* ------------------------------------------------ 04 card cursor spot-glow */
  $$(".card").forEach((card) => {
    card.addEventListener("pointermove", (e) => {
      const r = card.getBoundingClientRect();
      card.style.setProperty("--mx", `${((e.clientX - r.left) / r.width) * 100}%`);
      card.style.setProperty("--my", `${((e.clientY - r.top) / r.height) * 100}%`);
    });
  });

  /* ------------------------------------------------------------ 05 counters */
  function countUp(el) {
    const target = Number(el.dataset.count || 0);
    const suffix = el.dataset.suffix || "";
    if (!target) return;
    if (reduce) {
      el.textContent = `${target}${suffix}`;
      return;
    }
    const dur = 1400;
    const t0 = performance.now();
    const step = (t) => {
      const p = Math.min(1, (t - t0) / dur);
      const eased = 1 - Math.pow(1 - p, 3);
      el.textContent = `${Math.round(target * eased)}${suffix}`;
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  const counters = $$("[data-count]");
  if (counters.length && "IntersectionObserver" in window) {
    const co = new IntersectionObserver(
      (entries, obs) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          countUp(entry.target);
          obs.unobserve(entry.target);
        });
      },
      { threshold: 0.6 }
    );
    counters.forEach((c) => co.observe(c));
  }

  /* ----------------------------------------------------------- 06 HUD clock */
  const clock = $("#hudClock");
  if (clock) {
    const tick = () => {
      const d = new Date();
      clock.textContent = d.toLocaleTimeString("en-GB", { hour12: false });
    };
    tick();
    setInterval(tick, 1000);
  }

  /* -------------------------------------------------- 07 the hero transcript */
  const term = $("#term");
  if (term) {
    const rows = Array.from(term.children);
    const modeChips = $$("[data-mode-pill]");
    const metricMode = $("#metricMode");
    let timer = 0;
    let running = false;

    function clearAll() {
      rows.forEach((r) => r.classList.remove("is-shown"));
    }

    function play() {
      if (running) return;
      running = true;
      clearAll();
      let i = 0;
      const tickOnce = () => {
        if (i >= rows.length) {
          running = false;
          // hold on the finished turn, then replay while the hero is on screen
          timer = window.setTimeout(() => {
            if (inView) play();
          }, 7000);
          return;
        }
        rows[i].classList.add("is-shown");
        i += 1;
        timer = window.setTimeout(tickOnce, 460);
      };
      tickOnce();
    }

    let inView = true;
    if ("IntersectionObserver" in window && !reduce) {
      const vo = new IntersectionObserver(
        (entries) => {
          entries.forEach((entry) => {
            inView = entry.isIntersecting;
            if (inView) {
              if (!running) {
                window.clearTimeout(timer);
                play();
              }
            }
          });
        },
        { threshold: 0.25 }
      );
      vo.observe(term);
    }

    if (reduce) {
      rows.forEach((r) => r.classList.add("is-shown"));
    } else {
      play();
    }

    /* mode pills inside the console */
    modeChips.forEach((pill) => {
      pill.addEventListener("click", () => {
        modeChips.forEach((p) => p.classList.toggle("is-on", p === pill));
        const mode = pill.dataset.modePill;
        if (metricMode) {
          metricMode.textContent = mode === "build" ? "Build" : "Analyze";
          metricMode.style.color = mode === "build" ? "var(--tan)" : "var(--cyan)";
          metricMode.style.borderColor =
            mode === "build" ? "rgba(208,136,86,0.5)" : "rgba(95,230,245,0.5)";
        }
        window.clearTimeout(timer);
        running = false;
        play();
      });
    });
  }

  /* ------------------------------------------------------- 08 Analyze / Build */
  const modeSwitch = $(".switch");
  const panel = $(".panel");
  if (modeSwitch && panel) {
    const btns = $$(".switch__btn", modeSwitch);
    const modeLabel = $("#modeLabel");
    const verdict = $("#verdict");
    const chip = $(".panel__foot .metric-chip");
    const counts = $(".toolcard__counts");
    const tabs = $$(".toolcard__tabs span");

    const STATES = {
      analyze: {
        label: "MODE · ANALYZE (READ-ONLY PREVIEW)",
        badge: "DRY RUN",
        text: "<b>Nothing was written.</b> The exact diff is returned so you can review it. Switch to Build to apply.",
        chip: "Analyze · 6.2k in · 41 out",
        counts: "<b>+24</b> <i>−0</i>",
        tab: "Diff",
      },
      build: {
        label: "MODE · BUILD (WRITES FOR REAL)",
        badge: "APPLIED",
        text: "<b>src/llm/retry.ts written — 24 lines.</b> The turn is recorded with its token usage, its timings and its diff.",
        chip: "Build · 6.4k in · 58 out · 1.9s",
        counts: "<b>+24</b> <i>−0</i>",
        tab: "Diff",
      },
    };

    function setMode(mode) {
      const s = STATES[mode] || STATES.analyze;
      modeSwitch.dataset.active = mode;
      btns.forEach((b) => {
        const on = b.dataset.mode === mode;
        b.classList.toggle("is-active", on);
        b.setAttribute("aria-selected", String(on));
      });
      panel.classList.toggle("is-build", mode === "build");
      if (modeLabel) modeLabel.textContent = s.label;
      if (verdict) {
        verdict.innerHTML = `<span class="verdict__badge">${s.badge}</span><p>${s.text}</p>`;
      }
      if (chip) chip.textContent = s.chip;
      if (counts) counts.innerHTML = s.counts;
      tabs.forEach((t) => t.classList.toggle("is-on", t.textContent.trim() === s.tab));
    }

    btns.forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mode)));
    setMode("analyze");
  }

  /* ------------------------------------------------------ 09 sub-agent states */
  const agents = $$(".agent");
  if (agents.length) {
    const setState = (agent, state, label) => {
      agent.classList.remove("is-queued", "is-aborted", "is-done");
      if (state !== "streaming") agent.classList.add(`is-${state}`);
      const badge = $("[data-state]", agent);
      if (badge) badge.textContent = label;
      const stop = $(".agent__stop", agent);
      if (stop) stop.textContent = state === "aborted" ? "Resume" : "Stop this";
    };

    agents.forEach((agent) => {
      const stop = $(".agent__stop", agent);
      if (!stop) return;
      stop.addEventListener("click", () => {
        const aborted = agent.classList.contains("is-aborted");
        setState(agent, aborted ? "streaming" : "aborted", aborted ? "streaming" : "aborted");
      });
    });

    /* the queued agent behind the cap gets its turn */
    const queued = $('[data-agent="c"]');
    if (queued && !reduce) {
      const kick = () => {
        if (queued.classList.contains("is-aborted")) return;
        setState(queued, "streaming", "streaming");
        window.setTimeout(() => {
          if (!queued.classList.contains("is-aborted")) setState(queued, "done", "done");
        }, 5200);
      };
      const qo = new IntersectionObserver(
        (entries, obs) => {
          entries.forEach((e) => {
            if (!e.isIntersecting) return;
            window.setTimeout(kick, 2400);
            obs.unobserve(e.target);
          });
        },
        { threshold: 0.4 }
      );
      qo.observe(queued);
    }
  }

  /* --------------------------------------------------------- 10 context meter */
  const ctxTrack = $(".ctx__track");
  if (ctxTrack) {
    const sum = $(".ctx__seg--sum");
    const verbatim = $(".ctx__seg--verbatim");
    const marker = $("#ctxMarker");
    const pct = $("#ctxPct");

    const fill = () => {
      if (sum) sum.style.width = "15%";
      if (verbatim) verbatim.style.width = "67%";
      if (marker) marker.style.left = "15%";
      if (pct) {
        if (reduce) {
          pct.textContent = "82%";
        } else {
          const t0 = performance.now();
          const step = (t) => {
            const p = Math.min(1, (t - t0) / 1300);
            pct.textContent = `${Math.round(82 * (1 - Math.pow(1 - p, 3)))}%`;
            if (p < 1) requestAnimationFrame(step);
          };
          requestAnimationFrame(step);
        }
      }
    };

    if ("IntersectionObserver" in window) {
      const mo = new IntersectionObserver(
        (entries, obs) => {
          entries.forEach((e) => {
            if (!e.isIntersecting) return;
            fill();
            obs.unobserve(e.target);
          });
        },
        { threshold: 0.35 }
      );
      mo.observe(ctxTrack);
    } else {
      fill();
    }
  }

  /* ------------------------------------------------------------ 11 copy CLI */
  const copyBtn = $("#copyBtn");
  const cliCmd = $("#cliCmd");
  if (copyBtn && cliCmd) {
    copyBtn.addEventListener("click", async () => {
      const text = cliCmd.textContent.trim();
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        const r = document.createRange();
        r.selectNodeContents(cliCmd);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(r);
        return;
      }
      copyBtn.textContent = "copied";
      copyBtn.classList.add("is-done");
      window.setTimeout(() => {
        copyBtn.textContent = "copy";
        copyBtn.classList.remove("is-done");
      }, 1800);
    });
  }

  /* --------------------------------------------------------- 12 misc niceties */
  // marquee: duplicate the row so the loop is seamless at any width
  const marquee = $("#marquee");
  if (marquee) {
    const row = marquee.firstElementChild;
    if (row) marquee.appendChild(row.cloneNode(true));
  }

  // the year, if a footer ever wants it
  const yearEls = $$("[data-year]");
  yearEls.forEach((el) => (el.textContent = String(new Date().getFullYear())));
})();
