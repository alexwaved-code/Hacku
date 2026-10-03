/* Stopwatch sheet for timing the same purchase by hand and through the assistant. Runs stay in this browser. */
const RUNS_KEY = "hacku.compare";
const ROUTES = ["manual", "agent"];
const WORDS = {
  zh: {
    title: "人手與助理實測",
    intro: "同一件商品，同一個碼錶。人手路線：自己搜尋、比價、到商店結帳。助理路線：在對話說一句話到收據出現。每做一個動作（打開頁面、點選、填一個欄位）按一次「+1 步」。價錢填你在頁面上看到的含運總價。",
    rule: "決策規則：含運總價較低的路線勝；總價相同時，用時較短的勝。",
    task: "要買的商品",
    taskHint: "例如 Sony SRS-XB100，送到香港",
    manual: "人手",
    agent: "助理",
    start: "開始計時",
    step: "+1 步",
    stop: "完成",
    reset: "重來",
    price: "看到的總價",
    store: "在哪家店",
    steps: (n) => `${n} 步`,
    seconds: (s) => `${s} 秒`,
    running: "計時中",
    save: "存成一筆對照",
    needBoth: "兩條路線都要完成，並填上總價，才能存。",
    saved: "已存好。",
    runs: "已存的對照",
    none: "還沒有對照。",
    export: "匯出 JSON",
    drop: "刪除",
    winner: (route) => `勝：${route}`,
    tie: "平手",
    from: "開始",
    to: "結束",
  },
  en: {
    title: "Manual vs assistant, measured",
    intro: "Same product, same stopwatch. Manual: search, compare, and check out on the store yourself. Assistant: one sentence in the chat until the receipt shows. Press “+1 step” for every action (open a page, click, fill a field). Enter the total with delivery that the page showed.",
    rule: "Decision rule: the route with the lower total including delivery wins; on a tie, the faster route wins.",
    task: "Product to buy",
    taskHint: "For example Sony SRS-XB100, delivered in Hong Kong",
    manual: "Manual",
    agent: "Assistant",
    start: "Start",
    step: "+1 step",
    stop: "Done",
    reset: "Reset",
    price: "Total seen",
    store: "Store",
    steps: (n) => `${n} step${n === 1 ? "" : "s"}`,
    seconds: (s) => `${s} s`,
    running: "Running",
    save: "Save this comparison",
    needBoth: "Finish both routes and enter both totals first.",
    saved: "Saved.",
    runs: "Saved comparisons",
    none: "No comparisons yet.",
    export: "Export JSON",
    drop: "Delete",
    winner: (route) => `Winner: ${route}`,
    tie: "Tie",
    from: "Start",
    to: "End",
  },
};
const root = document.querySelector("#compare-root");
const blank = () => ({ start: null, end: null, steps: 0, price: "", store: "" });

let task = "";
let currency = "HKD";
let draft = { manual: blank(), agent: blank() };
let notice = null;
let ticker = null;

function w(key, value) {
  const entry = WORDS[HackuText.get() === "en" ? "en" : "zh"][key];
  return typeof entry === "function" ? entry(value) : entry;
}

function runs() {
  try {
    const list = JSON.parse(localStorage.getItem(RUNS_KEY) || "[]");
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function seconds(route) {
  if (!route.start) return 0;
  const end = route.end ? new Date(route.end) : new Date();
  return Math.round((end - new Date(route.start)) / 100) / 10;
}

function winner(run) {
  const [manual, agent] = [run.manual, run.agent];
  if (manual.price !== agent.price) return manual.price < agent.price ? "manual" : "agent";
  if (manual.seconds !== agent.seconds) return manual.seconds < agent.seconds ? "manual" : "agent";
  return null;
}

function render() {
  HackuText.apply();
  document.title = `${w("title")} · Hack U Shop`;
  document.querySelector("#compare-title").textContent = w("title");
  root.replaceChildren();
  if (notice) root.append(el("p", `pay-notice ${notice.kind}`, notice.text));
  const head = el("section", "pay-card", el("p", "pay-hint", w("intro")), el("p", "pay-status ok", w("rule")));
  const taskInput = input(task, w("taskHint"), (value) => (task = value));
  const currencyInput = input(currency, "HKD", (value) => (currency = value.toUpperCase()));
  currencyInput.classList.add("cmp-currency");
  head.append(el("label", "cmp-field", w("task"), el("span", "cmp-row", taskInput, currencyInput)));
  root.append(head);

  const pair = el("div", "cmp-pair");
  for (const name of ROUTES) pair.append(routeCard(name));
  root.append(pair);

  const save = button("pay-sign", w("save"), saveRun);
  root.append(el("div", "pay-actions cmp-save", save));
  root.append(runsCard());
}

function routeCard(name) {
  const route = draft[name];
  const box = el("section", "pay-card cmp-route", el("h2", "", w(name)));
  const clock = el("p", "cmp-clock", w("seconds", seconds(route).toFixed(1)));
  clock.dataset.route = name;
  box.append(clock, el("p", "pay-hint", `${w("steps", route.steps)}${route.start && !route.end ? ` · ${w("running")}` : ""}`));
  const actions = el("div", "pay-actions");
  if (!route.start) {
    actions.append(
      button("pay-sign", w("start"), () => {
        route.start = new Date().toISOString();
        tick();
        render();
      })
    );
  } else if (!route.end) {
    actions.append(
      button("pay-sign", w("step"), () => {
        route.steps += 1;
        render();
      }),
      button("pay-pill", w("stop"), () => {
        route.end = new Date().toISOString();
        render();
      })
    );
  } else {
    actions.append(
      button("pay-pill", w("reset"), () => {
        draft[name] = blank();
        render();
      })
    );
  }
  box.append(actions);
  if (route.start) box.append(el("p", "pay-hint mono", `${w("from")} ${route.start}${route.end ? ` · ${w("to")} ${route.end}` : ""}`));
  const price = input(route.price, "0", (value) => (route.price = value));
  price.type = "number";
  price.min = "0";
  price.step = "any";
  box.append(
    el("label", "cmp-field", w("price"), price),
    el("label", "cmp-field", w("store"), input(route.store, "", (value) => (route.store = value)))
  );
  return box;
}

function runsCard() {
  const box = el("section", "pay-card", el("h2", "", w("runs")));
  const list = runs();
  if (!list.length) {
    box.append(el("p", "pay-hint", w("none")));
    return box;
  }
  const table = el("table", "cmp-table");
  const header = el("tr", "", el("th", "", w("task")));
  for (const name of ROUTES) header.append(el("th", "", w(name)));
  header.append(el("th", "", ""), el("th", "", ""));
  table.append(header);
  list.forEach((run, index) => {
    const row = el("tr", "", el("td", "", run.task));
    for (const name of ROUTES) {
      const route = run[name];
      row.append(
        el(
          "td",
          "",
          el("strong", "", HackuMoney.text(route.price, run.currency)),
          el("span", "cmp-sub", `${w("seconds", route.seconds)} · ${w("steps", route.steps)}${route.store ? ` · ${route.store}` : ""}`),
          el("span", "cmp-sub mono", `${route.start} → ${route.end}`)
        )
      );
    }
    const won = winner(run);
    row.append(
      el("td", "cmp-win", won ? w("winner", w(won)) : w("tie")),
      el(
        "td",
        "",
        button("pay-pill", w("drop"), () => {
          const next = runs();
          next.splice(index, 1);
          localStorage.setItem(RUNS_KEY, JSON.stringify(next));
          render();
        })
      )
    );
    table.append(row);
  });
  box.append(table, el("div", "pay-actions", button("pay-pill", w("export"), exportRuns)));
  return box;
}

function saveRun() {
  const done = ROUTES.every((name) => draft[name].end && draft[name].price !== "" && Number(draft[name].price) >= 0);
  if (!task.trim() || !done) {
    notice = { kind: "error", text: w("needBoth") };
    render();
    return;
  }
  const run = { task: task.trim(), currency: currency || "HKD", rule: WORDS.en.rule, saved_at: new Date().toISOString() };
  for (const name of ROUTES) {
    const route = draft[name];
    run[name] = {
      start: route.start,
      end: route.end,
      seconds: seconds(route),
      steps: route.steps,
      price: Number(route.price),
      store: route.store.trim(),
    };
  }
  localStorage.setItem(RUNS_KEY, JSON.stringify([...runs(), run]));
  draft = { manual: blank(), agent: blank() };
  notice = { kind: "ok", text: w("saved") };
  render();
}

function exportRuns() {
  const blob = new Blob([JSON.stringify(runs(), null, 2)], { type: "application/json" });
  const link = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: "compare.json" });
  link.click();
  URL.revokeObjectURL(link.href);
}

function tick() {
  if (ticker) return;
  ticker = setInterval(() => {
    const running = ROUTES.filter((name) => draft[name].start && !draft[name].end);
    if (!running.length) {
      clearInterval(ticker);
      ticker = null;
      return;
    }
    for (const name of running) {
      const clock = root.querySelector(`.cmp-clock[data-route="${name}"]`);
      if (clock) clock.textContent = w("seconds", seconds(draft[name]).toFixed(1));
    }
  }, 100);
}

function input(value, placeholder, onInput) {
  const node = el("input");
  node.value = value;
  node.placeholder = placeholder;
  node.addEventListener("input", () => onInput(node.value));
  return node;
}

function button(className, label, onClick) {
  const node = el("button", className, label);
  node.type = "button";
  node.addEventListener("click", onClick);
  return node;
}

function el(tag, className, ...children) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  for (const child of children) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : String(child));
  }
  return node;
}

document.querySelectorAll("[data-lang]").forEach((node) => {
  node.addEventListener("click", () => {
    HackuText.set(node.dataset.lang);
    render();
  });
});

render();
