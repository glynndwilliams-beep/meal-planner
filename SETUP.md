# Meal Planner – setup

Three steps, about 20 minutes in total, all free. Do them on a computer. (Steps 4 and 5 are extras you can do later.)

---

## Step 1 – Put the app online (GitHub Pages)

Phones need the app on a secure (https) web address before it can use the camera and be added to the home screen.

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

## Step 3 – Install on each phone (iPhone or Android)

iPhones and Android phones can share the same household and trips.

**iPhone**
1. Open **Safari** (it must be Safari) and go to your GitHub Pages address.
2. Tap the **Share** button (square with an up arrow) → scroll down → **Add to Home Screen** → **Add**.

**Android**
1. Open **Chrome** and go to your GitHub Pages address.
2. Tap **Install** if Chrome offers it, or tap the **⋮** menu (top right) → **Add to Home screen** (or **Install app**) → **Install**.
   (Inside the app, **Settings → Install** also has an install button when Chrome allows it.)

**Then, on either:**
1. Open **Meals** from the home screen.
   - **First phone:** tap **Create a household**. You'll see a code like `PLUM-RIVER-4821` in Settings. Anything you'd already saved on that phone is copied in.
   - **Other phones:** tap **Join household or trip** and type the code (or send it from Settings → *Send code to someone*).
2. The first time you scan, allow camera access when asked.

---

## Step 4 – Turn on trips with other families (once)

Trips let you share a trip plan and shopping list with other families for set dates. The database itself keeps them out of your household and locks them out after the trip, so the security rules need updating once:

1. Open <https://console.firebase.google.com> → your **meal-planner** project → **Build → Firestore Database** → **Rules** tab.
2. Delete what's there, paste the whole of the new `firestore.rules` from this folder, and click **Publish**. (Your household keeps working exactly as before.)

Until you do this, **Plan a trip** will say it couldn't create the trip.

**Using a trip**
- **Settings → 🏕️ Plan a trip**: name, dates, which meals, your family's name and how many of you.
- Under the **Trip** tab, tap **Send the code to the other families**. They open the app's address, tap **Join household or trip** and type the code. They don't need a household, and they only ever see the trip.
- Everyone can plan meals on the trip days, add and tick shopping items, and tap a meal or item to say **We'll cook it** / **We'll bring it**.
- To put one of your recipes on the trip, tap **+ Add** on a trip day and pick it under *Or one of your recipes*. Only a copy of that recipe (ingredients and method) is shared.
- **📅 Add ingredients for the trip's meals** (Shopping) builds the list, scaled to the number of people in all the families.
- After the last day the other families are locked out automatically. You can still open it from **Settings**, change the dates to reopen it, or delete it.
- **‹ Home** switches back to your own meal plan.

---

## Step 5 – Optional: your own recipe fetcher (more reliable web imports)

Out of the box, **Get recipe** goes through free public services that are sometimes down, and some sites (Allrecipes, Serious Eats) refuse them. Your own fetcher on Cloudflare fixes both. It's free (100,000 requests a day), needs no card, and takes about 10 minutes.

1. Go to <https://dash.cloudflare.com/sign-up> and create a free account (or sign in).
2. In the left menu choose **Compute (Workers)** → **Workers & Pages** (it may just say **Workers & Pages**) → **Create** → **Create Worker** (pick the **Hello World** starter if asked).
3. Name it `recipe-fetch` and click **Deploy**.
4. Click **Edit code**. Delete everything in the code box, paste the whole of `cloudflare/recipe-fetch.js` from this folder, then click **Deploy** (top right).
5. Copy the Worker's address, shown near the top, like `https://recipe-fetch.YOUR-NAME.workers.dev`.
6. In the app: **Settings → Recipes from websites** → paste the address → **Save**. It checks the address before saving, and every phone in your household uses it from then on.

The fetcher only answers your app's own web address, only fetches web pages and pictures, and stores nothing. If the app ever moves to a different web address, add it to the `ALLOWED_ORIGINS` list at the top of the code and deploy again.

---

## Everyday use

| To… | Do this |
|---|---|
| Plan a meal | **Plan** tab → **+ Add** on a day → pick a recipe, or type something like "Takeaway" |
| Change which days/meals appear | **Settings** → tick or untick in *Meals to plan* |
| See other weeks | **‹ ›** arrows at the top of the Plan |
| Scan a recipe | **Recipes** → **+ New** → **📷 Take photo**. Scan extra pages the same way; each is added below. Check the text, fix any mistakes, then **Save**. |
| Add a recipe from a website | On the recipe page tap **Share → Copy** (Safari) or **⋮ → Share → Copy** (Chrome on Android), or copy the address bar. Then **Recipes** → **+ New** → paste into the box at the top → **Get recipe**. Check it, then **Save**. Works with BBC Food, BBC Good Food and most recipe sites. |
| Add a recipe from the Share menu | **iPhone:** set up the *Add to Meals* Shortcut once (steps in **Settings → Recipes from websites**). It reads the recipe straight off the page, so it works even on sites that block fetching, like BBC. Then on a recipe in Safari tap **Share → Add to Meals**. It opens the app in Safari with the recipe filled in – tap **Save**. The first time, join your household there with your code, and tap **Always Allow** when it asks to run on a new site. **Android:** once the app is installed, tap **Share → Meals** on any recipe page. |
| Paste a copied link | **Recipes → + New → 📋 Paste link & get recipe**. |
| Cook from a recipe | Open it → **👩‍🍳 Start cooking**. Big steps, one at a time; the screen stays on. Tap a step to tick it off. At the end, rate it and add a note. |
| Cook for more or fewer people | **Settings → Cooking for** sets your usual number. On a recipe, **− / +** next to *Serves* changes it for that recipe; amounts and the shopping list follow. |
| Rate a recipe or add a note | Tap the stars on a recipe, or **✏️ Add a note**. **★ Favourites** on the Recipes tab shows 4–5 star recipes, and Suggest picks favourites more often. |
| Find a recipe | **Recipes** → type in the search box (name, ingredient or tag), or tap a tag under it. Add tags when editing a recipe; web recipes come with some. |
| Shop for a recipe | Tap the recipe on the plan → tick the ingredients you **need** → **Add to shopping list** ("On list" shows what's already there) |
| Shop for the whole week | **Shopping** → **📅 Add ingredients for planned meals**. Same items are added together. Untick anything you have, then **Add**. |
| Stop adding things you always have | **Settings → Always in the cupboard** (salt, oil…), or tap an item on the Shopping list → **We always have this**. |
| Shop | **Shopping** tab → tick items as you put them in the trolley → **Clear ticked** when done |
| Add something by hand | Type it in the box at the top of Shopping, e.g. `2 lemons` |
| Change an item's shop section or amount | Tap the item name on the Shopping list |
| Send the list to someone | **⬆️** on the Shopping tab |
| See what you eat and when | **History** tab – most eaten, habits by meal and day, and what you haven't had for a while. Past days on the plan count as eaten. |
| Get meal ideas | **✨ Suggest** (Plan or History tab) fills empty meals with recipes you haven't had for longest. ↻ swaps one, untick to skip, **Shuffle all** for a fresh set. |
| Control which meal a recipe is suggested for | Edit the recipe → **Good for** breakfast / lunch / dinner |
| Keep a copy of everything | **Settings → Save a backup file** |

**Android tip:** **Google Lens** (in the Google app or the camera) can copy text from a cookbook page – tap **Text**, select, **Copy**, then paste into the Ingredients or Method box.

**Scanning tips:** good light, phone flat above the page, the whole recipe in frame. Do the ingredients page and the method page as separate photos if they're far apart. The text reader runs on the phone (photos aren't uploaded); the first scan downloads it, which takes a few seconds.

**Offline:** the app opens without signal (handy in the supermarket). Ticks made offline sync when you're back online.
