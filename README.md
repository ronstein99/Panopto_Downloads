# Panopto Lecture Downloader

A Chrome extension that saves HUJI Panopto lectures to your computer for offline viewing.
It keeps the **camera** and the **screen/projector** recordings separate and includes a
player that lets you swap between them and change the speed, just like in Panopto.

## Install (one time)

1. Open Chrome and go to `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select this `panopto-downloader` folder.
4. Click the puzzle-piece icon in the toolbar and **pin** "Panopto Lecture Downloader".

> Chrome loads the extension from this folder, so don't move or delete it.
> If you edit the files, press the ↻ reload button on the extension's card.

## Download a lecture

1. Log in to Panopto as usual and open a lecture (the page where the video plays).
2. Click the extension icon. It shows the lecture title and the recordings it found
   (normally **Camera** and **Screen**). If a label is wrong, change it in the dropdown.
3. Click **Download…**. A download tab opens.
4. Optionally edit the **Lecture name** (the folder it's saved in) and the **Course folder**.
   Clear the course folder to save the lecture straight into the folder you pick, for example
   a week folder. The extension remembers that choice.
5. The first time, click **Choose folder…** and pick where lectures should go
   (for example your OneDrive `lesson_recordings` folder). After that, just click
   **Use this folder**.
6. Keep the tab open until both progress bars finish.

Each lecture gets its own folder:

```
<your folder>/<Course>/<YYYY-MM-DD> - <Lecture title>/
  camera.mp4
  screen.mp4
  player.html   ← double-click to watch
  info.json
```

Clicking **Use this folder** again on the same lecture skips files that already finished
and retries only the ones that failed.

## Watch offline

Double-click `player.html`. It opens in Chrome and needs no internet.

| Action | Mouse | Key |
|---|---|---|
| Play / pause | ▶︎ button, or click the big video | `Space` |
| Swap big ↔ small screen | ⇄ Swap, or click the small video | `S` |
| Layout (big+small / side by side / one screen) | Layout menu | `V` |
| Speed 0.5×–3× | speed buttons | `[` slower, `]` faster |
| Skip 10 s (30 s with Shift) | ⟲ / ⟳ | `←` / `→` |
| Mute | | `M` |
| Fullscreen | ⛶ | `F` |

- The two videos stay in sync at any speed, and the voice keeps its normal pitch.
- The player remembers where you stopped, your speed, and your layout.
- Sound comes from the camera recording by default. If that recording turns out to be
  silent, the player switches to the other one automatically (or use the *Sound:* menu).
- `camera.mp4` / `screen.mp4` are normal video files, so you can also open them in QuickTime or IINA.

## Troubleshooting

- **"Open a Panopto lecture…"**: you're not on a lecture's viewer page. Open the lecture itself.
- **Errors about access or login**: refresh the Panopto page (your login may have expired), then retry.
- **Something else looks wrong** (missing recordings, failed downloads): click
  **Copy diagnostics** in the popup and paste it to Claude. It contains the lecture's stream
  information, with the private parts of the links removed.
- Chrome may ask to let the extension access another website the first time. That's the
  video server Panopto uses. Allow it and click the button again.

Use this only for lectures you have access to, for personal study, and in line with university policy.
