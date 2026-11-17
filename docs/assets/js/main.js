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
    let timer = 0;
    let running = false;

    function clearAll() {
      rows.forEach((r) => r.classList.remove("is-shown"));
    }

    function play() {
      if (running) return;
      running = true;
      clearAll();
      term.scrollTop = 0;
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
        // The panel FOLLOWS the stream: as a row lands, the transcript keeps it in view. It is
        // also what makes the card scroll at all when the replica is taller than the hero.
        term.scrollTo({ top: term.scrollHeight, behavior: "smooth" });
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

    /* The folds ARE the panel's interactivity — in the real one every card opens and closes — so
       the replica answers that click instead of being a painted screenshot. */
    $$("[data-fold]").forEach((row) => {
      row.addEventListener("click", () => {
        row.classList.toggle("is-open");
        row.classList.toggle("is-collapsed");
      });
    });
  }

  /* ------------------------------------------------------- 08 Analyze / Build */
  const modeSwitch = $(".switch");
  const panel = $("#mode-panel");
  if (modeSwitch && panel) {
    const btns = $$(".switch__btn", modeSwitch);
    const note = $("[data-pn-note]", panel);
    const modal = $("#mode-modal", panel);

    /* The two states of the SAME panel. In Analyze the host has prepared previews and says so the
       way it really does — with the `Switch to Build?` modal — and the transcript itself carries
       "nothing written". In Build the modal is gone and the note says what landed. */
    const STATES = {
      analyze: { chip: "Analyze", note: "nothing written — 1 file awaits Build", modal: true },
      build: { chip: "Build", note: "applied — 24 lines written to src/llm/retry.ts", modal: false },
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
      // The mode key in the controls row switches its own icon with the run.
      $(".pn-modebtn", panel)?.classList.toggle("is-build", mode === "build");
      if (note) {
        note.innerHTML = `<span class="pn-mode">${s.chip}</span> · ${s.note}`;
      }
      // The mode chip in the turn's badge follows the run, as it does in the panel.
      $$("[data-pn-mode]", panel).forEach((c) => (c.textContent = s.chip));
      if (modal) modal.classList.toggle("is-hidden", !s.modal);
    }

    /* ── the demo: switching to Build TYPES the prompt and then writes in the chat ──
       "GO !" appears in the field one character at a time, the turn lands as if it had been sent,
       and the Write card streams its diff. It is the ONE animation of this section, and it says
       what the copy says: in Build the tools write for real. Anything it adds can be taken away
       again by the switch (and by `prefers-reduced-motion`, which draws it all at once). */
    /* The diff of the demo — ONE source, colour and all, for the Analyse card and for the one the
       demo writes: the panel syntax-highlights a diff (index.html's line is tokenized by the same
       one-dark roles the Prism bundle paints), so a flat green block would be the one thing on
       screen that is not the app. */
    const GO_DIFF = [
      '<span class="t-kw">import</span> { sleep } <span class="t-kw">from</span> <span class="t-str">"./sleep"</span>',
      "",
      '<span class="t-kw">export</span> <span class="t-kw">interface</span> <span class="t-cls">RetryOptions</span> {',
      "  maxRetries?: <span class=\"t-cls\">number</span>",
      "  baseDelayMs?: <span class=\"t-cls\">number</span>",
      "}",
      "",
      '<span class="t-kw">export</span> <span class="t-kw">const</span> isRetryable = (status: <span class="t-cls">number</span>) =&gt;',
      "  status === <span class=\"t-num\">429</span> || status &gt;= <span class=\"t-num\">500</span>",
      "",
      '<span class="t-kw">export</span> <span class="t-kw">async</span> <span class="t-kw">function</span> <span class="t-fn">withRetry</span>&lt;T&gt;(',
      "  run: () =&gt; <span class=\"t-cls\">Promise</span>&lt;T&gt;,",
      "  { maxRetries = <span class=\"t-num\">4</span>, baseDelayMs = <span class=\"t-num\">250</span> }: <span class=\"t-cls\">RetryOptions</span> = {},",
      "): <span class=\"t-cls\">Promise</span>&lt;T&gt; {",
      "  <span class=\"t-kw\">for</span> (<span class=\"t-kw\">let</span> attempt = <span class=\"t-num\">0</span>; ; attempt++) {",
      "    <span class=\"t-kw\">try</span> {",
      "      <span class=\"t-kw\">return</span> <span class=\"t-kw\">await</span> <span class=\"t-fn\">run</span>()",
      "    } <span class=\"t-kw\">catch</span> (e) {",
      "      <span class=\"t-kw\">if</span> (attempt &gt;= maxRetries) <span class=\"t-kw\">throw</span> e",
      "      <span class=\"t-kw\">await</span> <span class=\"t-fn\">sleep</span>(<span class=\"t-cls\">Math</span>.<span class=\"t-fn\">min</span>(<span class=\"t-num\">2000</span>, baseDelayMs * <span class=\"t-num\">2</span> ** attempt))",
      "    }",
      "  }",
      "}",
    ].map((line) => (line === "" ? '<span class="pn-add">+</span>' : `<span class="pn-add">+${line}</span>`));
    const term = $("#term-modes", panel);
    // The Analyse card's diff arrives already written — it is the turn that was reviewed, not one
    // that is streaming.
    const staticDiff = $("#mode-panel [data-diff]", document);
    if (staticDiff) staticDiff.insertAdjacentHTML("beforeend", "\n" + GO_DIFF.join("\n"));
    const field = $(".pn-input", panel);
    const typed = $(".pn-typed", panel);
    let playing = 0; // a token, so a switch mid-animation cancels the old one
    const wait = (ms) => new Promise((r) => window.setTimeout(r, ms));

    const el = (tag, cls, html) => {
      const node = document.createElement(tag);
      if (cls) node.className = cls;
      if (html !== undefined) node.innerHTML = html;
      return node;
    };
    const avatar =
      '<svg class="pn-avatar" viewBox="0 0 24 17.6" aria-hidden="true"><path d="M 1.91 0 H 16.09 Q 18 0 18 1.91 V 12.11 Q 18 14.02 16.09 14.02 H 8.78 L 4.15 17.45 Q 3.44 17.89 3.41 17.02 V 14.02 H 1.91 Q 0 14.02 0 12.11 V 1.91 Q 0 0 1.91 0 Z"/></svg>';

    function resetDemo() {
      playing += 1;
      term?.querySelectorAll("[data-demo]").forEach((n) => n.remove());
      if (typed) typed.textContent = "";
      field?.classList.remove("is-typing");
      // A chat with history opens at its END, not at its beginning.
      if (term) term.scrollTop = term.scrollHeight;
    }

    async function playDemo() {
      if (!term || !field || !typed) return;
      resetDemo();
      const token = ++playing;
      const show = (node) => {
        term.appendChild(node);
        requestAnimationFrame(() => node.classList.add("is-shown"));
        term.scrollTo({ top: term.scrollHeight, behavior: "smooth" });
      };

      // 1. the prompt types itself into the field
      field.classList.add("is-typing");
      if (!reduce) {
        for (const ch of "GO !") {
          if (token !== playing) return;
          typed.textContent += ch;
          await wait(95);
        }
        await wait(420);
      } else {
        typed.textContent = "GO !";
      }
      if (token !== playing) return;

      // 2. …and is sent: the field empties, the turn lands in the transcript
      typed.textContent = "";
      field.classList.remove("is-typing");
      await wait(220);
      if (token !== playing) return;

      const turn = el("div", "pn-turn", "");
      turn.dataset.demo = "1";
      turn.innerHTML =
        `<div class="pn-user-wrap"><div class="pn-user">GO !</div>${avatar}</div>` +
        '<div class="pn-meta"><span class="pn-mode">Build</span> · deepseek-v4.1-flash · ' +
        "6.4k in · 58 out · ⚡ 6.1k · elapsed 1.9s · first token 540ms</div>";
      show(turn);

      // 3. the turn thinks first — a real one is prompt → thinking → tool
      await wait(420);
      if (token !== playing) return;
      const thinking = el("div", "pn-foldblock is-open", "");
      thinking.dataset.demo = "1";
      thinking.innerHTML =
        '<div class="pn-fold"><span class="pn-chev">▸</span> Thinking…</div>' +
        '<div class="pn-fold-body">GO means apply: the file does not exist yet, so it is one Write and ' +
        "then the suite. Retry on 429 and 5xx only — a 4xx is an answer, not a hiccup.</div>";
      show(thinking);

      // 4. the Write card, with the diff arriving line by line
      await wait(900);
      if (token !== playing) return;
      const card = el("div", "pn-tool", "");
      card.dataset.demo = "1";
      card.innerHTML =
        '<div class="pn-tool-head"><span class="pn-chev">▾</span><span class="pn-tool-name">Write</span>' +
        '<span class="pn-tool-path">src/llm/retry.ts</span>' +
        '<span class="pn-counts"><b>+24</b> <i>−0</i></span></div>' +
        '<div class="pn-tool-body"><div class="pn-label">Diff</div>' +
        '<pre class="pn-pre" data-diff></pre></div>';
      show(card);
      const pre = card.querySelector("[data-diff]");
      for (const line of GO_DIFF) {
        if (token !== playing) return;
        pre.insertAdjacentHTML("beforeend", (pre.childNodes.length > 1 ? "\n" : "") + line);
        pre.scrollTop = pre.scrollHeight;
        term.scrollTo({ top: term.scrollHeight, behavior: "smooth" });
        await wait(reduce ? 0 : 55);
      }

      // 5. the turn's own totals, once the tool has stopped writing
      await wait(320);
      if (token !== playing) return;
      const note = el(
        "div",
        "pn-meta pn-meta--turn",
        '<span class="pn-mode">Build</span> · applied — 24 lines written to src/llm/retry.ts',
      );
      note.dataset.demo = "1";
      show(note);
    }

    btns.forEach((b) =>
      b.addEventListener("click", () => {
        setMode(b.dataset.mode);
        if (b.dataset.mode === "build") playDemo();
        else resetDemo();
      }),
    );
    $("#pn-modal-cancel", panel)?.addEventListener("click", resetDemo);

    /* ── the invitation ──
       The switch is the only way into this section's point, and a switch nobody presses is the whole
       demo wasted. So when the section is on screen the BUILD half gets a slow ring and a real button
       appears under it that does exactly what it says; the first answer (switch, teaser, modal's
       confirm) ends the invitation for the rest of the visit. */
    const teaser = $("#modeTeaser");
    const buildBtn = $('.switch__btn[data-mode="build"]', modeSwitch);
    const modesSection = $("#modes");
    if (teaser && buildBtn && modesSection) {
      let invited = false;
      const modeKey = $(".pn-modebtn", panel);
      const stopInvite = () => {
        modeSwitch.classList.remove("is-inviting");
        teaser.classList.remove("is-on");
        panel.classList.remove("is-inviting");
      };
      const invite = () => {
        if (invited) return;
        invited = true;
        modeSwitch.classList.add("is-inviting");
        teaser.classList.add("is-on");
        panel.classList.add("is-inviting");
      };
      if ("IntersectionObserver" in window) {
        const io = new IntersectionObserver(
          (entries) => entries.forEach((e) => e.isIntersecting && invite()),
          { threshold: 0.35 },
        );
        io.observe(modesSection);
      } else {
        invite();
      }
      // The teaser IS the click it advertises.
      teaser.addEventListener("click", () => {
        stopInvite();
        buildBtn.click();
        buildBtn.focus({ preventScroll: true });
      });
      buildBtn.addEventListener("click", stopInvite);
      $("#pn-modal-ok", panel)?.addEventListener("click", stopInvite);

      /* …and the key under the reader's eyes does the same thing as the switch: one control, drawn in
         two places, which is what the panel itself does with its mode button. */
      if (modeKey) {
        const toggleMode = () => {
          stopInvite();
          const next = panel.classList.contains("is-build") ? "analyze" : "build";
          setMode(next);
          if (next === "build") playDemo();
          else resetDemo();
        };
        modeKey.addEventListener("click", toggleMode);
        modeKey.addEventListener("keydown", (e) => {
          if (e.key !== "Enter" && e.key !== " ") return;
          e.preventDefault();
          toggleMode();
        });
      }
    }
    // The modal's own answers: confirming switches the session (here: the switch), cancelling
    // closes the question and leaves you in Analyze — exactly what declining does.
    $("#pn-modal-ok", panel)?.addEventListener("click", () => {
      setMode("build");
      playDemo();
    });
    $("#pn-modal-cancel", panel)?.addEventListener("click", () => modal?.classList.add("is-hidden"));
    setMode("analyze");
    if (term) {
      // This transcript is not streamed in: it is HISTORY, already there when the page opens, so
      // every row it starts with is visible at once (the reveal belongs to the hero and to the
      // turn the demo appends — which is the only thing that should fade in).
      [...term.children].forEach((n) => n.classList.add("is-shown"));
      term.scrollTop = term.scrollHeight;
    }
  }

  /* ------------------------------------------------------ 09 sub-agent states */
  const agents = $$(".agent");
  if (agents.length) {
    /* The demo can STOP a sub-agent — and stopping is all it can do. `aborted`
     * is TERMINAL in the product: the webview hides the per-bubble abort button
     * once a sub-agent settles, the orchestrator is told the sub-task did not
     * finish, and only a NEW user message clears the run (`abortedDelegates`).
     * There is no resume, so the demo must not offer one: a settled card
     * re-arms by itself once it leaves the viewport and comes back, which keeps
     * it playable without promising something the extension cannot do. */
    const settled = (state) => state === "aborted" || state === "done";
    const stopLabel = (state) =>
      state === "aborted" ? "Aborted" : state === "done" ? "Done" : "Stop this";

    const stateOf = (agent) => {
      if (agent.classList.contains("is-aborted")) return "aborted";
      if (agent.classList.contains("is-done")) return "done";
      if (agent.classList.contains("is-queued")) return "queued";
      // The badge is the card's own word for its state, so trust it when the
      // class is missing: a card that says "queued" is queued.
      const badge = $("[data-state]", agent);
      return badge && /queued/i.test(badge.textContent) ? "queued" : "streaming";
    };

    const setState = (agent, state, label) => {
      agent.classList.remove("is-queued", "is-aborted", "is-done");
      if (state !== "streaming") agent.classList.add(`is-${state}`);
      const badge = $("[data-state]", agent);
      if (badge) badge.textContent = label;
      const stop = $(".agent__stop", agent);
      if (stop) {
        stop.textContent = stopLabel(state);
        // Actionable only while the sub-agent is live: running, or queued
        // behind the cap (a queued one is skipped when its turn comes).
        stop.disabled = settled(state);
      }
    };

    // Where each card rests, captured before the demo touches anything.
    const resting = new Map();
    agents.forEach((agent) => {
      const badge = $("[data-state]", agent);
      resting.set(agent, {
        state: stateOf(agent),
        label: badge ? badge.textContent : "streaming",
      });
    });

    agents.forEach((agent) => {
      const stop = $(".agent__stop", agent);
      if (!stop) return;
      stop.addEventListener("click", () => {
        if (stop.disabled) return;
        setState(agent, "aborted", "aborted");
      });
    });

    /* the queued agent behind the cap gets its turn */
    const queued = $('[data-agent="c"]');
    let qo = null;
    let kickTimer = 0;
    let doneTimer = 0;
    if (queued && !reduce) {
      const kick = () => {
        if (stateOf(queued) !== "queued") return;
        setState(queued, "streaming", "streaming");
        doneTimer = window.setTimeout(() => {
          if (stateOf(queued) === "streaming") setState(queued, "done", "done");
        }, 5200);
      };
      qo = new IntersectionObserver(
        (entries, obs) => {
          entries.forEach((e) => {
            if (!e.isIntersecting) return;
            kickTimer = window.setTimeout(kick, 2400);
            obs.unobserve(e.target);
          });
        },
        { threshold: 0.4 }
      );
      qo.observe(queued);
    }

    /* Re-arm a settled card once it is out of sight: the demo starts over on the
     * next scroll instead of freezing on a state it cannot undo. A card that is
     * still live is left alone — it is the user's to stop. */
    if (!reduce) {
      const rearm = new IntersectionObserver(
        (entries) => {
          for (const e of entries) {
            if (e.isIntersecting) continue;
            const agent = e.target;
            if (!settled(stateOf(agent))) continue;
            window.clearTimeout(kickTimer);
            window.clearTimeout(doneTimer);
            const rest = resting.get(agent);
            if (rest) setState(agent, rest.state, rest.label);
            // The re-armed queued card must replay its turn, not sit at rest.
            if (agent === queued && qo) qo.observe(agent);
          }
        },
        { threshold: 0 }
      );
      agents.forEach((a) => rearm.observe(a));
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

  /* --------------------------------------------------- 12 showreels (facade) */
  // The poster is already a link to YouTube, so this module only upgrades the click: it swaps the
  // thumbnail for the player in place instead of opening a tab. If this never runs, nothing breaks.
  // Every [data-video] frame is upgraded — the hero showreel and the clip inside the Parallel
  // section share the same markup, so they must not share the "first one wins" of a $() lookup.
  const canEmbed = /^https?:$/.test(window.location.protocol);
  // YouTube refuses to play when there is no referrer to validate, and it says so with
  // "Error 153 — Video player configuration error". A file:// page has no referrer at all and
  // the policy cannot invent one, so on local double-click previews we keep the plain link
  // (the <a> is already a valid destination) instead of mounting a player that cannot work.
  // Verified: same iframe loads fine over http(s), including localhost — only file:// fails.
  $$(".reel__frame").forEach((reel) => {
    const play = $(".reel__play", reel);
    const id = reel.dataset.video;
    if (!play || !id || !canEmbed) return;
    play.addEventListener("click", (ev) => {
      ev.preventDefault();
      const frame = document.createElement("iframe");
      frame.className = "reel__embed";
      // youtube-nocookie: no tracking cookies until the visitor actually presses play
      frame.src = `https://www.youtube-nocookie.com/embed/${id}?autoplay=1&rel=0`;
      frame.title = reel.dataset.title || "Harny demo";
      frame.allow =
        "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share";
      // setAttribute, not the property: not every engine reflects referrerPolicy back to the attr,
      // and without the attribute this is exactly the request that triggers error 153.
      frame.setAttribute("referrerpolicy", "strict-origin-when-cross-origin");
      frame.allowFullscreen = true;
      play.replaceWith(frame);
      frame.focus();
    });
  });

  /* --------------------------------------------------------- 13 misc niceties */
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
