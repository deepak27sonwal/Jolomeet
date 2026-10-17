# JoloMeet

Random text and video chat for meeting new people, built with HTML, CSS, vanilla JavaScript, WebRTC and Supabase.

## Backend

- Database schema, security policies, storage buckets and Realtime authorization: [`supabase/migrations/`](supabase/migrations/)
- Table and RPC reference plus project setup checklist: [`docs/database.md`](docs/database.md)

## Run locally

The site is plain HTML, CSS and JavaScript modules, so it needs a local web server (opening the file directly won't load the modules or icons):

```sh
python3 -m http.server 8000
# then open http://localhost:8000
```

## Pages

- `index.html`: homepage
- `login.html`: log in, forgot password, continue as guest
- `register.html`: create an account (email confirmation)
- `reset-password.html`: set a new password from the emailed link
- `profile.html`: your profile (edit photo, cover, bio, interests, languages, privacy) or `profile.html?id=<user id>` for someone else's (chat, video, connect, report, block)
- `chat.html`: conversations, message requests, favorites, random text matching (`chat.html?mode=random`) and a chat by id (`chat.html?c=<conversation id>`); realtime messages, typing, read receipts, photos, report and block

## Frontend structure

- `css/variables.css`: colours, type scale, spacing, radii, shadows (the design tokens)
- `css/global.css`, `css/layout.css`, `css/components.css`: shared base, page chrome and components
- `css/<page>.css`: page-specific styles
- `js/config.js`: public Supabase URL and publishable key (safe for browsers; all data is protected by RLS)
- `js/api.js`: every Supabase call goes through here
- `js/app.js`, `js/navigation.js`: shared setup, toasts, header/menu behaviour, signed-in header
- `js/auth.js`, `js/validation.js`: login/register/reset flows and form validation
