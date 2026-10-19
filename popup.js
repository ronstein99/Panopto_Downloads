const $ = (id) => document.getElementById(id);
let lecture = null;
let rawInfo = null;

function showStatus(msg, isError) {
  $("status").textContent = msg;
  $("status").className = isError ? "error" : "muted";
  $("status").hidden = false;
}

function fmtDuration(sec) {
  if (!sec) return "";
  const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m`;
}

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const parsed = tab && parseLectureUrl(tab.url || "");
  if (!parsed) {
    showStatus("Open a Panopto lecture (the page where the video plays), then click this icon again.");
    return;
  }

  let result;
  try {
    [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: fetchDeliveryInfoInPage,
      args: [parsed.id],
    });
  } catch (e) {
    showStatus("Could not read the page: " + e.message, true);
    return;
  }
  if (!result || !result.json) {
    showStatus((result && result.error) || "Panopto did not answer (HTTP " + (result && result.status) + ").", true);
    return;
  }
  rawInfo = result.json;
  $("diag").hidden = false;

  try {
    lecture = describeLecture(rawInfo, result.origin, parsed.id);
  } catch (e) {
    showStatus(e.message, true);
    return;
  }
  render();
}

function render() {
  $("status").hidden = true;
  $("lecture").hidden = false;
  $("title").textContent = lecture.title;
  $("meta").textContent = [lecture.course, lecture.date, fmtDuration(lecture.duration)].filter(Boolean).join(" · ");

  const box = $("streams");
  if (!lecture.streams.length) {
    box.innerHTML = '<div class="muted">No separate streams found.</div>';
  }
  lecture.streams.forEach((s, i) => {
    const row = document.createElement("div");
    row.className = "row stream";
    const ok = s.httpUrl || s.hlsUrl || s.otherUrl;
    row.innerHTML = `
      <input type="checkbox" data-i="${i}" ${ok ? "checked" : "disabled"}>
      <select data-i="${i}">
        <option value="camera">Camera</option>
        <option value="screen">Screen</option>
      </select>
      <span class="muted small"></span>`;
    row.querySelector("select").value = s.label;
    row.querySelector("span").textContent =
      [s.tag || s.name, s.httpUrl ? "MP4" : s.hlsUrl ? "HLS" : s.otherUrl ? "file" : "unavailable"]
        .filter(Boolean).join(" · ");
    box.appendChild(row);
  });

  const podcastOk = lecture.podcasts.some((p) => p.httpUrl || p.hlsUrl || p.otherUrl);
  $("podcastRow").hidden = !podcastOk;
  // With no separate streams, the combined file is the only thing to download.
  $("podcast").checked = podcastOk && !lecture.streams.length;
}

$("download").addEventListener("click", async () => {
  const chosen = [];
  document.querySelectorAll("#streams input[type=checkbox]").forEach((cb) => {
    if (!cb.checked) return;
    const i = Number(cb.dataset.i);
    const label = document.querySelector(`#streams select[data-i="${i}"]`).value;
    chosen.push({ ...lecture.streams[i], label });
  });
  if ($("podcast").checked) {
    const p = lecture.podcasts.find((p) => p.httpUrl || p.hlsUrl || p.otherUrl);
    if (p) chosen.push(p);
  }
  if (!chosen.length) {
    showStatus("Select at least one recording.", true);
    return;
  }

  const job = { ...lecture, selected: chosen };
  const jobId = crypto.randomUUID();
  await chrome.storage.session.set({ ["job:" + jobId]: job });
  await chrome.tabs.create({ url: chrome.runtime.getURL("download.html?job=" + jobId) });
  window.close();
});

$("diag").addEventListener("click", async () => {
  await navigator.clipboard.writeText(diagnostics(rawInfo));
  $("diag").textContent = "Copied — paste it to Claude";
});

init();
