# Setting up Hangout Poll

Two free accounts are needed: **Firebase** (saves the polls) and **Netlify** (puts the app online). Allow about 15 minutes.

## Part 1: Firebase (where polls are saved)

1. Go to <https://console.firebase.google.com> and sign in with a Google account.
2. Click **Create a project** (or **Add project**). Name it `hangout-poll`. You can turn off Google Analytics. Click through to finish.
3. Open the Firestore page. Firebase sometimes renames its menus, so use whichever of these works:
   - Go to <https://console.firebase.google.com/project/_/firestore> and pick your project if asked.
   - Or type **Firestore** (not "Firestone") in the search box at the top of the console.
   - Or look in the left menu under **Databases & Storage**, **Build**, **All products** or **Product categories** (click to expand).

   Then click **Create database**:
   - If asked for an edition, choose **Standard**.
   - Pick a location near you.
   - Choose **production mode** (not test mode), then finish.
4. Open the **Rules** tab, delete everything there, paste in the whole contents of `firestore.rules`, and click **Publish**.
5. Add a web app to the project. Use whichever of these works:
   - Go to <https://console.firebase.google.com/project/_/settings/general>, pick your project if asked, and scroll to the **bottom** of the **General** tab. Under **Your apps**, click the round **`</>`** (web) icon.
   - Or click **Project Overview** in the left menu and look for **+ Add app**, then choose **`</>`** / **Web**.
   - Or type **add app** in the search box at the top of the console.

   Then give it a nickname such as `hangout-poll-web`, leave "Firebase Hosting" unticked, and click **Register app**.
   - You'll see a block of code containing `const firebaseConfig = { ... }`. Copy the part between the curly braces.
6. Send those settings to Claude in the chat, or paste them into `firebase-config.js` yourself in place of the `PASTE_...` values.
   These settings are not secret. Every visitor's browser receives them. What people can do is limited by the rules from step 4.

## Part 2: Netlify (puts the app online)

7. Put these files together in one folder: `index.html`, `style.css`, `app.js`, `store.js`, `poll-logic.js`, `firebase-config.js`.
8. Go to <https://app.netlify.com/drop>, sign up for a free account, and drag the folder onto the page.
9. Netlify gives you an address like `https://something-random.netlify.app`. Open it on your laptop and your phone. That's your app.

To update the app later, open the site in Netlify, go to **Deploys**, and drag the updated folder onto it.

## Good to know

- Anyone who has a poll's link can vote, suggest ideas and combine activities. Only share links with your friends.
- Polls can't be deleted from the app. To remove one, open Firestore Database in the Firebase console and delete it there.
- Firebase's free plan allows far more reads and writes per day than a friend group will use.
