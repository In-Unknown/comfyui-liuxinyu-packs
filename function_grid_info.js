// The same DOM-widget lifecycle used by text_preview.js keeps the trigger on the node.
let closeActive = null;
let nextId = 0;

function element(tag, className, text) {
  const value = document.createElement(tag);
  value.className = className;
  if (text) value.textContent = text;
  return value;
}

export function placeAnalysisCard(anchor, width, height, viewport, scale = 1) {
  const margin = 12, gap = 10 * scale;
  const displayWidth = width * scale, displayHeight = height * scale;
  const above = Math.max(0, anchor.top - margin - gap);
  const below = Math.max(0, viewport.height - anchor.bottom - margin - gap);
  const side = above >= displayHeight || above > below ? "above" : "below";
  const left = Math.max(margin, Math.min(anchor.left - 12 * scale, viewport.width - displayWidth - margin));
  const top = side === "above" ? anchor.top - gap - displayHeight : anchor.bottom + gap;
  return { side, left, top,
    arrow: Math.max(16, Math.min((anchor.left + anchor.width / 2 - left) / scale, width - 16)) };
}

export function createAnalysisInfo(node, app) {
  if (!document.getElementById("liuxinyu-function-info-style")) {
    const link = document.createElement("link");
    link.id = "liuxinyu-function-info-style"; link.rel = "stylesheet";
    link.href = new URL("./function_grid_info.css", import.meta.url).href;
    document.head.append(link);
  }
  const row = element("div", "lxy-function-info");
  const trigger = element("button", "lxy-function-info-trigger");
  trigger.type = "button"; trigger.title = "查看分析结果";
  trigger.setAttribute("aria-label", "查看函数分析结果");
  trigger.setAttribute("aria-expanded", "false");
  trigger.setAttribute("aria-haspopup", "dialog");
  const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  icon.setAttribute("class", "lxy-function-info-icon");
  icon.setAttribute("viewBox", "0 0 16 16");
  icon.setAttribute("aria-hidden", "true");
  icon.setAttribute("focusable", "false");
  // One scalable shape: no independent font metrics or bold glyph inside the circle.
  icon.innerHTML = '<circle cx="8" cy="8" r="7.25" fill="none" stroke="currentColor" stroke-width="1.5"/>'
    + '<path d="M8 7.2V11.4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>'
    + '<circle cx="8" cy="4.6" r=".8" fill="currentColor"/>';
  trigger.append(icon, element("span", "lxy-function-info-label", "分析"));
  const statusText = element("span", "lxy-function-info-status", "等待分析");
  row.append(trigger, statusText);
  row.addEventListener("pointerdown", event => event.stopPropagation());
  row.addEventListener("keydown", event => event.stopPropagation());
  const widget = node.addDOMWidget("liuxinyu_series_info", "custom", row, {
    hideOnZoom: false, margin: 0, getMinHeight: () => 32, getMaxHeight: () => 32,
    onDraw: current => { current.width = undefined; },
  });
  widget.serialize = false;
  node.widgets.splice(node.widgets.indexOf(widget), 1); node.widgets.unshift(widget);
  let card = null, body = null, frame = null, report = null, status = "等待解析表达式。";
  let closeButton = null, phase = "idle";
  const cardId = `lxy-function-analysis-${++nextId}`;
  trigger.setAttribute("aria-controls", cardId);

  function close(restoreFocus = false) {
    if (!card) return;
    cancelAnimationFrame(frame); frame = null;
    card.remove(); card = body = closeButton = null;
    trigger.setAttribute("aria-expanded", "false");
    document.removeEventListener("pointerdown", outside, true);
    document.removeEventListener("keydown", onEscape, true);
    if (closeActive === close) closeActive = null;
    if (restoreFocus) trigger.focus({ preventScroll: true });
  }
  function onEscape(event) {
    if (event.key !== "Escape") return;
    const restore = card.contains(document.activeElement);
    event.stopPropagation(); event.preventDefault(); close(restore);
  }
  function outside(event) {
    if (card.contains(event.target) || trigger.contains(event.target)) return;
    // Panning and dragging this node keep the analysis attached to its owner.
    if (event.target === app.canvas?.canvas) {
      if (event.button === 1 || event.button === 2) return;
      const point = app.canvas.convertEventToCanvasOffset(event);
      if (point[0] >= node.pos[0] && point[0] <= node.pos[0] + node.size[0]
          && point[1] >= node.pos[1] - 30 && point[1] <= node.pos[1] + node.size[1]) return;
    }
    close();
  }
  function track() {
    if (!card) return;
    const anchor = trigger.getBoundingClientRect();
    if (!trigger.isConnected || node.flags?.collapsed || node.graph !== app.canvas?.graph
        || anchor.width === 0 || anchor.height === 0 || anchor.bottom < 0 || anchor.top > window.innerHeight
        || anchor.right < 0 || anchor.left > window.innerWidth) { close(); return; }
    // The trigger already inherits ComfyUI's canvas transform. Measure its
    // rendered/layout ratio so the body-mounted card uses the same scale.
    const scale = trigger.offsetHeight > 0 ? anchor.height / trigger.offsetHeight : app.canvas?.ds?.scale || 1;
    const width = report?.series?.length ? 400 : 320;
    card.style.width = `${width}px`;
    card.style.maxHeight = "480px";
    card.style.transform = `scale(${scale})`;
    const height = Math.min(480, body.scrollHeight + 46);
    const position = placeAnalysisCard(anchor, width, height, { width: window.innerWidth, height: window.innerHeight }, scale);
    card.dataset.side = position.side;
    card.style.left = `${position.left}px`; card.style.top = `${position.top}px`;
    card.style.setProperty("--arrow-x", `${position.arrow}px`);
    frame = requestAnimationFrame(track);
  }
  function propertyList(parent, item, names) {
    const list = element("dl", "lxy-analysis-properties");
    for (const name of names) {
      if (name === "数值稳定性") continue;
      const value = item.properties?.[name];
      if (value) list.append(element("dt", "", name), element("dd", "", value));
    }
    if (list.children.length) parent.append(list);
  }
  function calculationList(parent, calculations) {
    const steps = element("ol", "lxy-analysis-calculations");
    for (const step of calculations) {
      const line = element("li", "");
      line.append(element("strong", "", `${step.operation} · ${step.status}`),
        element("code", "lxy-analysis-formula", `${step.expression}\n→ ${step.result}`));
      if (step.reason) line.append(element("p", "lxy-analysis-note", step.reason));
      steps.append(line);
    }
    parent.append(steps);
  }
  function numericalResults(parent, item, opened) {
    if (item.numerical_failure) parent.append(element("p", "lxy-analysis-note", `${item.numerical_failure.operation}：${item.numerical_failure.reason}`));
    const measurement = item.numerics;
    if (!measurement) return;
    const sample = measurement.sample;
    const details = element("details", "lxy-analysis-details");
    details.dataset.key = `${item.name}:实际数值诊断`;
    details.open = opened.has(details.dataset.key);
    details.append(element("summary", "", `数值诊断 · κ ≈ ${sample.condition || "计算受阻"}`));
    const context = Object.entries(sample.context || {}).map(([key, value]) => `${key}=${value}`).join("，");
    details.append(element("p", "lxy-analysis-meta", `N=${sample.N} · ${sample.algorithm} · ${sample.working_digits} 位工作精度`));
    if (measurement.invocations > 1) details.append(element("p", "lxy-analysis-meta", `${measurement.invocations} 次调用中条件数最大的一次：${context}`));
    if (measurement.range_risks) details.append(element("p", "lxy-analysis-meta", `全部调用的双精度范围风险：溢出 ${measurement.range_risks.overflow}，下溢 ${measurement.range_risks.underflow}，次正规数 ${measurement.range_risks.subnormal}`));
    if (sample.blocked) details.append(element("p", "lxy-analysis-note", `${sample.blocked.operation}：${sample.blocked.reason}`));
    const list = element("dl", "lxy-analysis-properties lxy-analysis-measurements");
    for (const [label, value] of [
      ["有限项和 S_N ≈", sample.sum], ["绝对值和 Σ|a_n| ≈", sample.sum_abs],
      ["求和条件数 κ ≈", sample.condition], ["条件数精确值", sample.condition_exact],
      ["消去敏感度 log₁₀κ ≈", sample.lost_digits == null ? "相对条件数无定义" : `${sample.lost_digits} 位`],
      ["求和舍入误差 ≈", sample.summation_roundoff], ["误差计算对象", sample.roundoff_scope],
      ["分量相对后向误差 η ≈", sample.backward_error], ["后向误差定义", sample.backward_error_formula],
      ["求和相对误差 ≈", sample.relative_roundoff ?? "和为零，使用绝对误差"],
      ["双精度转换误差 ≈", sample.output_conversion_error], ["双精度相对误差 ≈", sample.output_relative_error],
      ["双精度结果", sample.binary64_result_class],
      ["通项双精度溢出 / 下溢 / 次正规数", `${sample.binary64_term_overflow} / ${sample.binary64_term_underflow} / ${sample.binary64_term_subnormal}`],
    ]) if (value != null) list.append(element("dt", "", label), element("dd", "", value));
    details.append(element("code", "lxy-analysis-formula", "κ = Σ|a_n| / |S_N|"), list);
    if (sample.finite_observations) {
      const value = sample.finite_observations;
      const observations = element("dl", "lxy-analysis-properties lxy-analysis-measurements");
      for (const [label, content] of [
        ["范围与证据", `${value.scope}；${value.status}`],
        ["正项 / 负项 / 零项数", `${value.positive_terms} / ${value.negative_terms} / ${value.zero_terms}`],
        ["正项和", value.positive_sum], ["负项绝对值和", value.negative_magnitude],
        ["非零项变号次数 / 频率", `${value.sign_changes} / ${value.sign_change_frequency}`],
        ["已计算部分和单调性", value.monotonicity],
        ["部分和最小值 / 索引", `${value.partial_min} / ${value.min_index}`],
        ["部分和最大值 / 索引", `${value.partial_max} / ${value.max_index}`],
      ]) observations.append(element("dt", "", label), element("dd", "", content));
      details.append(element("strong", "", "有限项结构与极值"), observations);
    }
    if (sample.reference) {
      const reference = sample.reference;
      details.append(element("strong", "", `${reference.precision} 位参考重算`),
        element("code", "lxy-analysis-formula", `S_ref ≈ ${reference.value}\n|S − S_ref| ≈ ${reference.absolute_difference}\n相对差异 ≈ ${reference.relative_difference ?? "参照值为零，使用绝对差异"}`),
        element("p", "lxy-analysis-note", reference.kind));
    }
    if (sample.reference_failure) details.append(element("p", "lxy-analysis-note", `${sample.reference_failure.operation}：${sample.reference_failure.reason}`));
    if (sample.binary64_sequential_model) {
      const model = sample.binary64_sequential_model;
      details.append(element("strong", "", "对照模型：双精度顺序累加"),
        element("code", "lxy-analysis-formula", `u = ${model.u}\nk = ${model.k}\nγ_k = ku/(1−ku) ≈ ${model.gamma}\nγ_k Σ|a_n| ≈ ${model.absolute_bound}`),
        element("p", "lxy-analysis-note", model.assumptions));
    }
    if (sample.total_error) {
      const bound = sample.total_error;
      details.append(element("strong", "", "截断与数值误差合成"),
        element("code", "lxy-analysis-formula", `${bound.formula}\n= ${bound.terms.join(" + ")}\n≈ ${bound.display_approximation}`),
        element("p", "lxy-analysis-note", bound.scope), element("p", "lxy-analysis-note", bound.certificate));
    }
    parent.append(details);
  }
  function propertyAnalysis(parent, item, opened) {
    for (const entry of Object.values(item.analysis || {})) {
      const details = element("details", "lxy-analysis-details");
      details.dataset.key = `${item.name}:属性:${entry.title}`;
      details.open = opened.has(details.dataset.key);
      details.append(element("summary", "", `${entry.title} · ${entry.status}`),
        element("p", "lxy-analysis-conclusion", entry.classification),
        element("p", "lxy-analysis-meta", `对象：${entry.subject}`),
        element("p", "lxy-analysis-meta", `适用范围：${entry.domain}`));
      const quantities = element("dl", "lxy-analysis-properties lxy-analysis-measurements");
      for (const quantity of entry.quantities || []) quantities.append(element("dt", "", quantity.label), element("dd", "", quantity.value));
      details.append(quantities);
      const steps = element("ol", "lxy-analysis-calculations");
      for (const text of entry.steps || []) steps.append(element("li", "", text));
      details.append(steps); parent.append(details);
    }
  }
  function render() {
    if (!body) return;
    const scroll = body.scrollTop;
    const opened = new Set([...body.querySelectorAll("details[open]")].map(item => item.dataset.key));
    body.replaceChildren();
    if (!report) {
      const progress = element("div", "lxy-analysis-message");
      progress.append(element("strong", "", phase === "error" ? "暂未完成分析" : phase === "idle" ? "等待分析" : "正在分析"), element("p", "", status));
      if (phase === "error") progress.append(element("p", "lxy-analysis-note", "请检查公式；修改后会重新分析。"));
      progress.setAttribute("role", "status"); body.append(progress); return;
    }
    if (!report.series?.length) {
      const empty = element("div", "lxy-analysis-message");
      empty.append(element("strong", "", "普通表达式"), element("p", "", "没有求和项，按变量范围采样。"));
      body.append(empty); return;
    }
    if (!report.complete) body.append(element("p", "lxy-analysis-note", report.summary || status));
    for (const item of report.series) {
      const section = element("section", "lxy-analysis-series");
      const heading = element("div", "lxy-analysis-series-heading");
      const badge = element("span", "lxy-analysis-verdict", item.range_classification || item.convergence);
      badge.dataset.tone = item.convergence === "确定收敛" ? "success" : item.convergence === "确定发散" ? "danger" : "neutral";
      heading.append(element("strong", "", `求和 ${item.name}`), badge);
      section.append(heading, element("p", "lxy-analysis-meta", item.infinite ? `每轮计算 ${item.terms} 项` : "有限求和"));
      if (item.term) section.append(element("code", "lxy-analysis-formula", item.term));
      if (item.phases) {
        const stages = element("dl", "lxy-analysis-properties");
        const names = { running: "进行中", completed: "已完成", timeout: "达到时间预算", failed: "计算失败" };
        for (const stage of Object.values(item.phases)) {
          stages.append(element("dt", "", stage.label), element("dd", "", `${names[stage.state] || stage.state}${stage.seconds != null ? ` · ${stage.seconds} 秒` : ""}${stage.reason ? `；${stage.reason}` : ""}`));
        }
        section.append(stages);
      }
      if (item.incomplete) section.append(element("p", "lxy-analysis-note", item.incomplete));
      if (item.parameter_ranges) section.append(element("p", "lxy-analysis-meta", Object.entries(item.parameter_ranges).map(([key, value]) => `${key} ∈ ${value}`).join("；")));
      if (item.proof_scope || item.range_classification) section.append(element("p", "lxy-analysis-meta", item.proof_scope || item.range_classification));
      propertyList(section, item, ["证明状态", "误差界"]);
      if (item.calculations?.length) {
        const proof = element("details", "lxy-analysis-details");
        proof.dataset.key = `${item.name}:计算过程`; proof.open = opened.has(proof.dataset.key);
        proof.append(element("summary", "", `计算与证明过程 · ${item.calculations.length} 步`));
        calculationList(proof, item.calculations); section.append(proof);
      }
      numericalResults(section, item, opened);
      propertyAnalysis(section, item, opened);
      if (item.analysis_failure) section.append(element("p", "lxy-analysis-note", `推导停止位置：${item.analysis_failure.operation}；原因：${item.analysis_failure.reason}`));
      for (const [title, names] of [
        ["收敛与数值", ["收敛速度", "绝对收敛与条件收敛", "数值稳定性"]],
        ["通项与部分和", ["振荡性", "单调性", "有界性"]],
        ["函数与求和顺序", ["正则性与可微性", "求和顺序敏感性"]],
      ]) {
        const details = element("details", "lxy-analysis-details");
        details.dataset.key = `${item.name}:${title}`; details.open = opened.has(details.dataset.key);
        const remaining = names.filter(name => item.properties?.[name] && !item.analysis?.[name]);
        if (!remaining.length) continue;
        details.append(element("summary", "", title)); propertyList(details, item, remaining); section.append(details);
      }
      if (item.parameter_cases?.length) {
        const cases = element("details", "lxy-analysis-details");
        cases.dataset.key = `${item.name}:采样点证明`; cases.open = opened.has(cases.dataset.key);
        cases.append(element("summary", "", `采样点证明 · ${item.parameter_cases.length} 个点`));
        for (const entry of item.parameter_cases) {
          cases.append(element("p", "", `${Object.entries(entry.parameters).map(([key, value]) => `${key}=${value}`).join("，")}：${entry.convergence}`));
          if (entry.calculations?.length) calculationList(cases, entry.calculations);
          else if (entry.reason) cases.append(element("p", "lxy-analysis-note", entry.reason));
          propertyAnalysis(cases, { ...entry, name: `${item.name}:${JSON.stringify(entry.parameters)}` }, opened);
          if (entry.analysis_failure) cases.append(element("p", "lxy-analysis-note", `${entry.analysis_failure.operation}：${entry.analysis_failure.reason}`));
        }
        section.append(cases);
      }
      if (item.failure) section.append(element("p", "lxy-analysis-note", `停止步骤：${item.failure.operation}。原因：${item.failure.reason}`));
      if (item.gaps?.length) {
        const gaps = element("details", "lxy-analysis-details");
        gaps.dataset.key = `${item.name}:推导缺口`; gaps.open = opened.has(gaps.dataset.key);
        gaps.append(element("summary", "", `推导缺口 · ${item.gaps.map(gap => gap.attribute).join("、")}`));
        for (const gap of item.gaps) gaps.append(element("p", "lxy-analysis-note", `${gap.attribute}：${gap.reason}；输入 ${gap.input}`));
        section.append(gaps);
      }
      body.append(section);
    }
    body.append(element("p", "lxy-analysis-footnote", report.precision_note || "收敛证明与计算精度分别判断；截断误差不包含舍入误差。"));
    body.scrollTop = scroll;
  }
  function open() {
    if (card) { close(); return; }
    closeActive?.(); closeActive = close;
    card = element("div", "lxy-analysis-popover"); card.id = cardId;
    card.setAttribute("role", "dialog"); card.setAttribute("aria-modal", "false");
    card.setAttribute("aria-labelledby", `${cardId}-title`);
    const header = element("header", "lxy-analysis-header");
    const title = element("strong", "", "函数分析"); title.id = `${cardId}-title`;
    closeButton = element("button", "lxy-analysis-close", "×"); closeButton.type = "button";
    closeButton.setAttribute("aria-label", "关闭分析"); closeButton.title = "关闭（Esc）";
    closeButton.addEventListener("click", () => close(card.contains(document.activeElement)));
    header.append(title, closeButton);
    body = element("div", "lxy-analysis-body"); card.append(header, body);
    card.addEventListener("keydown", event => event.stopPropagation());
    card.addEventListener("wheel", event => event.stopPropagation());
    document.body.append(card); trigger.setAttribute("aria-expanded", "true"); render(); track();
    if (card) {
      document.addEventListener("pointerdown", outside, true);
      document.addEventListener("keydown", onEscape, true);
    }
  }
  trigger.addEventListener("click", open);
  trigger.addEventListener("keydown", event => {
    if (event.key === "ArrowDown") { event.preventDefault(); if (!card) open(); closeButton?.focus(); }
  });
  return {
    update(text, analysis) {
      status = text; report = analysis;
      phase = analysis ? "ready" : text.startsWith("分析未完成") ? "error" : text.includes("等待") ? "idle" : "busy";
      row.dataset.phase = phase;
      statusText.textContent = analysis ? !analysis.series?.length ? "普通表达式" : analysis.complete ? "分析完成" : "部分完成"
        : phase === "error" ? "分析未完成" : phase === "idle" ? "等待分析" : "分析中…";
      statusText.title = text; render();
    },
    destroy() { close(); },
  };
}
