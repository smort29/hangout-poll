// Pure rules for changing a poll. No Firebase or page code here, so they're easy to test.
//
// Poll shape (one Firestore document per poll):
//   { title, createdAt, dates: [isoString], dateBy: [name|null], activities: [{ name, by }], votes: [vote] }
//   vote = { name, ranking: [activityIndex, ...favorite first], dates: [dateIndex], datesSeen }
//   `by` / `dateBy` name the voter who suggested an activity or date, or null if the organizer added it.
//   Dates are only ever appended, so indexes never change. `datesSeen` is how many dates existed
//   when the person voted: dates added later count as "hasn't answered", not "can't make it".

export class UserError extends Error {}

// Removes emoji so "🎳 Bowling" and "bowling" count as the same activity.
export const withoutEmoji = (text) =>
  text.replace(/[\p{Extended_Pictographic}\p{Regional_Indicator}‍️⃣]/gu, "").replace(/\s+/g, " ").trim();

export const sameText = (a, b) => withoutEmoji(a).toLowerCase() === withoutEmoji(b).toLowerCase();

export function findActivity(poll, name) {
  return poll.activities.findIndex((activity) => sameText(activity.name, name));
}

// Who added each date. Polls made before date suggestions existed have no `dateBy`.
export function dateSuggester(poll, index) {
  return (poll.dateBy && poll.dateBy[index]) || null;
}

// How many dates a vote was able to answer. Votes from before date suggestions existed
// saw only the organizer's dates.
export function datesSeen(poll, vote) {
  if (typeof vote.datesSeen === "number") return vote.datesSeen;
  return poll.dates.filter((_, i) => dateSuggester(poll, i) === null).length;
}

// Adds a vote. `rankedNames` is the voter's order, favorite first; names not yet
// in the poll become new suggestions credited to the voter. `freeDates` are the
// date/time values the voter can make; ones not yet in the poll are added as suggestions.
export function addVote(poll, { name, rankedNames, freeDates }) {
  if (poll.votes.some((vote) => sameText(vote.name, name))) {
    throw new UserError(`"${name}" has already voted on this poll. Try a different name.`);
  }
  const ranking = [];
  for (const activityName of rankedNames) {
    let index = findActivity(poll, activityName);
    if (index === -1) {
      poll.activities.push({ name: activityName.trim(), by: name });
      index = poll.activities.length - 1;
    }
    if (!ranking.includes(index)) ranking.push(index);
  }
  if (!poll.dateBy) poll.dateBy = poll.dates.map(() => null);
  const dates = [];
  for (const value of freeDates) {
    let index = poll.dates.indexOf(value);
    if (index === -1) {
      poll.dates.push(value);
      poll.dateBy.push(name);
      index = poll.dates.length - 1;
    }
    if (!dates.includes(index)) dates.push(index);
  }

  poll.votes.push({ name, ranking, dates, datesSeen: poll.dates.length });
  return poll;
}

// Folds one activity into another. A vote that ranked only the removed activity now
// ranks the kept one in that spot; a vote that ranked both keeps the higher spot.
export function mergeActivities(poll, fromName, intoName) {
  const fromIndex = findActivity(poll, fromName);
  const intoIndex = findActivity(poll, intoName);
  if (fromIndex === -1 || intoIndex === -1) {
    throw new UserError("Someone else just changed these activities. Check the list and try again.");
  }
  if (fromIndex === intoIndex) throw new UserError("Pick two different activities.");

  for (const vote of poll.votes) {
    const seen = new Set();
    vote.ranking = vote.ranking
      .map((i) => (i === fromIndex ? intoIndex : i))
      .filter((i) => (seen.has(i) ? false : seen.add(i)))
      .map((i) => (i > fromIndex ? i - 1 : i));
  }
  poll.activities.splice(fromIndex, 1);
  return poll;
}

// Each voter gives points by position: with n activities ranked, 1st place gets n points,
// 2nd gets n-1, ... last gets 1. Activities a voter didn't rank get 0 from them.
export function scoreActivities(poll) {
  const scores = poll.activities.map((activity, index) => ({
    ...activity, index, points: 0, rankedBy: 0, firsts: [],
  }));
  for (const vote of poll.votes) {
    const n = vote.ranking.length;
    vote.ranking.forEach((activityIndex, position) => {
      const score = scores[activityIndex];
      if (!score) return;
      score.points += n - position;
      score.rankedBy += 1;
      if (position === 0) score.firsts.push(vote.name);
    });
  }
  return scores.sort((a, b) =>
    b.points - a.points || b.firsts.length - a.firsts.length || a.index - b.index);
}

// Free / can't make it / hasn't answered for each date, earliest date first.
export function dateAvailability(poll) {
  return poll.dates
    .map((date, index) => {
      const free = [], busy = [], unanswered = [];
      for (const vote of poll.votes) {
        if (vote.dates.includes(index)) free.push(vote.name);
        else if (index < datesSeen(poll, vote)) busy.push(vote.name);
        else unanswered.push(vote.name);
      }
      return { date, index, by: dateSuggester(poll, index), free, busy, unanswered };
    })
    .sort((a, b) => a.date.localeCompare(b.date));
}
