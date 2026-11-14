# Meal Planner – setup

Three steps, about 20 minutes in total, all free. Do them on a computer.

---

## Step 1 – Put the app online (GitHub Pages)

The iPhone needs the app on a secure (https) web address before it can use the camera and be added to the Home Screen.

1. Create a free account at <https://github.com> (skip this if you already have one).
2. Click **+** (top right) → **New repository**.
   - Name: `meal-planner`
   - Visibility: **Public** (free GitHub Pages needs this; your recipes are *not* stored here, only the app's code).
   - Click **Create repository**.
3. On the new repository page click **uploading an existing file**.
4. Open this folder in File Explorer and drag in these items:
   `index.html`, `styles.css`, `manifest.webmanifest`, `sw.js`, `firebase-config.js`, and the **`js`** and **`icons`** folders.
   (You don't need `SETUP.md`, `firestore.rules` or the `.claude` folder.)
5. Click **Commit changes**.
6. Go to **Settings** → **Pages**. Under *Build and deployment* choose **Deploy from a branch**, branch **main**, folder **/ (root)**, then **Save**.
7. After a minute or two the page shows your address, for example
   `https://YOUR-USERNAME.github.io/meal-planner/`

At this point the app works on one phone. Do step 2 to share it with your household.

---

## Step 2 – Turn on household sharing (Firebase)

1. Go to <https://console.firebase.google.com> and sign in with a Google account.
2. **Create a project** → name it `meal-planner` → turn Google Analytics **off** → **Create project**.
3. **Turn on sign-in:** left menu **Build → Authentication** → **Get started** → **Sign-in method** tab → **Anonymous** → switch on **Enable** → **Save**.
   (Nobody types a password: each phone gets a hidden anonymous ID, and the household code links them.)
4. **Create the database:** **Build → Firestore Database** → **Create database** → pick a location near you (e.g. `europe-west2 (London)`) → **Start in production mode** → **Create**.
5. **Set the security rules:** in Firestore, open the **Rules** tab, delete what's there, paste the whole of `firestore.rules` from this folder, then click **Publish**.
6. **Get the app's settings:** click the ⚙️ gear → **Project settings** → scroll to *Your apps* → click the **`</>`** (Web) icon → nickname `meal-planner` → **Register app**. Firebase shows a block like:
   ```js
   const firebaseConfig = {
     apiKey: "AIza...",
     authDomain: "meal-planner-xxxx.firebaseapp.com",
     projectId: "meal-planner-xxxx",
     ...
   };
   ```
7. Open `firebase-config.js` in this folder (Notepad is fine). Replace the line
   `export const firebaseConfig = null;`
   with the block from Firebase, changing the start from `const` to `export const`.
   (These values are meant to be public; your data is protected by the security rules.)
8. Open `sw.js` and change `meal-planner-v1` to `meal-planner-v2` so phones pick up the change. Do this every time you change any app file.
9. Upload the two changed files to GitHub: in your repository click **Add file → Upload files**, drag in `firebase-config.js` and `sw.js`, then **Commit changes**.

---

## Step 3 – Install on each iPhone

1. Open **Safari** (it must be Safari) and go to your GitHub Pages address.
2. Tap the **Share** button (square with an up arrow) → scroll down → **Add to Home Screen** → **Add**.
3. Open **Meals** from the Home Screen.
   - **First phone:** tap **Create a household**. You'll see a code like `PLUM-RIVER-4821` in Settings. Anything you'd already saved on that phone is copied in.
   - **Other phones:** tap **Join household** and type the code (or send it from Settings → *Send code to someone*).
4. The first time you scan, allow camera access when asked.

---

## Everyday use

| To… | Do this |
|---|---|
| Plan a meal | **Plan** tab → **+ Add** on a day → pick a recipe, or type something like "Takeaway" |
| Change which days/meals appear | **Settings** → tick or untick in *Meals to plan* |
| See other weeks | **‹ ›** arrows at the top of the Plan |
| Scan a recipe | **Recipes** → **+ New** → **📷 Take photo**. Scan extra pages the same way; each is added below. Check the text, fix any mistakes, then **Save**. |
| Shop for a recipe | Tap the recipe on the plan → tick the ingredients you **need** → **Add to shopping list** ("On list" shows what's already there) |
| Shop | **Shopping** tab → tick items as you put them in the trolley → **Clear ticked** when done |
| Add something by hand | Type it in the box at the top of Shopping, e.g. `2 lemons` |
| Change an item's shop section or amount | Tap the item name on the Shopping list |
| Send the list to someone | **⬆️** on the Shopping tab |
| Keep a copy of everything | **Settings → Save a backup file** |

**Scanning tips:** good light, phone flat above the page, the whole recipe in frame. Do the ingredients page and the method page as separate photos if they're far apart. The text reader runs on the phone (photos aren't uploaded); the first scan downloads it, which takes a few seconds.

**Offline:** the app opens without signal (handy in the supermarket). Ticks made offline sync when you're back online.
