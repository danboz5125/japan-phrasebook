# Japan Phrasebook

An offline, speaking-first Japanese phrasebook for an Android phone, built for
a two-week trip to Tokyo, Kyoto, Osaka, Nara and a ryokan stay in late
October 2026.

- Phrases by situation: restaurants, bars, trains and taxis, hotels and
  ryokan, shopping, sightseeing, directions, money and time, emergencies,
  onsen and temples, small talk. Each situation also lists what staff will
  say to you ("They say") and how to answer.
- Romaji first, split into beats (A·ri·ga·tō), with the Japanese below for
  showing people. Tap to hear it, tap again for slow.
- About 1,300 searchable travel words, including signs to recognize.
- Etiquette do's and don'ts.
- Favorites, recents, speaking and listening practice, your own phrases,
  hotel address cards for taxis.
- Works fully offline. Shares itself to another phone over Quick Share.

Install and setup: [docs/PHONE_SETUP.md](docs/PHONE_SETUP.md).

## How it's built

| Part | What |
|---|---|
| `web/` | The app: plain HTML, CSS and JavaScript, no build step. |
| `web/data/` | Phrases, words and etiquette as JSON. Entry format: `[english, japanese, kana, romaji, note?, tags?]`. |
| `android/` | A small WebView shell (Java) that adds Japanese text-to-speech, clipboard and app sharing. |
| `tools/check_data.py` | Validates the data, including that the romaji matches the kana reading. |
| `tools/fmt_data.py` | Rewrites data files one entry per line. |
| `.github/workflows/android.yml` | Builds and signs the APK on GitHub, attaches it to releases. |

## Working on it

Preview in a desktop browser (audio uses the browser's Japanese voice if it has one):

```bash
python -m http.server 8765 --directory web
```

After editing data:

```bash
python tools/fmt_data.py
python tools/check_data.py
```

To ship a build, publish a GitHub release with a tag like `v1.0.0`. The
workflow attaches `JapanPhrasebook.apk` to it.

The APK is signed with `android/debug.keystore` (password `android`), a key
committed on purpose so every build installs over the last one. It's for
sideloading only.
