# Instagram scripts

Clean up your Instagram from the browser using only your own **data export** and two **bookmarklets**. You don't need an API key, a password, or any third-party app.

| Script | What it does |
| --- | --- |
| `cancel-follow-requests.bookmarklet` | Withdraws every follow request you sent that's still pending |
| `unfollow-non-followers.bookmarklet` | Unfollows people who don't follow you back |

Both scripts work the same way. They open each profile in a small popup window, check the button, and click only when it's safe. Progress is saved in `localStorage`, so you can stop and resume any time.

> ☕ Did this save you hours of tapping? [**Sponsor me on GitHub**](https://github.com/sponsors/khemssharma) and I'll keep these scripts working when Instagram changes things.

> ⚠️ **Read this first.** Instagram's Terms of Use don't allow automated activity. Instagram also limits how many follow and unfollow actions an account can take in a short time. These scripts go slowly and stop on their own when Instagram pushes back, but running them is **at your own risk**. Use them only on your own account.

---

## 1. Get your data export

1. In Instagram, go to **Accounts Center → Your information and permissions → Download your information**.
2. Choose **Some of your information → Followers and following**.
3. Set **Format: HTML** and **Date range: All time**.

   Don't skip the date range. With the default *Last year*, older follows are missing, and the not-following-back list will be badly wrong. In our test, the one-year export flagged 576 accounts and the all-time export flagged 191.
4. Download the file and unzip it. The files you need are in `connections/followers_and_following/`:
   - `pending_follow_requests.html`
   - `following.html`
   - `followers_1.html`, plus `followers_2.html` and so on if you have many followers

## 2. Install a bookmarklet

1. Show the bookmarks bar with **Ctrl+Shift+B**.
2. Right-click it and choose **Add page…**
3. Give it any name. In **URL**, paste the **whole one-line contents** of the `.bookmarklet` file.

   Chrome sometimes removes `javascript:` from the start when you paste. If it does, type it back in.
4. Allow popups for instagram.com when Chrome asks.

---

## Cancel pending follow requests

**a) Copy the list.** Open `pending_follow_requests.html` in Chrome, press **F12**, open **Console**, and run:

```js
copy(JSON.stringify([...document.body.innerText.matchAll(/Username\s*\n?\s*(\S+)/g)].map(x => x[1])))
```

If Chrome blocks pasting into the console, type `allow pasting` and press Enter first.

**b) Run it.** Open instagram.com while logged in and click the **cancel-follow-requests** bookmarklet. Paste the list into the yellow panel, then press **START**.

- It only clicks profiles that still show **Requested**. Requests that were accepted, or accounts that were deleted, are skipped.
- It waits 20–35 seconds between cancels.

## Find who doesn't follow you back

**a) Save your followers.** Open `followers_1.html` and run this in the console:

```js
localStorage.setItem('ig_followers', JSON.stringify([...new Set([...document.querySelectorAll('a[href*="instagram.com"]')].map(a => a.href.replace(/\/$/, '').split('/').pop()))]))
```

If you have `followers_2.html` and more, open each one and run this to add it to the list:

```js
localStorage.setItem('ig_followers', JSON.stringify([...new Set([...JSON.parse(localStorage.getItem('ig_followers') || '[]'), ...[...document.querySelectorAll('a[href*="instagram.com"]')].map(a => a.href.replace(/\/$/, '').split('/').pop())])]))
```

**b) Compare.** Open `following.html` and run:

```js
(() => {
  const ids = () => [...new Set([...document.querySelectorAll('a[href*="instagram.com"]')].map(a => a.href.replace(/\/$/, '').split('/').pop()).filter(Boolean))];
  const followers = new Set(JSON.parse(localStorage.getItem('ig_followers') || '[]').map(x => x.toLowerCase()));
  const notBack = ids().filter(u => !followers.has(u.toLowerCase()));
  copy(JSON.stringify(notBack));
  console.log(notBack.length + ' accounts don\'t follow you back (list copied):', notBack);
})();
```

The list is now on your clipboard.

> All local `file://` pages share one `localStorage` in Chrome, so the list saved in step (a) is still there in step (b). If step (b) finds **0 followers**, open all the export files in the same browser profile and try again.

**c) Unfollow (optional).** Open instagram.com and click the **unfollow-non-followers** bookmarklet. Paste the list into the purple panel, then press **START**.

- It only unfollows profiles that still show **Following**. Anyone who followed you back in the meantime is skipped.
- It waits 30–50 seconds between unfollows.

---

## Safety built in

- **Slow by design.** Each action is followed by a random delay.
- **Stops on its own** if Instagram shows *"Try again later"* or *"We restrict certain activity"*, or if 3 actions fail in a row.
- **Resumable.** Press **START** again, even hours later, and it carries on from where it stopped.
- **Never acts blindly.** It checks the button state on each profile before clicking.
- **Runs only in your browser.** No data is sent anywhere.

## Troubleshooting

| Problem | Fix |
| --- | --- |
| Nothing happens when you click the bookmark | Check that the URL starts with `javascript:` |
| *"Popup blocked"* | Allow popups for instagram.com, then press START again |
| Lots of *Failed* | Instagram probably changed its layout or is limiting you. Stop, wait a few hours, and try again |
| Want to start over | In the instagram.com console, run `localStorage.removeItem('cfr_idx')` or `localStorage.removeItem('uf_idx')` |

---

## ❤️ Support

These scripts are free. If they cleaned up your account, you can say thanks by [**sponsoring me on GitHub**](https://github.com/sponsors/khemssharma) or by starring ⭐ the repo. Sponsors keep the scripts maintained when Instagram changes its layout.
