(() => {
  "use strict";

  const DATA = window.MATERIALS_APP_DATA;
  const root = document.getElementById("view-root");
  const modalRoot = document.getElementById("modal-root");
  const toastElement = document.getElementById("toast");
  const STORAGE_KEY = "materials-recall-state-v1";

  if (!DATA || !Array.isArray(DATA.questions)) {
    root.innerHTML = '<div class="empty-state"><h2>题库数据未加载</h2><p>请确认 data.js 与 index.html 位于同一目录。</p></div>';
    return;
  }

  const questionMap = new Map(DATA.questions.map((question) => [question.id, question]));
  const knowledgeMap = new Map(DATA.knowledge.map((point) => [point.id, point]));
  const chapterNames = [...new Set(DATA.questions.map((question) => question.chapter))];
  const typeNames = [...new Set(DATA.questions.map((question) => question.type))];

  const defaultState = {
    version: 1,
    reviews: {},
    knowledgeReviews: {},
    wrong: [],
    favorites: [],
    dailyGoal: 20,
    history: {},
    lastView: "study",
  };

  let state = loadState();
  let toastTimer = 0;
  const runtime = {
    view: state.lastView || "study",
    queue: [],
    queueMode: "mixed",
    index: 0,
    revealed: false,
    objectiveCorrect: null,
    selected: new Set(),
    drafts: {},
    sessionStats: { forgot: 0, fuzzy: 0, mastered: 0 },
    bank: {
      search: "",
      source: "all",
      chapter: "all",
      type: "all",
      status: "all",
      limit: 60,
    },
    knowledge: {
      module: "all",
      search: "",
      currentId: null,
      revealed: false,
    },
    wrongMode: "all",
  };

  function loadState() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
      if (!saved || saved.version !== 1) return structuredClone(defaultState);
      return {
        ...structuredClone(defaultState),
        ...saved,
        reviews: saved.reviews || {},
        knowledgeReviews: saved.knowledgeReviews || {},
        wrong: [...new Set(saved.wrong || [])],
        favorites: [...new Set(saved.favorites || [])],
        history: saved.history || {},
      };
    } catch {
      return structuredClone(defaultState);
    }
  }

  function saveState() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      // The app remains usable when storage is unavailable.
    }
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function textHtml(value) {
    return escapeHtml(value).replaceAll("\n", "<br>");
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function dateKey(date = new Date()) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  function dateAfter(days) {
    const date = new Date();
    date.setHours(12, 0, 0, 0);
    date.setDate(date.getDate() + days);
    return dateKey(date);
  }

  function shortChapter(chapter) {
    if (chapter === "绪论") return chapter;
    return chapter.replace(/^第([一二三四五六七八九十]+)章\s*/, "第$1章 ");
  }

  function compactChapter(chapter) {
    if (chapter === "绪论") return chapter;
    const match = chapter.match(/^(第[一二三四五六七八九十]+章)/);
    return match ? match[1] : chapter;
  }

  function hashString(value) {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  }

  function seededRandom(seed) {
    let value = seed >>> 0;
    return () => {
      value += 0x6d2b79f5;
      let result = value;
      result = Math.imul(result ^ (result >>> 15), result | 1);
      result ^= result + Math.imul(result ^ (result >>> 7), result | 61);
      return ((result ^ (result >>> 14)) >>> 0) / 4294967296;
    };
  }

  function shuffle(items, seedText) {
    const result = [...items];
    const random = seededRandom(hashString(seedText));
    for (let index = result.length - 1; index > 0; index -= 1) {
      const target = Math.floor(random() * (index + 1));
      [result[index], result[target]] = [result[target], result[index]];
    }
    return result;
  }

  function reviewOf(id, knowledge = false) {
    const source = knowledge ? state.knowledgeReviews : state.reviews;
    return source[id] || null;
  }

  function questionStatus(id) {
    if (state.wrong.includes(id)) return "wrong";
    const review = reviewOf(id);
    if (!review || !review.attempts) return "new";
    if ((review.level || 0) >= 3) return "mastered";
    return "learning";
  }

  function statusLabel(status) {
    return {
      new: "未学习",
      learning: "学习中",
      mastered: "已掌握",
      wrong: "错题",
    }[status] || "未学习";
  }

  function sourceMatch(question, mode) {
    if (mode === "original") return question.source === "平台原题";
    if (mode === "subjective") return question.source === "填空简答专项";
    if (mode === "definition") return question.source === "定义强化专项";
    return true;
  }

  function createSession(mode = runtime.queueMode, customIds = null) {
    runtime.queueMode = mode;
    const today = dateKey();
    let ids = [];

    if (customIds) {
      ids = customIds.filter((id) => questionMap.has(id));
    } else {
      const candidates = DATA.questions.filter((question) => sourceMatch(question, mode));
      const due = [];
      const unseen = [];
      const future = [];
      for (const question of candidates) {
        const review = reviewOf(question.id);
        if (!review || !review.attempts) {
          unseen.push(question.id);
        } else if (!review.nextDue || review.nextDue <= today || state.wrong.includes(question.id)) {
          due.push(question.id);
        } else {
          future.push(question.id);
        }
      }
      due.sort((left, right) => {
        const leftWrong = state.wrong.includes(left) ? 0 : 1;
        const rightWrong = state.wrong.includes(right) ? 0 : 1;
        if (leftWrong !== rightWrong) return leftWrong - rightWrong;
        return String(reviewOf(left)?.nextDue || "").localeCompare(String(reviewOf(right)?.nextDue || ""));
      });
      const ordered = [
        ...shuffle(due, `${today}-${mode}-due`),
        ...shuffle(unseen, `${today}-${mode}-new`),
        ...shuffle(future, `${today}-${mode}-future`),
      ];
      ids = [...new Set(ordered)].slice(0, state.dailyGoal);
    }

    runtime.queue = ids;
    runtime.index = 0;
    runtime.revealed = false;
    runtime.objectiveCorrect = null;
    runtime.selected = new Set();
    runtime.sessionStats = { forgot: 0, fuzzy: 0, mastered: 0 };
    render();
  }

  function setView(view) {
    runtime.view = view;
    state.lastView = view;
    saveState();
    render();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function refreshIcons() {
    if (window.lucide) {
      window.lucide.createIcons({ attrs: { "aria-hidden": "true" } });
    }
  }

  function showToast(message) {
    window.clearTimeout(toastTimer);
    toastElement.textContent = message;
    toastElement.classList.add("is-visible");
    toastTimer = window.setTimeout(() => toastElement.classList.remove("is-visible"), 2200);
  }

  function totalMastered() {
    return Object.values(state.reviews).filter((review) => (review.level || 0) >= 3).length;
  }

  function historicalWrongIds() {
    return DATA.questions.filter((question) => question.historicalWrong).map((question) => question.id);
  }

  function allWrongIds() {
    return [...new Set([...state.wrong, ...historicalWrongIds()])].filter((id) => questionMap.has(id));
  }

  function updateShell() {
    document.querySelectorAll(".nav-item").forEach((button) => {
      button.classList.toggle("is-active", button.dataset.view === runtime.view);
    });
    const mastered = totalMastered();
    const percent = Math.round((mastered / DATA.stats.totalQuestions) * 100);
    document.getElementById("sidebar-mastery").textContent = `${percent}%`;
    document.getElementById("sidebar-progress-bar").style.width = `${percent}%`;
    document.getElementById("sidebar-progress-copy").textContent = `${mastered} / ${DATA.stats.totalQuestions}`;
    document.getElementById("wrong-count").textContent = String(allWrongIds().length);
    document.getElementById("today-count").textContent = String(state.history[dateKey()] || 0);
  }

  function render() {
    updateShell();
    if (runtime.view === "study") renderStudy();
    if (runtime.view === "bank") renderBank();
    if (runtime.view === "knowledge") renderKnowledge();
    if (runtime.view === "wrong") renderWrong();
    if (runtime.view === "stats") renderStats();
    refreshIcons();
  }

  function currentQuestion() {
    return questionMap.get(runtime.queue[runtime.index]) || null;
  }

  function isObjective(question) {
    return question.options.length > 0 && question.correctLabels.length > 0;
  }

  function setsEqual(left, right) {
    if (left.size !== right.size) return false;
    return [...left].every((value) => right.has(value));
  }

  function questionImagesHtml(question, modal = false) {
    if (!question.images.length) return "";
    return `<div class="question-media ${modal ? "is-modal" : ""}">${question.images
      .map(
        (path) => `<figure><img src="${escapeHtml(path)}" alt="${escapeHtml(question.id)} 题图" loading="lazy"></figure>`,
      )
      .join("")}</div>`;
  }

  function optionHtml(question, option) {
    const selected = runtime.selected.has(option.label);
    const correct = runtime.revealed && question.correctLabels.includes(option.label);
    const wrong = runtime.revealed && selected && !correct;
    const classes = ["option-item"];
    if (selected) classes.push("is-selected");
    if (correct) classes.push("is-correct");
    if (wrong) classes.push("is-wrong");
    const multiple = question.type.includes("多选") || question.correctLabels.length > 1;
    const stateIcon = correct ? "check" : wrong ? "x" : "circle";
    return `
      <label class="${classes.join(" ")}">
        <input class="option-input" type="${multiple ? "checkbox" : "radio"}" name="question-option" value="${escapeHtml(option.label)}" ${selected ? "checked" : ""} ${runtime.revealed ? "disabled" : ""}>
        <span class="option-marker">${escapeHtml(option.label)}</span>
        <span>${textHtml(option.text)}</span>
        <span class="option-state"><i data-lucide="${stateIcon}"></i></span>
      </label>`;
  }

  function relatedKnowledgeFor(question) {
    const direct = question.knowledgeIds.map((id) => knowledgeMap.get(id)).filter(Boolean);
    if (direct.length) return direct.slice(0, 3);
    return DATA.knowledge.filter((point) => point.module === question.chapter).slice(0, 3);
  }

  function answerHtml(question) {
    const objective = isObjective(question);
    let statusClass = "";
    let statusIcon = "book-open-check";
    let statusText = "参考答案已显示";
    if (objective) {
      statusClass = runtime.objectiveCorrect ? "is-correct" : "is-wrong";
      statusIcon = runtime.objectiveCorrect ? "circle-check-big" : "circle-x";
      statusText = runtime.objectiveCorrect ? "回答正确" : "回答错误";
    }
    const answerContent = question.answerPoints.length > 1
      ? `<ul class="answer-points">${question.answerPoints.map((point) => `<li>${textHtml(point)}</li>`).join("")}</ul>`
      : `<p class="answer-text">${textHtml(question.answerText)}</p>`;
    const warning = question.platformSuspect
      ? `<div class="answer-section"><h3 class="answer-title"><i data-lucide="badge-alert"></i>教材校正</h3><p class="answer-text">本题存在平台错键、冲突或表述问题，当前答案已按教材结论整理。</p></div>`
      : "";
    return `
      <div class="answer-reveal">
        <div class="answer-status ${statusClass}"><i data-lucide="${statusIcon}"></i><span>${statusText}</span></div>
        <div class="answer-section">
          <h3 class="answer-title"><i data-lucide="check-check"></i>参考答案</h3>
          ${answerContent}
        </div>
        <div class="answer-section">
          <h3 class="answer-title"><i data-lucide="scan-text"></i>解析</h3>
          <p class="answer-text">${textHtml(question.analysis)}</p>
        </div>
        ${warning}
        <div class="rating-panel">
          <span class="rating-label">本题掌握情况</span>
          <div class="rating-buttons">
            <button class="rating-button is-forgot" type="button" data-action="rate-question" data-rating="0"><i data-lucide="rotate-ccw"></i>忘记</button>
            <button class="rating-button is-fuzzy" type="button" data-action="rate-question" data-rating="1"><i data-lucide="cloudy"></i>模糊</button>
            <button class="rating-button is-mastered" type="button" data-action="rate-question" data-rating="2"><i data-lucide="check"></i>掌握</button>
          </div>
        </div>
      </div>`;
  }

  function contextRailHtml(question) {
    const related = relatedKnowledgeFor(question);
    const queuePreview = runtime.queue.slice(runtime.index, runtime.index + 4);
    const reviewedToday = state.history[dateKey()] || 0;
    return `
      <aside class="context-rail">
        <section class="context-section">
          <h2 class="context-title">学习范围<span>${DATA.stats.totalQuestions}题</span></h2>
          <div class="segmented">
            ${[
              ["mixed", "混合"],
              ["original", "原题"],
              ["subjective", "专项"],
              ["definition", "定义"],
            ]
              .map(
                ([mode, label]) => `<button class="segment-button ${runtime.queueMode === mode ? "is-active" : ""}" type="button" data-action="set-session-mode" data-mode="${mode}">${label}</button>`,
              )
              .join("")}
          </div>
        </section>
        <section class="context-section">
          <h2 class="context-title">本次学习</h2>
          <div class="session-metrics">
            <div class="session-metric"><strong>${runtime.queue.length}</strong><span>本组题量</span></div>
            <div class="session-metric"><strong>${reviewedToday}</strong><span>今日完成</span></div>
            <div class="session-metric"><strong>${runtime.sessionStats.mastered}</strong><span>本组掌握</span></div>
            <div class="session-metric"><strong>${runtime.sessionStats.forgot}</strong><span>本组遗忘</span></div>
          </div>
        </section>
        <section class="context-section">
          <h2 class="context-title">关联知识点<span>${related.length}</span></h2>
          <div class="knowledge-links">
            ${related
              .map(
                (point) => `<button class="knowledge-link" type="button" data-action="open-knowledge" data-id="${point.id}"><small>${escapeHtml(compactChapter(point.module))}</small>${escapeHtml(point.name)}</button>`,
              )
              .join("") || '<span class="section-subtitle">暂无直接关联项</span>'}
          </div>
        </section>
        <section class="context-section">
          <h2 class="context-title">题组进度</h2>
          <div class="queue-list">
            ${queuePreview
              .map((id, index) => {
                const item = questionMap.get(id);
                return `<button class="queue-item ${index === 0 ? "is-current" : ""}" type="button" data-action="queue-jump" data-offset="${index}"><small>${index === 0 ? "当前" : `后续 ${index}`}</small>${escapeHtml(item ? item.id : id)} · ${escapeHtml(item ? compactChapter(item.chapter) : "")}</button>`;
              })
              .join("")}
          </div>
        </section>
      </aside>`;
  }

  function renderStudy() {
    if (!runtime.queue.length) {
      createSession(runtime.queueMode);
      return;
    }
    const question = currentQuestion();
    if (!question) {
      renderSessionComplete();
      return;
    }
    const objective = isObjective(question);
    const progress = Math.round((runtime.index / runtime.queue.length) * 100);
    const favorite = state.favorites.includes(question.id);
    const input = objective
      ? `<div class="option-list">${question.options.map((option) => optionHtml(question, option)).join("")}</div>`
      : `<textarea class="response-input ${question.type.includes("简答") || question.type.includes("作图") || question.type.includes("计算") ? "is-long" : ""}" data-role="draft" placeholder="在此作答" ${runtime.revealed ? "disabled" : ""}>${escapeHtml(runtime.drafts[question.id] || "")}</textarea>`;
    root.innerHTML = `
      <section class="study-layout">
        <div class="study-column">
          <div class="session-strip">
            <div class="session-info"><strong>${runtime.index + 1} / ${runtime.queue.length}</strong><span>今日题组</span></div>
            <div class="session-progress" aria-label="题组进度"><span style="width:${progress}%"></span></div>
            <button class="icon-button" type="button" data-action="skip-question" title="稍后再做" aria-label="稍后再做"><i data-lucide="skip-forward"></i></button>
          </div>
          <article class="question-panel">
            <div class="question-toolbar">
              <div class="question-meta">
                <span class="meta-label is-source">${escapeHtml(question.source)}</span>
                <span class="meta-label">${escapeHtml(question.type)}</span>
                <span class="question-id">${escapeHtml(question.id)} · ${escapeHtml(shortChapter(question.chapter))}</span>
              </div>
              <button class="icon-button ${favorite ? "is-active" : ""}" type="button" data-action="toggle-favorite" data-id="${question.id}" title="${favorite ? "取消收藏" : "收藏"}" aria-label="${favorite ? "取消收藏" : "收藏"}"><i data-lucide="star"></i></button>
            </div>
            <h1 class="question-prompt">${textHtml(question.prompt)}</h1>
            ${questionImagesHtml(question)}
            ${input}
            ${runtime.revealed ? answerHtml(question) : ""}
            ${
              runtime.revealed
                ? ""
                : `<div class="question-actions">
                    <div class="question-actions-main">
                      <button class="primary-button" type="button" data-action="reveal-answer"><i data-lucide="${objective ? "send" : "eye"}"></i>${objective ? "提交答案" : "查看答案"}</button>
                      <button class="icon-button" type="button" data-action="skip-question" title="稍后再做" aria-label="稍后再做"><i data-lucide="arrow-right"></i></button>
                    </div>
                    <span class="section-subtitle">${escapeHtml(question.sourceText || question.source)}</span>
                  </div>`
            }
          </article>
        </div>
        ${contextRailHtml(question)}
      </section>`;
  }

  function renderSessionComplete() {
    const total = runtime.sessionStats.forgot + runtime.sessionStats.fuzzy + runtime.sessionStats.mastered;
    root.innerHTML = `
      <section class="study-layout">
        <div class="study-column">
          <div class="session-complete">
            <div class="session-complete-icon"><i data-lucide="badge-check"></i></div>
            <h2>本组完成</h2>
            <p>完成 ${total} 题，掌握 ${runtime.sessionStats.mastered} 题，模糊 ${runtime.sessionStats.fuzzy} 题，遗忘 ${runtime.sessionStats.forgot} 题。</p>
            <button class="primary-button" type="button" data-action="restart-session"><i data-lucide="refresh-cw"></i>继续下一组</button>
          </div>
        </div>
        <aside class="context-rail">
          <section class="context-section">
            <h2 class="context-title">本次结果</h2>
            <div class="session-metrics">
              <div class="session-metric"><strong>${total}</strong><span>已完成</span></div>
              <div class="session-metric"><strong>${runtime.sessionStats.mastered}</strong><span>已掌握</span></div>
              <div class="session-metric"><strong>${runtime.sessionStats.fuzzy}</strong><span>仍模糊</span></div>
              <div class="session-metric"><strong>${runtime.sessionStats.forgot}</strong><span>需重练</span></div>
            </div>
          </section>
        </aside>
      </section>`;
  }

  function revealAnswer() {
    const question = currentQuestion();
    if (!question || runtime.revealed) return;
    if (isObjective(question)) {
      if (!runtime.selected.size) {
        showToast("请先选择答案");
        return;
      }
      runtime.objectiveCorrect = setsEqual(runtime.selected, new Set(question.correctLabels));
      window.CaikejiNative?.answer(runtime.objectiveCorrect);
      if (!runtime.objectiveCorrect && !state.wrong.includes(question.id)) {
        state.wrong.push(question.id);
        saveState();
      }
    }
    runtime.revealed = true;
    render();
  }

  function applyReview(id, rating, knowledge = false) {
    const collection = knowledge ? state.knowledgeReviews : state.reviews;
    const review = collection[id] || {
      attempts: 0,
      level: 0,
      interval: 0,
      correctStreak: 0,
      wrongCount: 0,
    };
    review.attempts += 1;
    review.lastReviewed = new Date().toISOString();

    if (rating === 0) {
      review.level = Math.max(0, review.level - 1);
      review.interval = 0;
      review.correctStreak = 0;
      review.wrongCount += 1;
      review.nextDue = dateKey();
      if (!knowledge && !state.wrong.includes(id)) state.wrong.push(id);
    } else if (rating === 1) {
      review.level = Math.max(1, review.level);
      review.interval = 1;
      review.correctStreak = 0;
      review.nextDue = dateAfter(1);
    } else {
      const intervals = [1, 3, 7, 15, 30, 60, 120];
      review.level = Math.min(6, review.level + 1);
      review.interval = intervals[review.level] || 120;
      review.correctStreak += 1;
      review.nextDue = dateAfter(review.interval);
      if (!knowledge && review.correctStreak >= 2) {
        state.wrong = state.wrong.filter((wrongId) => wrongId !== id);
      }
    }
    collection[id] = review;
    const today = dateKey();
    state.history[today] = (state.history[today] || 0) + 1;
    saveState();
  }

  function rateCurrentQuestion(rating) {
    const question = currentQuestion();
    if (!question) return;
    window.CaikejiNative?.rating(rating);
    applyReview(question.id, rating, false);
    if (rating === 0) runtime.sessionStats.forgot += 1;
    if (rating === 1) runtime.sessionStats.fuzzy += 1;
    if (rating === 2) runtime.sessionStats.mastered += 1;
    runtime.index += 1;
    runtime.revealed = false;
    runtime.objectiveCorrect = null;
    runtime.selected = new Set();
    render();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function skipQuestion(offset = 0) {
    if (runtime.queue.length <= 1) return;
    const targetIndex = runtime.index + offset;
    if (offset > 0 && targetIndex < runtime.queue.length) {
      const [target] = runtime.queue.splice(targetIndex, 1);
      runtime.queue.splice(runtime.index, 0, target);
    } else {
      const [current] = runtime.queue.splice(runtime.index, 1);
      runtime.queue.push(current);
    }
    runtime.revealed = false;
    runtime.objectiveCorrect = null;
    runtime.selected = new Set();
    render();
  }

  function toggleFavorite(id) {
    if (state.favorites.includes(id)) {
      state.favorites = state.favorites.filter((favoriteId) => favoriteId !== id);
      showToast("已取消收藏");
    } else {
      state.favorites.push(id);
      showToast("已收藏");
    }
    saveState();
    render();
  }

  function selectOptions(values, selectedValue, multiple) {
    const next = new Set(values);
    if (multiple) {
      if (next.has(selectedValue)) next.delete(selectedValue);
      else next.add(selectedValue);
    } else {
      next.clear();
      next.add(selectedValue);
    }
    runtime.selected = next;
  }

  function selectOptionsHtml(options, selected, placeholder) {
    return `<option value="all">${escapeHtml(placeholder)}</option>${options
      .map((value) => `<option value="${escapeHtml(value)}" ${selected === value ? "selected" : ""}>${escapeHtml(value)}</option>`)
      .join("")}`;
  }

  function filteredBankQuestions() {
    const filters = runtime.bank;
    const search = filters.search.trim().toLowerCase();
    return DATA.questions.filter((question) => {
      if (filters.source === "platform" && question.source !== "平台原题") return false;
      if (filters.source === "subjective" && question.source !== "填空简答专项") return false;
      if (filters.source === "definition" && question.source !== "定义强化专项") return false;
      if (filters.chapter !== "all" && question.chapter !== filters.chapter) return false;
      if (filters.type !== "all" && question.type !== filters.type) return false;
      if (filters.status !== "all" && questionStatus(question.id) !== filters.status) return false;
      if (!search) return true;
      const haystack = `${question.id} ${question.prompt} ${question.answerText} ${question.tags.join(" ")}`.toLowerCase();
      return haystack.includes(search);
    });
  }

  function questionListHtml(questions, limit = runtime.bank.limit) {
    const visible = questions.slice(0, limit);
    if (!visible.length) {
      return '<div class="empty-state"><div class="empty-icon"><i data-lucide="search-x"></i></div><h2>没有匹配题目</h2><p>当前筛选条件下没有结果。</p></div>';
    }
    return `
      <div class="question-list">
        <div class="scroll-table">
          <div class="question-list-head"><span>题号</span><span>题目</span><span>章节</span><span>类型</span><span>状态</span></div>
          ${visible
            .map((question) => {
              const status = questionStatus(question.id);
              return `<button class="question-row" type="button" data-action="open-question" data-id="${question.id}">
                <span class="question-row-id">${escapeHtml(question.id)}</span>
                <span class="question-row-prompt">${escapeHtml(question.prompt)}</span>
                <span class="question-row-cell">${escapeHtml(compactChapter(question.chapter))}</span>
                <span class="question-row-cell">${escapeHtml(question.type)}</span>
                <span class="status-pill is-${status}">${statusLabel(status)}</span>
              </button>`;
            })
            .join("")}
        </div>
        ${
          questions.length > visible.length
            ? `<div class="list-footer"><button class="secondary-button" type="button" data-action="load-more"><i data-lucide="chevrons-down"></i>加载更多</button></div>`
            : ""
        }
      </div>`;
  }

  function renderBank() {
    root.innerHTML = `
      <section class="view-section">
        <header class="section-head">
          <div class="section-title-wrap"><h1 class="section-title">全量题库</h1><p class="section-subtitle">平台原题、填空简答专项与定义强化专项统一检索</p></div>
          <button class="primary-button" type="button" data-action="start-filtered"><i data-lucide="play"></i>练习筛选结果</button>
        </header>
        <div class="metric-strip">
          <div class="metric-block"><strong>${DATA.stats.totalQuestions}</strong><span>总题数</span></div>
          <div class="metric-block"><strong>${DATA.stats.originalQuestions}</strong><span>平台原题</span></div>
          <div class="metric-block"><strong>${DATA.stats.fillQuestions}</strong><span>填空专项</span></div>
          <div class="metric-block"><strong>${DATA.stats.shortQuestions}</strong><span>简答与作图</span></div>
          <div class="metric-block"><strong>${DATA.stats.definitionQuestions}</strong><span>定义强化</span></div>
        </div>
        <div class="filter-bar">
          <label class="search-field"><i data-lucide="search"></i><input id="bank-search" type="search" value="${escapeHtml(runtime.bank.search)}" placeholder="搜索题目、答案或考点"></label>
          <select class="filter-select" data-filter="source">
            <option value="all">全部来源</option>
            <option value="platform" ${runtime.bank.source === "platform" ? "selected" : ""}>平台原题</option>
            <option value="subjective" ${runtime.bank.source === "subjective" ? "selected" : ""}>填空简答专项</option>
            <option value="definition" ${runtime.bank.source === "definition" ? "selected" : ""}>定义强化专项</option>
          </select>
          <select class="filter-select" data-filter="chapter">${selectOptionsHtml(chapterNames, runtime.bank.chapter, "全部章节")}</select>
          <select class="filter-select" data-filter="type">${selectOptionsHtml(typeNames, runtime.bank.type, "全部题型")}</select>
          <select class="filter-select" data-filter="status">
            <option value="all">全部状态</option>
            <option value="new" ${runtime.bank.status === "new" ? "selected" : ""}>未学习</option>
            <option value="learning" ${runtime.bank.status === "learning" ? "selected" : ""}>学习中</option>
            <option value="mastered" ${runtime.bank.status === "mastered" ? "selected" : ""}>已掌握</option>
            <option value="wrong" ${runtime.bank.status === "wrong" ? "selected" : ""}>我的错题</option>
          </select>
        </div>
        <p class="section-subtitle" id="bank-result-count"></p>
        <div id="bank-results"></div>
      </section>`;
    updateBankResults();
  }

  function updateBankResults() {
    const questions = filteredBankQuestions();
    const count = document.getElementById("bank-result-count");
    const container = document.getElementById("bank-results");
    if (!container) return;
    count.textContent = `匹配 ${questions.length} 题`;
    container.innerHTML = questionListHtml(questions);
    refreshIcons();
  }

  function openQuestionModal(id) {
    const question = questionMap.get(id);
    if (!question) return;
    const favorite = state.favorites.includes(id);
    const options = question.options.length
      ? `<div class="modal-options">${question.options
          .map(
            (option) => `<div class="modal-option ${question.correctLabels.includes(option.label) ? "is-correct" : ""}"><strong>${escapeHtml(option.label)}.</strong> ${textHtml(option.text)}</div>`,
          )
          .join("")}</div>`
      : "";
    modalRoot.innerHTML = `
      <div class="modal-backdrop" data-action="close-modal">
        <section class="modal-dialog" role="dialog" aria-modal="true" aria-labelledby="modal-title">
          <header class="modal-header">
            <strong id="modal-title">${escapeHtml(question.id)} · ${escapeHtml(question.type)}</strong>
            <button class="icon-button" type="button" data-action="close-modal" title="关闭" aria-label="关闭"><i data-lucide="x"></i></button>
          </header>
          <div class="modal-body">
            <div class="question-meta">
              <span class="meta-label is-source">${escapeHtml(question.source)}</span>
              <span class="meta-label">${escapeHtml(shortChapter(question.chapter))}</span>
              ${question.platformSuspect ? '<span class="status-pill is-learning">教材校正</span>' : ""}
            </div>
            <h2 class="modal-prompt">${textHtml(question.prompt)}</h2>
            ${questionImagesHtml(question, true)}
            ${options}
            <div class="answer-section"><h3 class="answer-title"><i data-lucide="check-check"></i>参考答案</h3><p class="answer-text">${textHtml(question.answerText)}</p></div>
            <div class="answer-section"><h3 class="answer-title"><i data-lucide="scan-text"></i>解析</h3><p class="answer-text">${textHtml(question.analysis)}</p></div>
            <div class="tag-list">${question.tags.map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join("")}</div>
          </div>
          <footer class="modal-footer">
            <button class="secondary-button" type="button" data-action="toggle-modal-favorite" data-id="${id}"><i data-lucide="star"></i>${favorite ? "取消收藏" : "收藏"}</button>
            <button class="primary-button" type="button" data-action="practice-question" data-id="${id}"><i data-lucide="play"></i>练这道题</button>
          </footer>
        </section>
      </div>`;
    document.body.style.overflow = "hidden";
    refreshIcons();
  }

  function closeModal() {
    modalRoot.innerHTML = "";
    document.body.style.overflow = "";
  }

  function knowledgeFiltered() {
    const search = runtime.knowledge.search.trim().toLowerCase();
    return DATA.knowledge.filter((point) => {
      if (runtime.knowledge.module !== "all" && point.module !== runtime.knowledge.module) return false;
      if (!search) return true;
      return `${point.id} ${point.name} ${point.unit} ${point.module}`.toLowerCase().includes(search);
    });
  }

  function orderedKnowledgePoints(points) {
    return [...points].sort((left, right) => {
      const leftReview = reviewOf(left.id, true);
      const rightReview = reviewOf(right.id, true);
      const leftLevel = leftReview?.level || 0;
      const rightLevel = rightReview?.level || 0;
      if (leftLevel !== rightLevel) return leftLevel - rightLevel;
      const leftMastery = left.mastery ?? 101;
      const rightMastery = right.mastery ?? 101;
      if (leftMastery !== rightMastery) return leftMastery - rightMastery;
      return left.id.localeCompare(right.id);
    });
  }

  function currentKnowledgePoint() {
    const filtered = orderedKnowledgePoints(knowledgeFiltered());
    if (!filtered.length) return null;
    const selected = knowledgeMap.get(runtime.knowledge.currentId);
    if (selected && filtered.some((point) => point.id === selected.id)) return selected;
    runtime.knowledge.currentId = filtered[0].id;
    return filtered[0];
  }

  function knowledgeIndexHtml() {
    const points = orderedKnowledgePoints(knowledgeFiltered());
    if (!points.length) return '<div class="empty-state"><h2>没有匹配知识点</h2></div>';
    return points
      .map((point) => {
        const review = reviewOf(point.id, true);
        const local = review ? `L${review.level || 0}` : "未学";
        return `<button class="point-row ${runtime.knowledge.currentId === point.id ? "is-active" : ""}" type="button" data-action="select-knowledge" data-id="${point.id}">
          <span class="point-code">${point.id}</span>
          <span class="point-name">${escapeHtml(point.name)}</span>
          <span class="point-mastery">${local}</span>
        </button>`;
      })
      .join("");
  }

  function renderKnowledge() {
    const point = currentKnowledgePoint();
    if (!point) {
      root.innerHTML = '<div class="empty-state"><h2>知识点为空</h2></div>';
      return;
    }
    const points = orderedKnowledgePoints(knowledgeFiltered());
    const pointIndex = points.findIndex((item) => item.id === point.id);
    const relatedQuestions = DATA.questions.filter((question) => question.knowledgeIds.includes(point.id)).slice(0, 4);
    const summary = point.summary.length
      ? point.summary
      : [`本知识点归入“${point.module}”，应结合定义、条件、结构特征与典型应用进行复述。`];
    root.innerHTML = `
      <section class="view-section">
        <header class="section-head">
          <div class="section-title-wrap"><h1 class="section-title">知识背诵</h1><p class="section-subtitle">97项课程知识目录 · 主动回忆与分级复习</p></div>
        </header>
        <div class="knowledge-layout">
          <article class="knowledge-card">
            <div class="knowledge-card-head"><span>${escapeHtml(point.id)} · ${escapeHtml(point.unit || compactChapter(point.module))}</span><strong>${pointIndex + 1} / ${points.length}</strong></div>
            <div class="knowledge-term"><small>${escapeHtml(shortChapter(point.module))}</small><h2>${escapeHtml(point.name)}</h2></div>
            ${
              runtime.knowledge.revealed
                ? `<div class="knowledge-back">
                    <ul class="knowledge-notes">${summary.map((note) => `<li>${textHtml(note)}</li>`).join("")}</ul>
                    ${
                      relatedQuestions.length
                        ? `<div class="context-section"><h3 class="context-title">关联题目<span>${relatedQuestions.length}</span></h3><div class="knowledge-links">${relatedQuestions.map((question) => `<button class="knowledge-link" type="button" data-action="open-question" data-id="${question.id}"><small>${question.id} · ${escapeHtml(question.type)}</small>${escapeHtml(question.prompt)}</button>`).join("")}</div></div>`
                        : ""
                    }
                    <div class="knowledge-card-actions">
                      <span class="section-subtitle">平台掌握度 ${point.mastery ?? "未知"}%</span>
                      <div class="rating-buttons">
                        <button class="rating-button is-forgot" type="button" data-action="rate-knowledge" data-rating="0">忘记</button>
                        <button class="rating-button is-fuzzy" type="button" data-action="rate-knowledge" data-rating="1">模糊</button>
                        <button class="rating-button is-mastered" type="button" data-action="rate-knowledge" data-rating="2">掌握</button>
                      </div>
                    </div>
                  </div>`
                : `<div class="knowledge-card-actions"><span class="section-subtitle">平台掌握度 ${point.mastery ?? "未知"}%</span><button class="primary-button" type="button" data-action="reveal-knowledge"><i data-lucide="eye"></i>查看考点</button></div>`
            }
          </article>
          <aside class="knowledge-index">
            <div class="knowledge-index-head"><strong>知识目录</strong><input class="knowledge-search" id="knowledge-search" type="search" value="${escapeHtml(runtime.knowledge.search)}" placeholder="搜索知识点"></div>
            <div class="module-tabs">
              <button class="module-tab ${runtime.knowledge.module === "all" ? "is-active" : ""}" type="button" data-action="set-module" data-module="all">全部</button>
              ${DATA.modules.map((module) => `<button class="module-tab ${runtime.knowledge.module === module.name ? "is-active" : ""}" type="button" data-action="set-module" data-module="${escapeHtml(module.name)}">${escapeHtml(compactChapter(module.name))}</button>`).join("")}
            </div>
            <div class="point-list" id="knowledge-point-list">${knowledgeIndexHtml()}</div>
          </aside>
        </div>
      </section>`;
  }

  function rateKnowledge(rating) {
    const point = currentKnowledgePoint();
    if (!point) return;
    applyReview(point.id, rating, true);
    const points = orderedKnowledgePoints(knowledgeFiltered());
    const index = points.findIndex((item) => item.id === point.id);
    runtime.knowledge.currentId = points[(index + 1) % points.length]?.id || point.id;
    runtime.knowledge.revealed = false;
    render();
  }

  function wrongQuestions() {
    let ids = allWrongIds();
    if (runtime.wrongMode === "mine") ids = state.wrong;
    if (runtime.wrongMode === "history") ids = historicalWrongIds();
    return [...new Set(ids)].map((id) => questionMap.get(id)).filter(Boolean);
  }

  function renderWrong() {
    const questions = wrongQuestions();
    root.innerHTML = `
      <section class="view-section">
        <header class="section-head">
          <div class="section-title-wrap"><h1 class="section-title">错题本</h1><p class="section-subtitle">我的答错记录与平台历史错题统一归档</p></div>
          ${questions.length ? '<button class="primary-button" type="button" data-action="start-wrong"><i data-lucide="refresh-ccw"></i>开始重练</button>' : ""}
        </header>
        <div class="metric-strip">
          <div class="metric-block"><strong>${allWrongIds().length}</strong><span>全部错题</span></div>
          <div class="metric-block"><strong>${state.wrong.length}</strong><span>我的错题</span></div>
          <div class="metric-block"><strong>${historicalWrongIds().length}</strong><span>平台历史错题</span></div>
          <div class="metric-block"><strong>${DATA.questions.filter((question) => question.platformSuspect).length}</strong><span>平台疑点</span></div>
        </div>
        <div class="segmented" style="margin-bottom:12px">
          ${[
            ["all", "全部"],
            ["mine", "我的错题"],
            ["history", "平台历史"],
          ]
            .map(([mode, label]) => `<button class="segment-button ${runtime.wrongMode === mode ? "is-active" : ""}" type="button" data-action="set-wrong-mode" data-mode="${mode}">${label}</button>`)
            .join("")}
        </div>
        ${
          questions.length
            ? questionListHtml(questions, questions.length)
            : '<div class="empty-state"><div class="empty-icon"><i data-lucide="badge-check"></i></div><h2>当前没有错题</h2><p>答错或标记“忘记”的题目会自动进入这里。</p></div>'
        }
      </section>`;
  }

  function lastDays(count) {
    const days = [];
    for (let offset = count - 1; offset >= 0; offset -= 1) {
      const date = new Date();
      date.setDate(date.getDate() - offset);
      days.push({ key: dateKey(date), label: `${date.getMonth() + 1}/${date.getDate()}` });
    }
    return days;
  }

  function streakDays() {
    let streak = 0;
    const date = new Date();
    if (!(state.history[dateKey(date)] || 0)) date.setDate(date.getDate() - 1);
    while (state.history[dateKey(date)] > 0) {
      streak += 1;
      date.setDate(date.getDate() - 1);
    }
    return streak;
  }

  function renderStats() {
    const reviews = Object.values(state.reviews);
    const attempts = reviews.reduce((sum, review) => sum + (review.attempts || 0), 0);
    const mastered = totalMastered();
    const days = lastDays(7);
    const maxHistory = Math.max(1, ...days.map((day) => state.history[day.key] || 0));
    const chapterRows = chapterNames.map((chapter) => {
      const questions = DATA.questions.filter((question) => question.chapter === chapter);
      const chapterMastered = questions.filter((question) => (reviewOf(question.id)?.level || 0) >= 3).length;
      return { chapter, total: questions.length, mastered: chapterMastered };
    });
    root.innerHTML = `
      <section class="view-section">
        <header class="section-head"><div class="section-title-wrap"><h1 class="section-title">学习统计</h1><p class="section-subtitle">本机浏览器中的学习记录</p></div></header>
        <div class="metric-strip">
          <div class="metric-block"><strong>${attempts}</strong><span>累计复习</span></div>
          <div class="metric-block"><strong>${mastered}</strong><span>已掌握题目</span></div>
          <div class="metric-block"><strong>${state.wrong.length}</strong><span>当前错题</span></div>
          <div class="metric-block"><strong>${streakDays()}</strong><span>连续学习天数</span></div>
        </div>
        <div class="stats-grid">
          <div class="panel">
            <h2 class="panel-title">近7天完成量</h2>
            <div class="bar-chart">
              ${days
                .map((day) => {
                  const value = state.history[day.key] || 0;
                  const height = Math.max(2, Math.round((value / maxHistory) * 100));
                  return `<div class="bar-column"><div class="bar-column-track"><span class="bar-column-value">${value}</span><i class="bar-column-fill" style="height:${height}%"></i></div><span class="bar-column-label">${day.label}</span></div>`;
                })
                .join("")}
            </div>
          </div>
          <div class="panel">
            <h2 class="panel-title">学习设置</h2>
            <div class="settings-list">
              <div class="settings-row">
                <div class="settings-copy"><strong>每日题量</strong><small>用于生成今日题组</small></div>
                <div class="segmented">${[10, 20, 30, 50].map((goal) => `<button class="segment-button ${state.dailyGoal === goal ? "is-active" : ""}" type="button" data-action="set-goal" data-goal="${goal}">${goal}</button>`).join("")}</div>
              </div>
              <div class="settings-row">
                <div class="settings-copy"><strong>清空学习记录</strong><small>题库内容不会删除</small></div>
                <button class="danger-button" type="button" data-action="reset-progress"><i data-lucide="trash-2"></i>清空</button>
              </div>
            </div>
          </div>
          <div class="panel" style="grid-column:1/-1">
            <h2 class="panel-title">章节掌握度</h2>
            <div class="chapter-progress-list">
              ${chapterRows
                .map((row) => {
                  const percent = row.total ? Math.round((row.mastered / row.total) * 100) : 0;
                  return `<div class="chapter-progress-row"><span>${escapeHtml(shortChapter(row.chapter))}</span><div class="chapter-track"><i style="width:${percent}%"></i></div><strong>${percent}%</strong></div>`;
                })
                .join("")}
            </div>
          </div>
        </div>
      </section>`;
  }

  function resetProgress() {
    const confirmed = window.confirm("清空全部学习进度、错题和收藏记录？");
    if (!confirmed) return;
    state = structuredClone(defaultState);
    saveState();
    runtime.queue = [];
    runtime.index = 0;
    runtime.knowledge.currentId = null;
    showToast("学习记录已清空");
    createSession("mixed");
    setView("stats");
  }

  document.querySelectorAll(".nav-item").forEach((button) => {
    button.addEventListener("click", () => setView(button.dataset.view));
  });

  document.getElementById("new-session-button").addEventListener("click", () => {
    createSession(runtime.queueMode);
    setView("study");
    showToast("已生成新的题组");
  });

  root.addEventListener("click", (event) => {
    const target = event.target.closest("[data-action]");
    if (!target) return;
    const action = target.dataset.action;
    if (action === "reveal-answer") revealAnswer();
    if (action === "rate-question") rateCurrentQuestion(Number(target.dataset.rating));
    if (action === "skip-question") skipQuestion();
    if (action === "queue-jump") skipQuestion(Number(target.dataset.offset));
    if (action === "toggle-favorite") toggleFavorite(target.dataset.id);
    if (action === "restart-session") createSession(runtime.queueMode);
    if (action === "set-session-mode") createSession(target.dataset.mode);
    if (action === "open-question") openQuestionModal(target.dataset.id);
    if (action === "load-more") {
      runtime.bank.limit += 60;
      updateBankResults();
    }
    if (action === "start-filtered") {
      const ids = filteredBankQuestions().map((question) => question.id);
      if (!ids.length) showToast("当前没有可练习题目");
      else {
        createSession("custom", ids);
        setView("study");
      }
    }
    if (action === "reveal-knowledge") {
      runtime.knowledge.revealed = true;
      render();
    }
    if (action === "rate-knowledge") rateKnowledge(Number(target.dataset.rating));
    if (action === "select-knowledge") {
      runtime.knowledge.currentId = target.dataset.id;
      runtime.knowledge.revealed = false;
      render();
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
    if (action === "set-module") {
      runtime.knowledge.module = target.dataset.module;
      runtime.knowledge.currentId = null;
      runtime.knowledge.revealed = false;
      render();
    }
    if (action === "open-knowledge") {
      const point = knowledgeMap.get(target.dataset.id);
      if (point) {
        runtime.knowledge.module = point.module;
        runtime.knowledge.currentId = point.id;
        runtime.knowledge.revealed = false;
        setView("knowledge");
      }
    }
    if (action === "start-wrong") {
      const ids = wrongQuestions().map((question) => question.id);
      createSession("custom", ids);
      setView("study");
    }
    if (action === "set-wrong-mode") {
      runtime.wrongMode = target.dataset.mode;
      render();
    }
    if (action === "set-goal") {
      state.dailyGoal = Number(target.dataset.goal);
      saveState();
      showToast(`每日题量已设为 ${state.dailyGoal}`);
      render();
    }
    if (action === "reset-progress") resetProgress();
  });

  root.addEventListener("change", (event) => {
    if (event.target.matches(".option-input")) {
      const question = currentQuestion();
      if (!question || runtime.revealed) return;
      const multiple = question.type.includes("多选") || question.correctLabels.length > 1;
      selectOptions(runtime.selected, event.target.value, multiple);
      render();
    }
    if (event.target.matches("[data-filter]")) {
      runtime.bank[event.target.dataset.filter] = event.target.value;
      runtime.bank.limit = 60;
      updateBankResults();
    }
  });

  root.addEventListener("input", (event) => {
    if (event.target.matches("[data-role='draft']")) {
      const question = currentQuestion();
      if (question) runtime.drafts[question.id] = event.target.value;
    }
    if (event.target.id === "bank-search") {
      runtime.bank.search = event.target.value;
      runtime.bank.limit = 60;
      updateBankResults();
    }
    if (event.target.id === "knowledge-search") {
      runtime.knowledge.search = event.target.value;
      const container = document.getElementById("knowledge-point-list");
      if (container) container.innerHTML = knowledgeIndexHtml();
    }
  });

  modalRoot.addEventListener("click", (event) => {
    const target = event.target.closest("[data-action]");
    if (!target) return;
    if (target.dataset.action === "close-modal" && (target === event.target || target.closest(".icon-button"))) closeModal();
    if (target.dataset.action === "practice-question") {
      const id = target.dataset.id;
      closeModal();
      createSession("custom", [id]);
      setView("study");
    }
    if (target.dataset.action === "toggle-modal-favorite") {
      const id = target.dataset.id;
      if (state.favorites.includes(id)) state.favorites = state.favorites.filter((item) => item !== id);
      else state.favorites.push(id);
      saveState();
      openQuestionModal(id);
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && modalRoot.innerHTML) closeModal();
    if (runtime.view !== "study" || modalRoot.innerHTML) return;
    if (runtime.revealed && ["1", "2", "3"].includes(event.key)) {
      rateCurrentQuestion(Number(event.key) - 1);
    }
    if (!runtime.revealed && event.key === "Enter" && !event.target.matches("textarea")) revealAnswer();
  });

  createSession("mixed");

  if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  }
})();
