// Hangout Poll, milestone 3: polls are shared through Firebase, so friends can vote from
// their own devices and everyone sees results update live.

import { isConfigured, createPoll, watchPoll, submitVote, combineActivities } from "./store.js";
import { UserError, sameText, withoutEmoji, scoreActivities, dateAvailability } from "./poll-logic.js";

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

// Shows an error under a form, outlines the field in red, and moves the cursor to it.
function fieldError(input, messageNode, text) {
  showMessage(messageNode, text);
  if (!input) return;
  input.setAttribute("aria-invalid", "true");
  input.setAttribute("aria-describedby", messageNode.id);
  input.focus({ preventScroll: true });
  input.scrollIntoView({ block: "center", behavior: "smooth" });
}

// The red outline goes away as soon as the person changes the field.
document.addEventListener("input", (event) => {
  if (event.target.getAttribute && event.target.getAttribute("aria-invalid")) {
    event.target.removeAttribute("aria-invalid");
  }
});

// ---------- Sharing a poll's link ----------

let justCreatedId = null; // set right after this device creates a poll
let copyStatusTimer = null;

function pollLink(id) {
  return `${location.origin}${location.pathname}#poll-${id}`;
}

function renderShare(poll) {
  const created = justCreatedId === poll.id;
  justCreatedId = null;
  $("share-link").value = pollLink(poll.id);
  $("share-card").classList.toggle("just-created", created);
  $("share-intro").textContent = created
    ? "Poll created! Send this link to your friends so they can vote:"
    : "Share this poll with your friends:";
  $("native-share").hidden = typeof navigator.share !== "function";
  showMessage($("copy-status"), "");
}

function showCopyStatus(text) {
  clearTimeout(copyStatusTimer);
  showMessage($("copy-status"), text);
  copyStatusTimer = setTimeout(() => showMessage($("copy-status"), ""), 5000);
}

$("copy-link").addEventListener("click", async () => {
  const field = $("share-link");
  try {
    await navigator.clipboard.writeText(field.value);
    showCopyStatus("Link copied! Paste it into your group chat.");
  } catch {
    // Older browsers: select the text and try the old copy command.
    field.focus();
    field.select();
    const copied = document.execCommand && document.execCommand("copy");
    showCopyStatus(copied ? "Link copied! Paste it into your group chat." : "The link is selected. Press and hold it (or use Ctrl+C) to copy.");
  }
});

$("share-link").addEventListener("focus", (event) => event.target.select());

$("native-share").addEventListener("click", async () => {
  if (!currentPoll) return;
  try {
    await navigator.share({
      title: currentPoll.title,
      text: `Vote on "${currentPoll.title}" so we can pick what to do and when:`,
      url: pollLink(currentPoll.id),
    });
  } catch {
    // The person closed the share menu, or sharing isn't allowed here: nothing to do.
  }
});

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

// ---------- Emoji picker for activity names ----------

// Quick picks shown first. Every other standard emoji is in emoji-data.js, which loads
// the first time someone opens a picker so the app itself stays quick to load.
const POPULAR_EMOJI = [
  // Hearts and stars
  "❤️", "🧡", "💛", "💚", "💙", "💜", "🤎", "🖤", "🤍", "💖", "💕", "💝",
  "⭐", "🌟", "✨", "💫",
  // Celebrations
  "🎉", "🎊", "🥳", "🎈", "🎁", "🎂", "🍰", "🧁", "🍾", "🥂",
  // Dancing
  "💃", "🕺", "👯", "🪩",
  // Movies
  "🎬", "🎥", "📽️", "🎞️", "🎦", "🍿", "🎟️", "🎫", "📺",
  // Board and card games
  "🎲", "♟️", "🧩", "🃏", "🀄", "🎴",
  // Going out and activities
  "🎳", "🍕", "🍔", "🌮", "🍣", "🫛", "☕", "🍻", "🍷", "🎤", "🎮", "⛳",
  "🏖️", "🛍️", "🎨", "🎵", "🥾", "🧘",
  // Faces and gestures
  "😀", "😂", "😍", "😎", "🤩", "🗿", "👍", "🙌", "🙏", "🤝", "🔥", "💯",
];

// Some emoji come with or without an invisible "show as emoji" marker (U+FE0F); compare without it.
const bareEmoji = (emoji) => emoji.replace(/\uFE0F/g, "");
const POPULAR_SET = new Set(POPULAR_EMOJI.map(bareEmoji));

let emojiDataPromise = null;
function loadEmojiData() {
  if (!emojiDataPromise) {
    emojiDataPromise = import("./emoji-data.js")
      .then((module) => module.EMOJI_CATEGORIES)
      .catch((error) => {
        emojiDataPromise = null; // let the next open try again
        throw error;
      });
  }
  return emojiDataPromise;
}

// One emoji: a pictograph, flag letter, skin tone, joiner, variation selector, keycap or tag character.
const EMOJI_PART = "(?:[#*0-9]\\uFE0F?\\u20E3|[\\p{Extended_Pictographic}\\p{Regional_Indicator}\\p{Emoji_Modifier}\\u200D\\uFE0F\\u{E0020}-\\u{E007F}])";
const LEADING_EMOJI = new RegExp(`^(?:${EMOJI_PART}+\\s*)+`, "u");

function leadingEmoji(text) {
  const match = text.match(LEADING_EMOJI);
  return match ? match[0].trim() : "";
}

function setLeadingEmoji(input, emoji) {
  const rest = input.value.replace(LEADING_EMOJI, "");
  input.value = emoji ? `${emoji} ${rest}` : rest;
}

function emojiButton(emoji, title) {
  const option = el("button", { type: "button", class: "emoji-option", "data-emoji": emoji, text: emoji });
  option.setAttribute("aria-label", title || emoji);
  if (title) option.title = title;
  return option;
}

// Adds an emoji button in front of `input` (inside `row`). It opens a panel below the row with
// a search box, category shortcuts and every standard emoji.
function attachEmojiPicker(row, input) {
  const button = el("button", { type: "button", class: "emoji-btn", "aria-expanded": "false" });
  const search = el("input", { type: "search", class: "emoji-search", placeholder: "Search, e.g. cake, heart, christmas", "aria-label": "Search emoji" });
  const nav = el("div", { class: "emoji-nav", role: "group", "aria-label": "Jump to a category" });
  const list = el("div", { class: "emoji-list" });
  const status = el("p", { class: "muted small emoji-status" });
  const none = el("button", { type: "button", class: "emoji-none", text: "No emoji" });
  const panel = el("div", { class: "emoji-panel", role: "group", "aria-label": "Choose an emoji" }, search, nav, list, status, none);
  panel.hidden = true;
  status.hidden = true;

  let categories = null; // filled once emoji-data.js has loaded
  let built = false;

  const update = () => {
    const current = leadingEmoji(input.value);
    button.textContent = current || "☺";
    button.classList.toggle("empty", !current);
    button.setAttribute("aria-label", current ? `Change emoji (now ${current})` : "Add an emoji");
  };
  const close = () => {
    panel.hidden = true;
    button.setAttribute("aria-expanded", "false");
    if (search.value) {
      search.value = "";
      if (built) showAll();
    }
  };
  const choose = (emoji) => {
    setLeadingEmoji(input, emoji);
    update();
    close();
    input.focus();
  };

  function section(label, emojis) {
    const heading = el("span", { class: "emoji-heading", text: label });
    const grid = el("div", { class: "emoji-grid" });
    for (const [emoji, words] of emojis) grid.append(emojiButton(emoji, words));
    list.append(heading, grid);
    return heading;
  }

  function addNav(icon, label) {
    const jump = el("button", { type: "button", class: "emoji-nav-btn", "aria-label": label, title: label, text: icon });
    jump.addEventListener("click", () => {
      if (search.value) {
        search.value = "";
        showAll();
      }
      const heading = [...list.querySelectorAll(".emoji-heading")].find((h) => h.textContent === label);
      if (heading) list.scrollTop = heading.offsetTop;
    });
    nav.append(jump);
  }

  function showAll() {
    list.innerHTML = "";
    nav.innerHTML = "";
    status.hidden = true;
    const names = new Map();
    for (const category of categories || []) for (const [emoji, name] of category.items) names.set(bareEmoji(emoji), name);
    section("Popular", POPULAR_EMOJI.map((e) => [e, names.get(bareEmoji(e)) || ""]));
    addNav("⭐", "Popular");
    if (!categories) return;
    for (const category of categories) {
      section(category.label, category.items);
      addNav(category.icon, category.label);
    }
  }

  // Finds emoji whose name or keywords contain every search word (matching word starts).
  // Exact names come first, then popular emoji, then names containing the words, then keyword-only matches.
  function showSearch(query) {
    const q = query.toLowerCase().replace(/\s+/g, " ");
    const words = q.split(" ");
    const found = [];
    for (const category of categories || []) {
      for (const [emoji, name, tags] of category.items) {
        const nameText = " " + name;
        const allText = nameText + " " + tags;
        if (!words.every((w) => allText.includes(" " + w))) continue;
        const rank = name === q ? 0 : POPULAR_SET.has(bareEmoji(emoji)) ? 1 : words.every((w) => nameText.includes(" " + w)) ? 2 : 3;
        found.push({ rank, item: [emoji, name] });
      }
    }
    const matches = found.sort((a, b) => a.rank - b.rank).slice(0, 200).map((f) => f.item);
    list.innerHTML = "";
    status.hidden = matches.length > 0;
    status.textContent = `No emoji match "${query}". Try a shorter word.`;
    if (matches.length) section("Results", matches);
    list.scrollTop = 0;
  }

  async function build() {
    if (built) return;
    built = true;
    showAll();
    status.hidden = false;
    status.textContent = "Loading all emoji…";
    try {
      categories = await loadEmojiData();
      status.hidden = true;
      if (search.value.trim()) showSearch(search.value.trim());
      else showAll();
    } catch {
      built = false;
      status.textContent = "Couldn't load the full emoji list. The popular ones still work.";
    }
  }

  list.addEventListener("click", (event) => {
    const option = event.target.closest(".emoji-option");
    if (option) choose(option.dataset.emoji);
  });
  none.addEventListener("click", () => choose(""));
  search.addEventListener("input", () => {
    if (!categories) return; // still loading: build() runs the search when the list arrives
    const query = search.value.trim();
    if (query) showSearch(query);
    else showAll();
  });
  search.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      const first = list.querySelector(".emoji-option");
      if (first) choose(first.dataset.emoji);
    }
  });

  button.addEventListener("click", () => {
    const opening = panel.hidden;
    panel.hidden = !opening;
    button.setAttribute("aria-expanded", String(opening));
    if (opening) {
      build();
      search.focus();
    }
  });
  panel.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      close();
      button.focus();
    }
  });
  input.addEventListener("input", update);

  row.prepend(button);
  row.after(panel);
  update();
  return { update, close, panel };
}

// ---------- Home: create poll ----------

function addInputRow(container, type, placeholder) {
  const input = el("input", { type, placeholder });
  if (type === "text") input.maxLength = 60;
  const isDate = type === "datetime-local";
  const remove = el("button", {
    type: "button",
    class: isDate ? "remove-btn remove-date" : "remove-btn",
    "aria-label": isDate ? "Remove this date" : "Remove this activity",
    text: isDate ? "× Remove" : "×",
  });
  const row = el("div", { class: "input-row" }, input, remove);
  const wrap = el("div", { class: "input-wrap" }, row);
  container.append(wrap);
  if (type === "text") attachEmojiPicker(row, input);
  remove.addEventListener("click", () => wrap.remove());
}

function updateDescriptionCount() {
  const box = $("poll-description");
  $("description-count").textContent = `${box.value.length} / ${box.maxLength}`;
}

$("poll-description").addEventListener("input", updateDescriptionCount);

function resetCreateForm() {
  $("poll-title").value = "";
  $("poll-description").value = "";
  updateDescriptionCount();
  $("date-inputs").innerHTML = "";
  $("activity-inputs").innerHTML = "";
  for (let i = 0; i < 2; i++) addInputRow($("date-inputs"), "datetime-local");
  starterIdeas = shuffled(EXAMPLE_IDEAS);
  starterIndex = 0;
  for (let i = 0; i < 2; i++) addInputRow($("activity-inputs"), "text", nextStarterExample());
  showMessage($("create-error"), "");
  $("create-submit").disabled = false;
}

function collectValues(container) {
  const values = [];
  for (const input of container.querySelectorAll('input[type="text"], input[type="datetime-local"]')) {
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
$("add-activity").addEventListener("click", () => addInputRow($("activity-inputs"), "text", nextStarterExample()));

$("create-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const title = $("poll-title").value.trim();
  const description = $("poll-description").value.trim();
  const dates = collectValues($("date-inputs"));
  const activities = collectValues($("activity-inputs"));

  const errorBox = $("create-error");
  if (!title) return fieldError($("poll-title"), errorBox, "Give your poll a title, like \"Hangout this weekend\".");
  if (dates.length === 0) {
    return fieldError($("date-inputs").querySelector("input"), errorBox, "Add at least one date and time so friends can say when they're free.");
  }
  const emojiOnly = [...$("activity-inputs").querySelectorAll('input[type="text"]')]
    .find((input) => input.value.trim() && !withoutEmoji(input.value));
  if (emojiOnly) return fieldError(emojiOnly, errorBox, "Give each activity a name, not just an emoji.");

  showMessage(errorBox, "");
  $("create-submit").disabled = true;
  $("create-submit").textContent = "Creating…";
  try {
    const id = await createPoll({ title, description, dates: dates.sort(), activities });
    rememberPoll(id, title);
    justCreatedId = id;
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

const suggestionPicker = attachEmojiPicker($("suggestion-row"), $("suggestion"));

function addSuggestion() {
  const input = $("suggestion");
  const name = input.value.trim();
  const errorBox = $("suggestion-error");
  showMessage(errorBox, "");
  if (!name) return fieldError(input, errorBox, `Type an idea first, like "${exampleIdea}".`);
  if (!withoutEmoji(name)) return fieldError(input, errorBox, "Give your idea a name, not just an emoji.");
  const existing = draftRanking.find((item) => sameText(item.name, name));
  if (existing) return fieldError(input, errorBox, `"${existing.name}" is already on the list. Move it up instead.`);
  draftRanking.push({ name, isNew: true });
  input.value = "";
  suggestionPicker.update();
  suggestionPicker.close();
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

// The voter's date choices while they fill in the form.
// Each item is { date, checked, isNew } where isNew marks the voter's own suggested time.
let draftDates = [];

function renderDateChoices() {
  const container = $("date-choices");
  container.innerHTML = "";
  draftDates.sort((a, b) => a.date.localeCompare(b.date));
  for (const item of draftDates) {
    const box = el("input", { type: "checkbox", name: "date", value: item.date });
    box.checked = item.checked;
    box.addEventListener("change", () => { item.checked = box.checked; });

    const text = el("span", { class: "rank-name", text: formatDate(item.date) });
    if (item.isNew) text.append(el("span", { class: "tag", text: "your time" }));
    const label = el("label", {}, box, text);

    if (item.isNew) {
      const remove = el("button", { type: "button", class: "icon-btn", "aria-label": `Remove ${formatDate(item.date)}`, text: "×" });
      remove.addEventListener("click", (event) => {
        event.preventDefault();
        draftDates = draftDates.filter((d) => d !== item);
        renderDateChoices();
      });
      label.append(remove);
    }
    container.append(label);
  }
}

// Keeps the voter's ticks when other people suggest dates: new dates appear unticked.
function syncDraftDates(poll) {
  let changed = false;
  for (const item of draftDates) {
    if (item.isNew && poll.dates.includes(item.date)) {
      item.isNew = false;
      changed = true;
    }
  }
  for (const date of poll.dates) {
    if (!draftDates.some((d) => d.date === date)) {
      draftDates.push({ date, checked: false, isNew: false });
      changed = true;
    }
  }
  if (changed) renderDateChoices();
}

function addDateSuggestion() {
  const input = $("date-suggestion");
  const value = input.value;
  const errorBox = $("date-suggestion-error");
  showMessage(errorBox, "");
  if (!value) return fieldError(input, errorBox, "Pick a date and a time first.");
  if (draftDates.some((d) => d.date === value)) {
    return fieldError(input, errorBox, `${formatDate(value)} is already on the list. Tick it instead.`);
  }
  draftDates.push({ date: value, checked: true, isNew: true });
  input.value = "";
  renderDateChoices();
}

$("add-date-suggestion").addEventListener("click", addDateSuggestion);
$("date-suggestion").addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    addDateSuggestion();
  }
});

// Example text in the empty name and idea boxes, picked at random each time a poll opens.
const EXAMPLE_IDEAS = ["Swing Dancing", "Moon Knight", "Secret Hitler", "Bananagrams", "Tunnel Singing", "Foosball"];
const EXAMPLE_NAMES = ["Sarah", "Alex", "Tyler", "Ezra", "Henry", "Wilson", "Ariana", "Lexie", "Lia", "Hazel", "Benson", "Shgloopy"];
const pickOne = (list) => list[Math.floor(Math.random() * list.length)];
let exampleIdea = EXAMPLE_IDEAS[0];

function shuffled(list) {
  const copy = [...list];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

// Starter activity boxes on the create page each get a different example, in a shuffled order.
let starterIdeas = [];
let starterIndex = 0;
function nextStarterExample() {
  if (starterIndex >= starterIdeas.length) {
    starterIdeas = shuffled(EXAMPLE_IDEAS);
    starterIndex = 0;
  }
  return `e.g. ${starterIdeas[starterIndex++]}`;
}

function resetVoteForm(poll) {
  exampleIdea = pickOne(EXAMPLE_IDEAS);
  $("suggestion").placeholder = `e.g. ${exampleIdea}`;
  $("voter-name").placeholder = `e.g. ${pickOne(EXAMPLE_NAMES)}`;
  $("voter-name").value = "";
  $("suggestion").value = "";
  suggestionPicker.update();
  suggestionPicker.close();
  $("date-suggestion").value = "";
  draftRanking = poll.activities.map((activity) => ({ name: activity.name, isNew: false }));
  renderRanking();
  draftDates = poll.dates.map((date) => ({ date, checked: false, isNew: false }));
  renderDateChoices();
  showMessage($("suggestion-error"), "");
  showMessage($("date-suggestion-error"), "");
  showMessage($("vote-error"), "");
  for (const field of $("vote-form").querySelectorAll('[aria-invalid="true"]')) field.removeAttribute("aria-invalid");
}

// First time a poll is shown: build everything.
function renderPoll(poll) {
  $("poll-heading").textContent = poll.title;
  $("poll-description-text").textContent = poll.description || "";
  $("poll-description-text").hidden = !poll.description;
  document.title = `${poll.title} · Hangout Poll`;
  renderShare(poll);
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
  syncDraftDates(poll);
  renderResults(poll);
  renderMerge(poll, false);
}

$("vote-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  showMessage($("vote-success"), "");
  if (!currentPoll) return;

  const errorBox = $("vote-error");
  const name = $("voter-name").value.trim();
  if (!name) return fieldError($("voter-name"), errorBox, "Type your name so friends know whose vote this is.");
  if (!withoutEmoji(name)) return fieldError($("voter-name"), errorBox, "Type your name, not just an emoji.");
  const existing = currentPoll.votes.find((vote) => sameText(vote.name, name));
  if (existing) {
    return fieldError($("voter-name"), errorBox,
      `"${existing.name}" has already voted. If that's you, your vote is counted. If not, add a last initial, like "${existing.name} B".`);
  }
  if ($("suggestion").value.trim()) {
    return fieldError($("suggestion"), errorBox, "You typed an idea but didn't add it. Tap Add next to it, or clear the box.");
  }
  if ($("date-suggestion").value) {
    return fieldError($("date-suggestion"), errorBox, "You picked a time but didn't add it. Tap Add next to it, or clear it.");
  }
  showMessage(errorBox, "");

  const button = $("vote-submit");
  button.disabled = true;
  button.textContent = "Saving…";
  try {
    await submitVote(currentPoll.id, {
      name,
      rankedNames: draftRanking.map((item) => item.name),
      freeDates: draftDates.filter((item) => item.checked).map((item) => item.date),
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
    const total = day.free.length + day.busy.length + day.unanswered.length;
    const heading = el("span", { class: "tally-label", text: formatDate(day.date) });
    const isBest = bestIndexes.includes(day.index);
    if (isBest) heading.append(el("span", { class: "tag", text: "best" }));

    const item = el("li", { class: isBest ? "top" : "" },
      el("div", { class: "tally-row" },
        heading,
        el("span", { class: "muted num", text: `${day.free.length} of ${total} free` })
      ),
      bar(total ? day.free.length / total : 0)
    );
    if (day.by) item.append(el("div", { class: "muted small", text: `Suggested by ${day.by}` }));
    item.append(
      el("div", { class: "who" },
        el("span", { class: "free", text: "Free: " }),
        el("span", { text: day.free.length ? day.free.join(", ") : "no one" })
      ),
      el("div", { class: "who" },
        el("span", { class: "busy", text: "Can't make it: " }),
        el("span", { text: day.busy.length ? day.busy.join(", ") : "no one" })
      )
    );
    if (day.unanswered.length) {
      item.append(el("div", { class: "who" },
        el("span", { class: "busy", text: "Hasn't answered: " }),
        el("span", { text: day.unanswered.join(", ") })
      ));
    }
    list.append(item);
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
