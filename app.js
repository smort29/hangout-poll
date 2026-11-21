// Hangout Poll, milestone 3: polls are shared through Firebase, so friends can vote from
// their own devices and everyone sees results update live.

import { isConfigured, createPoll, watchPoll, submitVote, combineActivities } from "./store.js";
import { UserError, sameText, scoreActivities, dateAvailability } from "./poll-logic.js";

// ---------- Helpers ----------

const $ = (id) => document.getElementById(id);

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else node.setAttribute(key, value);
  }
  for (const child of children) node.append(child);
  return node;
}

function formatDate(value) {
  const date = new Date(value);
  if (isNaN(date)) return value;
  return date.toLocaleString(undefined, {
    weekday: "short", month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit",
  });
}

function showMessage(node, text) {
  node.textContent = text;
  node.hidden = !text;
}

function joinNames(names) {
  if (names.length <= 1) return names.join("");
  return names.slice(0, -1).join(", ") + " and " + names[names.length - 1];
}

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

// Turns a failed save into a message a person can act on.
function errorMessage(error) {
  if (error instanceof UserError) return error.message;
  if (error && error.code === "permission-denied") {
    return "The poll didn't accept this change. It may have reached its limit of 100 votes or 60 activities.";
  }
  if (!navigator.onLine) return "You're offline. Reconnect and try again.";
  return "Couldn't save. Check your connection and try again.";
}

// ---------- Polls opened on this device (a per-device convenience only) ----------

const RECENT_KEY = "hangoutRecentPolls";

function loadRecent() {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY)) || [];
  } catch {
    return [];
  }
}

function rememberPoll(id, title) {
  const recent = loadRecent().filter((p) => p.id !== id);
  recent.unshift({ id, title });
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(recent.slice(0, 20)));
  } catch {
    // Not saving the list is fine: it's only a shortcut.
  }
}

// ---------- Routing ----------

const VIEWS = ["home-view", "poll-view", "loading-view", "missing-view", "setup-view"];
let currentPoll = null;
let stopWatching = () => {};
let loadTimer = null;

function show(view) {
  for (const id of VIEWS) $(id).hidden = id !== view;
}

function route() {
  stopWatching();
  stopWatching = () => {};
  clearTimeout(loadTimer);
  currentPoll = null;

  if (!isConfigured) return show("setup-view");

  const match = location.hash.match(/^#poll-([A-Za-z0-9]+)$/);
  if (!match) {
    renderHome();
    return show("home-view");
  }

  const id = match[1];
  $("loading-text").textContent = "Loading poll…";
  show("loading-view");
  loadTimer = setTimeout(() => {
    $("loading-text").textContent = "Still loading. Check your connection, or refresh the page.";
  }, 10000);

  stopWatching = watchPoll(
    id,
    (poll) => {
      clearTimeout(loadTimer);
      if (!poll) {
        $("missing-heading").textContent = "Poll not found";
        $("missing-text").textContent = "Check that you have the whole link. If it's right, the poll may have been removed.";
        return show("missing-view");
      }
      const firstLoad = !currentPoll || currentPoll.id !== poll.id;
      currentPoll = poll;
      rememberPoll(poll.id, poll.title);
      if (firstLoad) {
        renderPoll(poll);
        show("poll-view");
      } else {
        refreshPoll(poll);
      }
    },
    () => {
      clearTimeout(loadTimer);
      $("missing-heading").textContent = "Couldn't load this poll";
      $("missing-text").textContent = "Check your connection and refresh the page.";
      show("missing-view");
    }
  );
}

// ---------- Home: create poll ----------

function addInputRow(container, type, placeholder) {
  const input = el("input", { type, placeholder });
  if (type === "text") input.maxLength = 60;
  const remove = el("button", { type: "button", class: "remove-btn", "aria-label": "Remove", text: "×" });
  const row = el("div", { class: "input-row" }, input, remove);
  remove.addEventListener("click", () => row.remove());
  container.append(row);
}

function resetCreateForm() {
  $("poll-title").value = "";
  $("date-inputs").innerHTML = "";
  $("activity-inputs").innerHTML = "";
  for (let i = 0; i < 2; i++) addInputRow($("date-inputs"), "datetime-local");
  for (let i = 0; i < 2; i++) addInputRow($("activity-inputs"), "text", "e.g. Bowling");
  showMessage($("create-error"), "");
  $("create-submit").disabled = false;
}

function collectValues(container) {
  const values = [];
  for (const input of container.querySelectorAll("input")) {
    const value = input.value.trim();
    if (value && !values.some((v) => sameText(v, value))) values.push(value);
  }
  return values;
}

function renderHome() {
  resetCreateForm();
  const recent = loadRecent();
  const list = $("poll-list");
  list.innerHTML = "";
  for (const poll of recent) {
    list.append(el("li", {}, el("a", { href: `#poll-${poll.id}`, text: poll.title })));
  }
  $("poll-list-card").hidden = recent.length === 0;
}

$("add-date").addEventListener("click", () => addInputRow($("date-inputs"), "datetime-local"));
$("add-activity").addEventListener("click", () => addInputRow($("activity-inputs"), "text", "e.g. Bowling"));

$("create-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const title = $("poll-title").value.trim();
  const dates = collectValues($("date-inputs"));
  const activities = collectValues($("activity-inputs"));

  let error = "";
  if (!title) error = "Please give your poll a title.";
  else if (dates.length === 0) error = "Please add at least one date/time option.";
  if (error) return showMessage($("create-error"), error);

  showMessage($("create-error"), "");
  $("create-submit").disabled = true;
  $("create-submit").textContent = "Creating…";
  try {
    const id = await createPoll({ title, dates: dates.sort(), activities });
    rememberPoll(id, title);
    location.hash = `poll-${id}`;
  } catch (err) {
    showMessage($("create-error"), errorMessage(err));
    $("create-submit").disabled = false;
  } finally {
    $("create-submit").textContent = "Create poll";
  }
});

// ---------- Poll: vote form ----------

// The voter's ranking while they fill in the form, favorite first.
// Each item is { name, isNew } where isNew marks the voter's own suggestion not yet in the poll.
let draftRanking = [];

function renderRanking(focusName, focusAction) {
  const list = $("ranking-list");
  list.innerHTML = "";
  $("ranking-empty").hidden = draftRanking.length > 0;

  draftRanking.forEach((item, position) => {
    const up = el("button", { type: "button", class: "icon-btn", "aria-label": `Move ${item.name} up`, text: "↑" });
    const down = el("button", { type: "button", class: "icon-btn", "aria-label": `Move ${item.name} down`, text: "↓" });
    up.disabled = position === 0;
    down.disabled = position === draftRanking.length - 1;
    up.addEventListener("click", () => moveItem(position, -1));
    down.addEventListener("click", () => moveItem(position, 1));

    const label = el("span", { class: "rank-name", text: item.name });
    if (item.isNew) label.append(el("span", { class: "tag", text: "your idea" }));

    const controls = el("div", { class: "rank-controls" }, up, down);
    if (item.isNew) {
      const remove = el("button", { type: "button", class: "icon-btn", "aria-label": `Remove ${item.name}`, text: "×" });
      remove.addEventListener("click", () => {
        draftRanking.splice(position, 1);
        renderRanking();
      });
      controls.append(remove);
    }

    list.append(el("li", { class: "rank-item" },
      el("span", { class: "rank-pos", text: String(position + 1) }),
      label,
      controls
    ));

    if (item.name === focusName) {
      const target = focusAction === "up" && !up.disabled ? up : !down.disabled ? down : up;
      target.focus();
    }
  });
}

function moveItem(position, step) {
  const target = position + step;
  if (target < 0 || target >= draftRanking.length) return;
  const [item] = draftRanking.splice(position, 1);
  draftRanking.splice(target, 0, item);
  renderRanking(item.name, step < 0 ? "up" : "down");
}

// Keeps the voter's in-progress order when other people change the poll:
// new activities join at the bottom, combined-away ones drop out.
function syncDraft(poll) {
  const before = draftRanking.map((i) => `${i.name}|${i.isNew}`).join(",");
  const names = poll.activities.map((a) => a.name);
  const inPoll = (name) => names.some((n) => sameText(n, name));

  draftRanking = draftRanking.filter((item) => item.isNew || inPoll(item.name));
  for (const item of draftRanking) if (item.isNew && inPoll(item.name)) item.isNew = false;
  for (const name of names) {
    if (!draftRanking.some((item) => sameText(item.name, name))) draftRanking.push({ name, isNew: false });
  }

  const after = draftRanking.map((i) => `${i.name}|${i.isNew}`).join(",");
  if (before !== after) renderRanking();
}

function addSuggestion() {
  const input = $("suggestion");
  const name = input.value.trim();
  showMessage($("suggestion-error"), "");
  if (!name) return;
  if (draftRanking.some((item) => sameText(item.name, name))) {
    return showMessage($("suggestion-error"), `"${name}" is already on the list.`);
  }
  draftRanking.push({ name, isNew: true });
  input.value = "";
  renderRanking();
  input.focus();
}

$("add-suggestion").addEventListener("click", addSuggestion);
$("suggestion").addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    addSuggestion();
  }
});

function renderDateChoices(poll) {
  const container = $("date-choices");
  container.innerHTML = "";
  poll.dates.forEach((date, index) => {
    container.append(el("label", {},
      el("input", { type: "checkbox", name: "date", value: String(index) }),
      el("span", { text: formatDate(date) })
    ));
  });
}

function resetVoteForm(poll) {
  $("voter-name").value = "";
  $("suggestion").value = "";
  draftRanking = poll.activities.map((activity) => ({ name: activity.name, isNew: false }));
  renderRanking();
  for (const box of document.querySelectorAll('input[name="date"]')) box.checked = false;
  showMessage($("suggestion-error"), "");
  showMessage($("vote-error"), "");
}

// First time a poll is shown: build everything.
function renderPoll(poll) {
  $("poll-heading").textContent = poll.title;
  document.title = `${poll.title} · Hangout Poll`;
  renderDateChoices(poll);
  resetVoteForm(poll);
  showMessage($("vote-success"), "");
  showMessage($("merge-success"), "");
  $("vote-submit").disabled = false;
  renderResults(poll);
  renderMerge(poll, true);
}

// Someone (maybe this person) changed the poll: update without wiping the form.
function refreshPoll(poll) {
  syncDraft(poll);
  renderResults(poll);
  renderMerge(poll, false);
}

$("vote-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  showMessage($("vote-success"), "");
  if (!currentPoll) return;

  const name = $("voter-name").value.trim();
  if (!name) return showMessage($("vote-error"), "Please type your name.");
  if (currentPoll.votes.some((vote) => sameText(vote.name, name))) {
    return showMessage($("vote-error"), `"${name}" has already voted on this poll. Try a different name.`);
  }
  if ($("suggestion").value.trim()) {
    return showMessage($("vote-error"), "You typed an idea but didn't add it. Click Add, or clear the box.");
  }
  showMessage($("vote-error"), "");

  const button = $("vote-submit");
  button.disabled = true;
  button.textContent = "Saving…";
  try {
    await submitVote(currentPoll.id, {
      name,
      rankedNames: draftRanking.map((item) => item.name),
      dates: [...document.querySelectorAll('input[name="date"]:checked')].map((box) => Number(box.value)),
    });
    resetVoteForm(currentPoll);
    showMessage($("vote-success"), `Thanks, ${name}! Your vote is saved.`);
  } catch (err) {
    showMessage($("vote-error"), errorMessage(err));
  } finally {
    button.disabled = false;
    button.textContent = "Submit vote";
  }
});

// ---------- Poll: results ----------

function bar(fraction) {
  const node = el("div", { class: "tally-bar" }, el("span"));
  node.firstChild.style.width = `${Math.round(fraction * 100)}%`;
  return node;
}

function renderSummary(scores, availability, voters) {
  const topPoints = scores.length ? scores[0].points : 0;
  const topActivities = topPoints > 0 ? scores.filter((s) => s.points === topPoints) : [];
  const mostFree = Math.max(0, ...availability.map((d) => d.free.length));
  const bestDates = mostFree > 0 ? availability.filter((d) => d.free.length === mostFree) : [];

  $("top-activity").textContent = topActivities.length
    ? joinNames(topActivities.map((s) => s.name)) + (topActivities.length > 1 ? " (tied)" : "")
    : "No rankings yet";
  $("top-activity-note").textContent = topActivities.length ? plural(topPoints, "point") : "";

  $("best-date").textContent = bestDates.length
    ? joinNames(bestDates.map((d) => formatDate(d.date))) + (bestDates.length > 1 ? " (tied)" : "")
    : "No one is free yet";
  $("best-date-note").textContent = bestDates.length ? `${mostFree} of ${voters} free` : "";
  return bestDates.map((d) => d.index);
}

function renderActivityResults(scores, totalVoters) {
  const list = $("activity-results");
  list.innerHTML = "";
  const max = Math.max(1, ...scores.map((s) => s.points));
  scores.forEach((score, i) => {
    const notes = [];
    if (score.by) notes.push(`Suggested by ${score.by}`);
    if (score.rankedBy === 0) notes.push("No one has ranked this yet");
    else if (score.rankedBy < totalVoters) notes.push(`Ranked by ${score.rankedBy} of ${totalVoters}`);
    if (score.firsts.length) notes.push(`1st choice for ${joinNames(score.firsts)}`);

    list.append(el("li", { class: i === 0 && score.points > 0 ? "top" : "" },
      el("div", { class: "tally-row" },
        el("span", { class: "tally-label", text: score.name }),
        el("span", { class: "muted num", text: plural(score.points, "pt") })
      ),
      bar(score.points / max),
      el("div", { class: "muted small", text: notes.join(" · ") })
    ));
  });
}

function renderDateResults(availability, bestIndexes) {
  const list = $("date-results");
  list.innerHTML = "";
  for (const day of availability) {
    const total = day.free.length + day.busy.length;
    const heading = el("span", { class: "tally-label", text: formatDate(day.date) });
    const isBest = bestIndexes.includes(day.index);
    if (isBest) heading.append(el("span", { class: "tag", text: "best" }));

    list.append(el("li", { class: isBest ? "top" : "" },
      el("div", { class: "tally-row" },
        heading,
        el("span", { class: "muted num", text: `${day.free.length} of ${total} free` })
      ),
      bar(total ? day.free.length / total : 0),
      el("div", { class: "who" },
        el("span", { class: "free", text: "Free: " }),
        el("span", { text: day.free.length ? day.free.join(", ") : "no one" })
      ),
      el("div", { class: "who" },
        el("span", { class: "busy", text: "Can't make it: " }),
        el("span", { text: day.busy.length ? day.busy.join(", ") : "no one" })
      )
    ));
  }
}

function renderRankingsTable(poll) {
  const body = el("tbody");
  for (const vote of poll.votes) {
    const names = vote.ranking
      .filter((i) => poll.activities[i])
      .map((i, pos) => `${pos + 1}. ${poll.activities[i].name}`);
    body.append(el("tr", {},
      el("td", { text: vote.name }),
      el("td", { text: names.join("   ") || "Didn't rank anything" })
    ));
  }
  const table = $("rankings-table");
  table.innerHTML = "";
  table.append(el("thead", {}, el("tr", {}, el("th", { text: "Name" }), el("th", { text: "Ranking, favorite first" }))), body);
}

function renderResults(poll) {
  const hasVotes = poll.votes.length > 0;
  $("no-votes").hidden = hasVotes;
  $("results").hidden = !hasVotes;
  if (!hasVotes) return;

  const scores = scoreActivities(poll);
  const availability = dateAvailability(poll);
  const bestIndexes = renderSummary(scores, availability, poll.votes.length);
  renderActivityResults(scores, poll.votes.length);
  renderDateResults(availability, bestIndexes);
  renderRankingsTable(poll);
}

// ---------- Poll: combine two activities ----------

function fillMergeSelect(select, poll, fallbackIndex) {
  const previous = select.value;
  select.innerHTML = "";
  poll.activities.forEach((activity) => {
    select.append(el("option", { value: activity.name, text: activity.name }));
  });
  const keep = poll.activities.some((a) => a.name === previous);
  select.value = keep ? previous : poll.activities[fallbackIndex].name;
}

function hideMergeConfirm() {
  $("merge-confirm").hidden = true;
  $("merge-start").hidden = false;
}

function renderMerge(poll, reset) {
  const enough = poll.activities.length >= 2;
  $("merge-card").hidden = !enough;
  if (!enough) return;

  if (reset) {
    $("merge-from").value = "";
    $("merge-into").value = "";
    showMessage($("merge-error"), "");
  }
  const from = $("merge-from").value;
  const into = $("merge-into").value;
  fillMergeSelect($("merge-from"), poll, poll.activities.length - 1);
  fillMergeSelect($("merge-into"), poll, 0);
  // If someone else changed the chosen activities, close the confirm step.
  if (reset || $("merge-from").value !== from || $("merge-into").value !== into) hideMergeConfirm();
}

$("merge-from").addEventListener("change", hideMergeConfirm);
$("merge-into").addEventListener("change", hideMergeConfirm);
$("merge-cancel").addEventListener("click", hideMergeConfirm);

$("merge-form").addEventListener("submit", (event) => {
  event.preventDefault();
  showMessage($("merge-success"), "");
  const from = $("merge-from").value;
  const into = $("merge-into").value;
  if (from === into) return showMessage($("merge-error"), "Pick two different activities.");
  showMessage($("merge-error"), "");

  $("merge-confirm-text").textContent =
    `"${from}" will be removed and its votes will count for "${into}". This can't be undone.`;
  $("merge-confirm").hidden = false;
  $("merge-start").hidden = true;
  $("merge-yes").focus();
});

$("merge-yes").addEventListener("click", async () => {
  if (!currentPoll) return;
  const from = $("merge-from").value;
  const into = $("merge-into").value;
  const button = $("merge-yes");
  button.disabled = true;
  try {
    await combineActivities(currentPoll.id, from, into);
    hideMergeConfirm();
    showMessage($("merge-success"), `Combined "${from}" into "${into}".`);
  } catch (err) {
    hideMergeConfirm();
    showMessage($("merge-error"), errorMessage(err));
  } finally {
    button.disabled = false;
  }
});

// ---------- Start ----------

window.addEventListener("hashchange", route);
route();
