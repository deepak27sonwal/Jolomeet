# JoloMeet

Random text and video chat for meeting new people, built with HTML, CSS, vanilla JavaScript, WebRTC and Supabase.

## Backend

- Database schema, security policies, storage buckets and Realtime authorization: [`supabase/migrations/`](supabase/migrations/)
- Table and RPC reference plus project setup checklist: [`docs/database.md`](docs/database.md)

## Install as an Android app

JoloMeet is an installable web app, so there is nothing to download from a store:

1. Open the site in **Chrome on Android**.
2. Tap the **⋮** menu, then **Install app** (or **Add to Home screen**). Settings in JoloMeet also shows an **Install** button when the browser offers it.
3. Open JoloMeet from its new home-screen icon. It runs full-screen and updates itself whenever the site is updated.

Friends do the same: just send them the site link. Camera, microphone and notification permissions work as they do in Chrome. When there is no connection, an "offline" page is shown (`offline.html`); chat and calls always need the internet. The app files are `manifest.webmanifest` (name, icons, shortcuts) and `sw.js` (the service worker, which only ever uses the network first and never touches Supabase requests).

## Run locally

The site is plain HTML, CSS and JavaScript modules, so it needs a local web server (opening the file directly won't load the modules or icons):

```sh
python3 -m http.server 8000
# then open http://localhost:8000
```

## Deploying changes

GitHub Pages lets browsers keep CSS and JS for 10 minutes, so right after a
deploy a phone could mix new and old files. Before committing a CSS or JS change,
stamp a new version on every page:

```sh
python3 scripts/stamp-version.py
```

This adds `?v=<version>` to every local stylesheet and script link and writes an
import map, so modules loaded by other modules (`./api.js`, `./app.js`, ...) get
the same version.

## Pages

- `index.html`: homepage, including the two ways to use JoloMeet: **Random** (text, audio, video with strangers; no sign-up, guests welcome) and **With your account** (profile, connections, direct messages, saved history). Random needs no sign-up: visitors give a name, gender and age (`js/quick-start.js`) and go straight in; account features ask them to create an account (also enforced in the database)
- `login.html`: log in, forgot password, or start a random chat without an account
- `register.html`: create an account (email confirmation); someone chatting without an account turns it into a full account here and keeps their chats
- `reset-password.html`: set a new password from the emailed link (`?finish=1`: someone upgrading from a no-account session chooses their first password)
- `profile.html`: your profile (edit photo, cover, bio, interests, languages, privacy) or `profile.html?id=<user id>` for someone else's (chat, video, connect, report, block)
- `video.html`: random video chat (camera + microphone permission, self view, camera on/off and front/back switch, the other person's mute/camera state, next, end, report, block; full screen on phones)
- `audio.html`: random voice-only calls (microphone permission, matching on your interests, mute, next, end, report, block); peer-to-peer WebRTC with signalling over a private Supabase Realtime channel
- `chat.html`: conversations, message requests, favorites, random text matching (`chat.html?mode=random`) and a chat by id (`chat.html?c=<conversation id>`); realtime messages, typing, read receipts, photos, report and block

## Frontend structure

- `css/variables.css`: colours, type scale, spacing, radii, shadows (the design tokens)
- `css/global.css`, `css/layout.css`, `css/components.css`: shared base, page chrome and components
- `css/<page>.css`: page-specific styles
- `css/motion.css`, `js/motion.js`, `js/page-transition.js`: the only motion: pages slide left/right when switching tabs, and homepage sections slide in on scroll (both off when the device asks for reduced motion)
- `js/config.js`: public Supabase URL and publishable key (safe for browsers; all data is protected by RLS)
- `js/api.js`: every Supabase call goes through here
- `js/icebreakers.js`, `js/voice-note.js`: icebreaker questions (shared card in calls, dice in chat) and voice-note recording/playback
- `js/interest-picker.js`: interest chips shown right before matching (random chat, audio, video); the choice is remembered on the device
- `js/call.js`: the audio and video call pages (`<body data-mode="audio|video">`)
- `js/rtc.js`: WebRTC connection and signalling protocol shared by calls; STUN/TURN servers are in `js/config.js`
- `js/app.js`, `js/navigation.js`: shared setup, toasts, header/menu behaviour, signed-in header
- `js/auth.js`, `js/validation.js`: login/register/reset flows and form validation
