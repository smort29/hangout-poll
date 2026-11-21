// Pure rules for changing a poll. No Firebase or page code here, so they're easy to test.
//
// Poll shape (one Firestore document per poll):
//   { title, createdAt, dates: [isoString], activities: [{ name, by }], votes: [vote] }
//   vote = { name, ranking: [activityIndex, ...favorite first], dates: [dateIndex] }
//   `by` is the voter who suggested the activity, or null if the organizer added it.

export class UserError extends Error {}

export const sameText = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase();

export function findActivity(poll, name) {
  return poll.activities.findIndex((activity) => sameText(activity.name, name));
}

// Adds a vote. `rankedNames` is the voter's order, favorite first; names not yet
// in the poll become new suggestions credited to the voter.
export function addVote(poll, { name, rankedNames, dates }) {
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
  const validDates = [...new Set(dates)].filter((i) => i >= 0 && i < poll.dates.length);
  poll.votes.push({ name, ranking, dates: validDates });
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

export function dateAvailability(poll) {
  return poll.dates.map((date, index) => ({
    date,
    index,
    free: poll.votes.filter((v) => v.dates.includes(index)).map((v) => v.name),
    busy: poll.votes.filter((v) => !v.dates.includes(index)).map((v) => v.name),
  }));
}
