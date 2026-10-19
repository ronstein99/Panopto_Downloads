const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
let job = null;
let busy = false;

// ---------- Saved folder (IndexedDB keeps the directory handle between downloads) ----------

function idb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("panopto-downloader", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("kv");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function kvGet(key) {
  const db = await idb();
  return new Promise((resolve) => {
    const r = db.transaction("kv").objectStore("kv").get(key);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => resolve(undefined);
  });
}
async function kvSet(key, value) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("kv", "readwrite");
    tx.objectStore("kv").put(value, key);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

// ---------- Networking ----------

async function fetchRetry(url, opts = {}, tries = 4) {
  let lastErr;
  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      const resp = await fetch(url, { credentials: "include", ...opts });
      if (!resp.ok && resp.status !== 206) throw new Error(`HTTP ${resp.status} for ${url.split("?")[0]}`);
      return resp;
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    }
  }
  throw lastErr;
}

function originsFor(urls) {
  return [...new Set(urls.filter(Boolean).map((u) => new URL(u).origin + "/*"))];
}

// ---------- Direct MP4 download, streamed to disk ----------

async function downloadDirect(url, fileHandle, onProgress) {
  const resp = await fetchRetry(url);
  const type = resp.headers.get("content-type") || "";
  if (type.includes("text/html")) throw new Error("Got a web page instead of a video (login expired?)");
  if (/mpegurl/i.test(type) || /\.m3u8(\?|$)/i.test(new URL(resp.url).pathname)) {
    resp.body.cancel();
    return downloadHls(resp.url, fileHandle, onProgress);
  }
  // Panopto sometimes serves HLS playlists without saying so; check the first bytes.
  const [head, rest] = resp.body.tee();
  const reader = head.getReader();
  const first = (await reader.read()).value || new Uint8Array();
  reader.cancel();
  if (new TextDecoder().decode(first.slice(0, 7)) === "#EXTM3U") {
    rest.cancel();
    return downloadHls(resp.url, fileHandle, onProgress);
  }

  const total = Number(resp.headers.get("content-length")) || 0;
  let done = 0;
  const counter = new TransformStream({
    transform(chunk, ctl) {
      done += chunk.byteLength;
      onProgress(total ? done / total : null, done);
      ctl.enqueue(chunk);
    },
  });
  const writable = await fileHandle.createWritable();
  await rest.pipeThrough(counter).pipeTo(writable); // closes the file when done
  return done;
}

// True if the file looks like a real MP4 (and not, say, a saved playlist or error page).
async function looksLikeMp4(file) {
  if (file.size < 100 * 1024) return false;
  const box = new TextDecoder().decode(await file.slice(4, 8).arrayBuffer());
  return ["ftyp", "moov", "moof", "styp", "free", "mdat"].includes(box);
}

// ---------- HLS download ----------

function parseAttrs(line) {
  const attrs = {};
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  let m;
  while ((m = re.exec(line))) attrs[m[1]] = m[2].replace(/^"|"$/g, "");
  return attrs;
}

async function loadMediaPlaylist(url) {
  let text = await (await fetchRetry(url)).text();
  if (text.includes("#EXT-X-STREAM-INF")) {
    // Master playlist: pick the highest-bandwidth variant.
    const lines = text.split(/\r?\n/);
    let best = null;
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].startsWith("#EXT-X-STREAM-INF")) continue;
      const bw = Number(parseAttrs(lines[i]).BANDWIDTH) || 0;
      let j = i + 1;
      while (j < lines.length && (!lines[j].trim() || lines[j].startsWith("#"))) j++;
      if (j < lines.length && (!best || bw > best.bw)) best = { bw, uri: lines[j].trim() };
    }
    if (!best) throw new Error("Empty HLS master playlist");
    url = new URL(best.uri, url).href;
    text = await (await fetchRetry(url)).text();
  }

  const segments = [];
  let seq = 0, key = null, map = null, range = null, lastRangeEnd = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#EXT-X-MEDIA-SEQUENCE:")) seq = Number(line.split(":")[1]) || 0;
    else if (line.startsWith("#EXT-X-KEY:")) {
      const a = parseAttrs(line.slice(11));
      key = a.METHOD && a.METHOD !== "NONE"
        ? { method: a.METHOD, uri: new URL(a.URI, url).href, iv: a.IV || null } : null;
    } else if (line.startsWith("#EXT-X-MAP:")) {
      const a = parseAttrs(line.slice(11));
      map = { url: new URL(a.URI, url).href, range: a.BYTERANGE ? parseRange(a.BYTERANGE, 0) : null };
    } else if (line.startsWith("#EXT-X-BYTERANGE:")) {
      range = parseRange(line.split(":")[1], lastRangeEnd);
    } else if (!line.startsWith("#")) {
      segments.push({ url: new URL(line, url).href, seq, key, range });
      if (range) lastRangeEnd = range.start + range.length;
      range = null;
      seq++;
    }
  }
  if (!segments.length) throw new Error("HLS playlist has no segments");
  return { segments, map };
}

function parseRange(str, defaultStart) {
  const [len, start] = str.split("@");
  return { length: Number(len), start: start !== undefined ? Number(start) : defaultStart };
}

const keyCache = new Map();
async function fetchSegment(seg) {
  const headers = seg.range ? { Range: `bytes=${seg.range.start}-${seg.range.start + seg.range.length - 1}` } : {};
  let data = await (await fetchRetry(seg.url, { headers })).arrayBuffer();
  if (seg.key) {
    if (seg.key.method !== "AES-128") throw new Error("Unsupported HLS encryption: " + seg.key.method);
    if (!keyCache.has(seg.key.uri)) {
      const raw = await (await fetchRetry(seg.key.uri)).arrayBuffer();
      keyCache.set(seg.key.uri, crypto.subtle.importKey("raw", raw, "AES-CBC", false, ["decrypt"]));
    }
    const iv = new Uint8Array(16);
    if (seg.key.iv) {
      const hex = seg.key.iv.replace(/^0x/i, "").padStart(32, "0");
      for (let i = 0; i < 16; i++) iv[i] = parseInt(hex.substr(i * 2, 2), 16);
    } else {
      new DataView(iv.buffer).setUint32(12, seg.seq);
    }
    data = await crypto.subtle.decrypt({ name: "AES-CBC", iv }, await keyCache.get(seg.key.uri), data);
  }
  return new Uint8Array(data);
}

async function downloadHls(url, fileHandle, onProgress) {
  const { segments, map } = await loadMediaPlaylist(url);
  const writable = await fileHandle.createWritable();
  let bytes = 0;
  const write = async (chunk) => { await writable.write(chunk); bytes += chunk.byteLength; };

  try {
    let transmuxer = null;
    let wroteInit = false;
    let pending = [];

    if (map) {
      const headers = map.range ? { Range: `bytes=${map.range.start}-${map.range.start + map.range.length - 1}` } : {};
      await write(new Uint8Array(await (await fetchRetry(map.url, { headers })).arrayBuffer()));
    }

    // Fetch a few segments ahead while writing them strictly in order.
    const AHEAD = 4;
    const inflight = [];
    for (let i = 0; i < Math.min(AHEAD, segments.length); i++) inflight.push(fetchSegment(segments[i]));

    for (let i = 0; i < segments.length; i++) {
      const data = await inflight[i];
      inflight[i] = null;
      if (i + AHEAD < segments.length) inflight.push(fetchSegment(segments[i + AHEAD]));

      if (i === 0 && !map && data[0] === 0x47 && (data.length < 189 || data[188] === 0x47)) {
        // MPEG-TS: remux into MP4 so Chrome and QuickTime can play it.
        transmuxer = new muxjs.mp4.Transmuxer();
        transmuxer.on("data", (out) => {
          if (!wroteInit) { pending.push(out.initSegment); wroteInit = true; }
          pending.push(out.data);
        });
      }

      if (transmuxer) {
        transmuxer.push(data);
        transmuxer.flush();
        for (const chunk of pending) await write(chunk);
        pending = [];
      } else {
        await write(data); // fMP4 segments are already MP4 fragments
      }
      onProgress((i + 1) / segments.length, bytes);
    }
    await writable.close();
  } catch (e) {
    await writable.abort().catch(() => {});
    throw e;
  }
  return bytes;
}

// ---------- One stream ----------

async function downloadStream(stream, fileHandle, onProgress) {
  const attempts = [];
  if (stream.httpUrl) attempts.push(() => downloadDirect(stream.httpUrl, fileHandle, onProgress));
  if (stream.hlsUrl) attempts.push(() => downloadHls(stream.hlsUrl, fileHandle, onProgress));
  if (stream.otherUrl) attempts.push(() => downloadDirect(stream.otherUrl, fileHandle, onProgress));
  let lastErr;
  for (const attempt of attempts) {
    try {
      const bytes = await attempt();
      if (await looksLikeMp4(await fileHandle.getFile())) return bytes;
      lastErr = new Error("Downloaded file is not a playable video");
    } catch (e) { lastErr = e; console.warn(e); }
  }
  throw lastErr || new Error("No downloadable URL");
}

// ---------- UI ----------

function fmtBytes(n) {
  if (n > 1e9) return (n / 1e9).toFixed(2) + " GB";
  return (n / 1e6).toFixed(0) + " MB";
}

function defaultLectureName() {
  // Skip the date prefix when the title already contains it (e.g. "67656 2026-10-14 שעור א").
  const showDate = job.date && !job.title.includes(job.date);
  return [showDate && job.date, job.title].filter(Boolean).join(" - ");
}

function lectureFolderName() {
  return sanitize($("lectureName").value.trim() || defaultLectureName());
}

// Empty means "no course subfolder".
function courseFolderName() {
  const v = $("courseName").value.trim();
  return v ? sanitize(v) : "";
}

function relativePath() {
  return [courseFolderName(), lectureFolderName()].filter(Boolean).join("/") + "/";
}

function assignFileNames(selected) {
  const used = new Set();
  return selected.map((s) => {
    let base = s.label, name = base + ".mp4", n = 2;
    while (used.has(name)) name = `${base}-${n++}.mp4`;
    used.add(name);
    return { ...s, file: name };
  });
}

async function readJson(dir, name) {
  try {
    const fh = await dir.getFileHandle(name);
    return JSON.parse(await (await fh.getFile()).text());
  } catch { return null; }
}

async function writeText(dir, name, text) {
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  await w.write(text);
  await w.close();
}

// Loaded once when the page opens, so a later hiccup reading the extension folder
// (e.g. OneDrive making the file "online-only") can't stop player.html being written.
let playerTemplate = null;
async function loadPlayerTemplate() {
  if (playerTemplate) return playerTemplate;
  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const text = await (await fetch(chrome.runtime.getURL("player/player.html"))).text();
      if (!text.includes("/*LECTURE_DATA*/null")) throw new Error("player template is incomplete");
      return (playerTemplate = text);
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    }
  }
  throw new Error("Could not read the player template: " + lastErr.message);
}

async function writePlayer(dir, items) {
  const tpl = await loadPlayerTemplate();
  const data = {
    id: job.id,
    title: $("lectureName").value.trim() || job.title,
    course: job.course,
    date: job.date,
    videos: items.filter((s) => s.done).map((s) => ({
      file: s.file, label: s.label, kind: s.kind, offset: s.offset || 0,
    })),
  };
  const json = JSON.stringify(data).replace(/</g, "\\u003c");
  // A function replacement, so "$" in a title isn't treated as a replace pattern.
  await writeText(dir, "player.html", tpl.replace("/*LECTURE_DATA*/null", () => json));
}

function showResult(ok, heading, detail) {
  $("result").innerHTML = `<div class="card"><strong class="${ok ? "ok" : "error"}"></strong>
    <div class="muted small" style="margin-top:6px"></div></div>`;
  $("result").querySelector("strong").textContent = heading;
  $("result").querySelector("div").textContent = detail;
}

async function run(root) {
  busy = true;
  $("choose").disabled = $("useSaved").disabled = true;
  $("lectureName").disabled = $("courseName").disabled = true;
  $("result").innerHTML = "";
  window.onbeforeunload = () => "Download in progress";
  try {
    await download(root);
  } catch (e) {
    console.error(e);
    showResult(false, "Something went wrong: " + e.message,
      "Files that finished are kept. Click Use this folder to try again; it skips them.");
  } finally {
    window.onbeforeunload = null;
    busy = false;
    $("choose").disabled = $("useSaved").disabled = false;
    $("lectureName").disabled = $("courseName").disabled = false;
  }
}

async function download(root) {
  const course = courseFolderName();
  const parent = course ? await root.getDirectoryHandle(course, { create: true }) : root;
  const dir = await parent.getDirectoryHandle(lectureFolderName(), { create: true });
  const previous = (await readJson(dir, "info.json")) || {};
  const doneBefore = new Set((previous.files || []).filter((f) => f.complete).map((f) => f.file));

  const items = assignFileNames(job.selected);
  // Write the player up front (listing every video) so it exists even if the tab is closed
  // mid-download; it's rewritten at the end to list only the videos that finished.
  let playerError = null;
  await writePlayer(dir, items.map((s) => ({ ...s, done: true }))).catch((e) => { playerError = e; });
  $("progress").innerHTML = "";
  const runs = items.map(async (s) => {
    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML = `<div><strong></strong> <span class="muted small"></span></div>
      <div class="bar"><div></div></div><div class="muted small status">Starting…</div>`;
    card.querySelector("strong").textContent = s.file;
    card.querySelector("span").textContent = s.kind === "podcast" ? "combined view" : s.tag || "";
    $("progress").appendChild(card);
    const bar = card.querySelector(".bar > div");
    const status = card.querySelector(".status");

    if (doneBefore.has(s.file)) {
      try {
        const f = await (await dir.getFileHandle(s.file)).getFile();
        if (await looksLikeMp4(f)) {
          bar.style.width = "100%";
          status.textContent = "Already downloaded — skipped (" + fmtBytes(f.size) + ")";
          s.done = true;
          return;
        }
      } catch {}
    }

    try {
      const fh = await dir.getFileHandle(s.file, { create: true });
      const bytes = await downloadStream(s, fh, (frac, b) => {
        if (frac != null) bar.style.width = (frac * 100).toFixed(1) + "%";
        status.textContent = (frac != null ? Math.floor(frac * 100) + "% · " : "") + fmtBytes(b);
      });
      bar.style.width = "100%";
      status.textContent = "Done · " + fmtBytes(bytes);
      status.className = "small ok status";
      s.done = true;
    } catch (e) {
      status.textContent = "Failed: " + e.message;
      status.className = "small error status";
    }
  });
  await Promise.all(runs);

  await writeText(dir, "info.json", JSON.stringify({
    id: job.id, title: job.title, course: job.course, date: job.date,
    source: `${job.origin}/Panopto/Pages/Viewer.aspx?id=${job.id}`,
    files: items.map((s) => ({ file: s.file, label: s.label, kind: s.kind, tag: s.tag, offset: s.offset, complete: !!s.done })),
  }, null, 2));
  if (items.some((s) => s.done)) {
    playerError = null;
    await writePlayer(dir, items).catch((e) => { playerError = e; });
  }

  const path = `${root.name}/${relativePath()}`.replace(/\/$/, "");
  if (playerError) {
    showResult(false, "Videos saved, but player.html could not be written: " + playerError.message,
      `Click Use this folder to try again (finished videos are skipped). Meanwhile, open the .mp4 files in ${path} directly.`);
    return;
  }
  const allOk = items.every((s) => s.done);
  showResult(allOk, allOk ? "Lecture saved." : "Some files failed — click Use this folder to retry them.",
    `Open ${path}/player.html to watch (double-click it in Finder; it opens in Chrome).`);
}

async function ensureHostPermission() {
  const origins = originsFor(job.selected.flatMap((s) => [s.httpUrl, s.hlsUrl, s.otherUrl]));
  if (await chrome.permissions.contains({ origins })) return true;
  const granted = await chrome.permissions.request({ origins });
  if (granted) $("folderName").textContent += "  (access granted — click again to start)";
  return false; // the permission prompt uses up the click, so the user clicks again
}

async function init() {
  const stored = await chrome.storage.session.get("job:" + params.get("job"));
  job = stored["job:" + params.get("job")];
  if (!job) {
    $("title").textContent = "This download has expired. Click the extension icon on the lecture page again.";
    $("folderCard").hidden = $("nameCard").hidden = true;
    return;
  }
  document.title = "Downloading: " + job.title;
  $("title").textContent = job.title;
  $("meta").textContent = [job.course, job.date].filter(Boolean).join(" · ");
  $("lectureName").value = defaultLectureName();
  $("lectureName").placeholder = defaultLectureName();
  // Remember whether the course subfolder was wanted last time.
  const { useCourseFolder = true } = await chrome.storage.local.get("useCourseFolder");
  $("courseName").value = useCourseFolder ? job.course : "";
  $("courseName").placeholder = "(none)";
  const updatePath = () => { $("subPath").textContent = relativePath(); };
  $("lectureName").addEventListener("input", updatePath);
  $("courseName").addEventListener("input", updatePath);
  $("courseName").addEventListener("change", () =>
    chrome.storage.local.set({ useCourseFolder: !!$("courseName").value.trim() }));
  updatePath();
  loadPlayerTemplate().catch((e) => console.warn(e)); // retried when it's needed

  const saved = await kvGet("rootDir");
  if (saved) {
    $("folderName").textContent = "Last used: " + saved.name;
    $("useSaved").hidden = false;
    $("choose").textContent = "Choose a different folder…";
  }

  $("useSaved").onclick = async () => {
    if (busy || !(await ensureHostPermission())) return;
    if ((await saved.requestPermission({ mode: "readwrite" })) !== "granted") return;
    run(saved);
  };
  $("choose").onclick = async () => {
    if (busy || !(await ensureHostPermission())) return;
    let dir;
    try {
      dir = await showDirectoryPicker({ id: "panopto-root", mode: "readwrite", startIn: "documents" });
    } catch { return; } // cancelled
    await kvSet("rootDir", dir);
    $("folderName").textContent = "Saving to: " + dir.name;
    run(dir);
  };
}

init();
