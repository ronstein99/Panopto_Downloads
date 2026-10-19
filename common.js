// Shared helpers for the popup and the download page.

// Runs inside the Panopto page (same origin, so the HUJI login cookies apply).
// Must be self-contained: it is serialized by chrome.scripting.executeScript.
async function fetchDeliveryInfoInPage(deliveryId) {
  const body = new URLSearchParams({
    deliveryId,
    invocationId: "",
    isLiveNotes: "false",
    refreshAuthCookie: "true",
    isActiveBroadcast: "false",
    isEditing: "false",
    isKollectiveAgentInstalled: "false",
    isEmbed: "false",
    responseType: "json",
  });
  const base = location.pathname.toLowerCase().includes("/panopto/") ? "/Panopto" : "";
  const resp = await fetch(base + "/Pages/Viewer/DeliveryInfo.aspx", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const text = await resp.text();
  try {
    return { ok: resp.ok, status: resp.status, json: JSON.parse(text), origin: location.origin };
  } catch {
    return { ok: false, status: resp.status, error: "Response was not JSON: " + text.slice(0, 200) };
  }
}

function parseLectureUrl(url) {
  try {
    const u = new URL(url);
    if (!/panopto\.(eu|com)$/i.test(u.hostname)) return null;
    if (!/\/(Viewer|Embed)\.aspx$/i.test(u.pathname)) return null;
    const id = u.searchParams.get("id");
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) return null;
    return { id, origin: u.origin };
  } catch {
    return null;
  }
}

const SCREEN_HINTS = /screen|object|slide|capture|computer|projector|display|desktop|vga|hdmi|pc|ppt|presentation/i;
const CAMERA_HINTS = /\bdv\b|camera|cam|webcam|video|lecturer|speaker|room|podium/i;

function guessLabel(stream, index) {
  const text = [stream.Tag, stream.Name, stream.StreamType].filter(Boolean).join(" ");
  if (SCREEN_HINTS.test(text)) return "screen";
  if (CAMERA_HINTS.test(text)) return "camera";
  return index === 0 ? "camera" : "screen";
}

function absUrl(u, origin) {
  if (!u) return null;
  try { return new URL(u, origin).href; } catch { return null; }
}

// Turns the DeliveryInfo JSON into a simple lecture description.
function describeLecture(info, origin, id) {
  if (info.ErrorCode || info.ErrorMessage) {
    throw new Error(info.ErrorMessage || "Panopto error " + info.ErrorCode);
  }
  const d = info.Delivery;
  if (!d) throw new Error("Panopto returned no lecture information (are you logged in?)");

  const toStream = (s, i, kind) => ({
    index: i,
    kind,
    tag: s.Tag || "",
    name: s.Name || "",
    httpUrl: absUrl(s.StreamHttpUrl, origin),
    hlsUrl: s.StreamUrl && /hls|m3u8/i.test((s.ViewerMediaFileTypeName || "") + s.StreamUrl)
      ? absUrl(s.StreamUrl, origin) : null,
    otherUrl: s.StreamUrl && !/hls|m3u8/i.test((s.ViewerMediaFileTypeName || "") + s.StreamUrl)
      ? absUrl(s.StreamUrl, origin) : null,
    offset: Number(s.RelativeStart) || 0,
    duration: Number(s.RelativeEnd) && Number(s.RelativeEnd) > (Number(s.RelativeStart) || 0)
      ? Number(s.RelativeEnd) - (Number(s.RelativeStart) || 0) : null,
  });

  const streams = (d.Streams || []).map((s, i) => ({ ...toStream(s, i, "stream"), label: guessLabel(s, i) }));
  // If both guessed the same label, give the second one the other label.
  if (streams.length === 2 && streams[0].label === streams[1].label) {
    streams[1].label = streams[0].label === "camera" ? "screen" : "camera";
  }
  const podcasts = (d.PodcastStreams || []).map((s, i) => ({ ...toStream(s, i, "podcast"), label: "combined" }));

  const title = decodeEntities(d.SessionName || "Lecture");
  // Folder paths come as "2026-27 -> 67656-Course name"; keep the last part.
  const course = decodeEntities(d.SessionGroupLongName || d.SessionGroupShortName || "Panopto")
    .split("->").pop().trim();
  return {
    id,
    origin,
    title,
    course,
    date: sessionDate(info.SessionStartTime || d.SessionStartTime, title),
    duration: Number(d.Duration) || null,
    streams,
    podcasts,
  };
}

function decodeEntities(s) {
  return String(s)
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&(gt|lt|quot|apos|amp);/g, (_, e) => ({ gt: ">", lt: "<", quot: '"', apos: "'", amp: "&" })[e]);
}

// Panopto's SessionStartTime counts seconds from 1601 (Windows epoch), not 1970.
function sessionDate(seconds, title) {
  const inTitle = /\b(20\d\d-\d\d-\d\d)\b/.exec(title || "");
  if (inTitle) return inTitle[1];
  let sec = Number(seconds);
  if (!sec) return "";
  if (sec > 1e10) sec -= 11644473600; // 1601 → 1970
  const date = new Date(sec * 1000);
  return isNaN(date) ? "" : date.toISOString().slice(0, 10);
}

function sanitize(name) {
  return String(name)
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+|\.+$/g, "")
    .slice(0, 120) || "untitled";
}

// Summary of the raw response with URLs shortened, for troubleshooting.
function diagnostics(info) {
  const d = (info && info.Delivery) || {};
  const pick = (s) => ({
    Tag: s.Tag, Name: s.Name, StreamType: s.StreamType,
    ViewerMediaFileTypeName: s.ViewerMediaFileTypeName,
    RelativeStart: s.RelativeStart, RelativeEnd: s.RelativeEnd,
    StreamUrl: s.StreamUrl ? s.StreamUrl.split("?")[0] : undefined,
    StreamHttpUrl: s.StreamHttpUrl ? s.StreamHttpUrl.split("?")[0] : undefined,
    keys: Object.keys(s),
  });
  return JSON.stringify({
    ErrorCode: info && info.ErrorCode,
    deliveryKeys: Object.keys(d),
    SessionName: d.SessionName,
    Streams: (d.Streams || []).map(pick),
    PodcastStreams: (d.PodcastStreams || []).map(pick),
  }, null, 2);
}
