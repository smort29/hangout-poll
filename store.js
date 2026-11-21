// Shared storage: each poll is one document in the Firestore collection "polls".
// Every change runs in a transaction, so two friends voting at the same moment
// can't overwrite each other's votes or suggestions.

import { firebaseConfig } from "./firebase-config.js";
import { addVote, mergeActivities } from "./poll-logic.js";

const SDK = "https://www.gstatic.com/firebasejs/10.12.2/";

export const isConfigured =
  Boolean(firebaseConfig.projectId) && !firebaseConfig.projectId.startsWith("PASTE");

let firestore = null; // the Firestore SDK functions
let db = null;

async function connect() {
  if (db) return;
  const [{ initializeApp }, sdk] = await Promise.all([
    import(SDK + "firebase-app.js"),
    import(SDK + "firebase-firestore.js"),
  ]);
  firestore = sdk;
  db = sdk.getFirestore(initializeApp(firebaseConfig));
}

const pollRef = (id) => firestore.doc(db, "polls", id);

export async function createPoll({ title, dates, activities }) {
  await connect();
  const ref = firestore.doc(firestore.collection(db, "polls"));
  await firestore.setDoc(ref, {
    title,
    createdAt: Date.now(),
    dates,
    dateBy: dates.map(() => null),
    activities: activities.map((name) => ({ name, by: null })),
    votes: [],
  });
  return ref.id;
}

// Calls onData(poll) now and after every change, onData(null) if the poll doesn't exist,
// and onError(error) if it can't be loaded. Returns a function that stops watching.
export function watchPoll(id, onData, onError) {
  let stop = () => {};
  let stopped = false;
  connect()
    .then(() => {
      if (stopped) return;
      stop = firestore.onSnapshot(
        pollRef(id),
        (snap) => onData(snap.exists() ? { id, ...snap.data() } : null),
        onError
      );
    })
    .catch(onError);
  return () => {
    stopped = true;
    stop();
  };
}

async function change(id, update) {
  await connect();
  await firestore.runTransaction(db, async (tx) => {
    const snap = await tx.get(pollRef(id));
    if (!snap.exists()) throw new Error("This poll no longer exists.");
    const poll = update(snap.data());
    const changes = { activities: poll.activities, votes: poll.votes, dates: poll.dates };
    if (poll.dateBy) changes.dateBy = poll.dateBy;
    tx.update(pollRef(id), changes);
  });
}

export function submitVote(id, vote) {
  return change(id, (poll) => addVote(poll, vote));
}

export function combineActivities(id, fromName, intoName) {
  return change(id, (poll) => mergeActivities(poll, fromName, intoName));
}
