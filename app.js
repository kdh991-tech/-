import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {
  getDatabase,
  ref,
  get,
  push,
  set,
  update,
  remove,
  onValue,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-database.js";
import { firebaseConfig } from "./firebase-config.js";

const app = initializeApp(firebaseConfig);
const db = getDatabase(app);

let currentRoomKey = null;
let unsubs = [];
let cachedSurveys = [];
let cachedBlogs = [];

const $ = (id) => document.getElementById(id);

function escapeHtml(str = "") {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function deriveRoomKey(pin) {
  const raw = new TextEncoder().encode(`pickle-office-kdh:${pin.trim()}`);
  const hashBuf = await crypto.subtle.digest("SHA-256", raw);
  const hashArr = Array.from(new Uint8Array(hashBuf));
  return hashArr
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 32);
}

function formatTime(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${mm}/${dd} ${hh}:${mi}`;
}

async function tryUnlock(pin) {
  $("pin-error").classList.add("hidden");
  try {
    const key = await deriveRoomKey(pin);
    // 실제 접근 권한 확인 (Rules에서 일치하는 roomKey만 읽기 허용)
    await get(ref(db, `office/${key}/meta`));
    currentRoomKey = key;
    sessionStorage.setItem("pickle_office_pin", pin);
    $("lock-screen").classList.add("hidden");
    $("app-screen").classList.remove("hidden");
    startSync();
  } catch (err) {
    console.error(err);
    sessionStorage.removeItem("pickle_office_pin");
    $("pin-error").classList.remove("hidden");
  }
}

function lockApp() {
  unsubs.forEach((fn) => fn());
  unsubs = [];
  currentRoomKey = null;
  sessionStorage.removeItem("pickle_office_pin");
  $("pin-input").value = "";
  $("app-screen").classList.add("hidden");
  $("lock-screen").classList.remove("hidden");
}

function roomRef(subPath) {
  return ref(db, `office/${currentRoomKey}/${subPath}`);
}

function startSync() {
  unsubs.forEach((fn) => fn());
  unsubs = [];
  $("sync-status").textContent = "실시간 연결됨";

  // API 가이드 URL 세팅
  const baseUrl = `${firebaseConfig.databaseURL}/office/${currentRoomKey}`;
  $("api-base-url").textContent = baseUrl;
  $("api-get-example").textContent = `GET ${baseUrl}.json`;
  $("api-post-example").textContent =
    `POST ${baseUrl}/memos.json  {"author":"키루루","tag":"보고","text":"작업 완료","done":false}`;

  // 1. 메모 실시간 구독
  unsubs.push(
    onValue(roomRef("memos"), (snap) => {
      const val = snap.val() || {};
      const items = Object.entries(val)
        .map(([id, item]) => ({ id, ...item }))
        .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      renderMemos(items);
    })
  );

  // 2. 설문 실시간 구독
  unsubs.push(
    onValue(roomRef("surveys"), (snap) => {
      const val = snap.val() || {};
      cachedSurveys = Object.entries(val)
        .map(([id, item]) => ({ id, ...item }))
        .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      renderSurveys();
    })
  );

  // 3. 블로그 실시간 구독
  unsubs.push(
    onValue(roomRef("blogs"), (snap) => {
      const val = snap.val() || {};
      cachedBlogs = Object.entries(val)
        .map(([id, item]) => ({ id, ...item }))
        .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      renderBlogs();
    })
  );
}

function renderMemos(items) {
  const el = $("memo-list");
  if (!items.length) {
    el.innerHTML = `<div class="card muted">아직 등록된 메모가 없어요. 첫 메모를 남겨보세요!</div>`;
    return;
  }
  el.innerHTML = items
    .map(
      (m) => `
    <div class="item-card ${m.done ? "is-done" : ""}">
      <div class="item-head">
        <div>
          <span class="pill ${m.tag === "지시" ? "orange" : m.tag === "보고" ? "green" : "blue"}">${escapeHtml(m.tag || "전달")}</span>
          <strong>${escapeHtml(m.author || "비서")}</strong>
        </div>
        <span class="muted">${formatTime(m.createdAt)}</span>
      </div>
      <div class="item-body">${escapeHtml(m.text)}</div>
      <div class="item-foot">
        <span></span>
        <div class="item-actions">
          <button class="btn-small" data-memo-toggle="${m.id}" data-done="${Boolean(m.done)}">
            ${m.done ? "↩️ 다시 열기" : "✔️ 확인 완료"}
          </button>
          <button class="btn-small btn-danger" data-memo-del="${m.id}">삭제</button>
        </div>
      </div>
    </div>`
    )
    .join("");
}

function surveyPillColor(status) {
  if (status === "당첨") return "green";
  if (status === "진행중") return "blue";
  if (status === "발표대기") return "orange";
  if (status === "미당첨" || status === "마감") return "red";
  return "";
}

function renderSurveys() {
  const counts = {
    진행중: cachedSurveys.filter((s) => s.status === "진행중").length,
    발표대기: cachedSurveys.filter((s) => s.status === "발표대기").length,
    당첨: cachedSurveys.filter((s) => s.status === "당첨").length,
    종료: cachedSurveys.filter((s) => s.status === "미당첨" || s.status === "마감").length,
  };
  $("survey-stats").innerHTML = `
    <div class="stat-box"><div class="stat-num">${counts.진행중}</div><div class="stat-label">진행중</div></div>
    <div class="stat-box"><div class="stat-num">${counts.발표대기}</div><div class="stat-label">발표대기</div></div>
    <div class="stat-box"><div class="stat-num">${counts.당첨}</div><div class="stat-label">당첨 🎉</div></div>
    <div class="stat-box"><div class="stat-num">${counts.종료}</div><div class="stat-label">마감/미당첨</div></div>
  `;

  const q = $("survey-search").value.trim().toLowerCase();
  const f = $("survey-filter").value;
  const filtered = cachedSurveys.filter((s) => {
    if (f !== "ALL" && s.status !== f) return false;
    if (!q) return true;
    return [s.no, s.title, s.prize, s.note, s.owner]
      .filter(Boolean)
      .some((v) => String(v).toLowerCase().includes(q));
  });

  const el = $("survey-list");
  if (!filtered.length) {
    el.innerHTML = `<div class="card muted">표시할 설문 항목이 없습니다.</div>`;
    return;
  }
  el.innerHTML = filtered
    .map(
      (s) => `
    <div class="item-card">
      <div class="item-head">
        <div class="item-title">${s.no ? `<span class="muted">${escapeHtml(s.no)}</span> ` : ""}${escapeHtml(s.title)}</div>
        <span class="pill ${surveyPillColor(s.status)}">${escapeHtml(s.status || "진행중")}</span>
      </div>
      <div class="item-meta">
        ${s.prize ? `<span>🎁 ${escapeHtml(s.prize)}</span>` : ""}
        ${s.deadline ? `<span>· 마감 ${escapeHtml(s.deadline)}</span>` : ""}
        ${s.announce ? `<span>· 발표 ${escapeHtml(s.announce)}</span>` : ""}
        ${s.owner ? `<span>· 담당 ${escapeHtml(s.owner)}</span>` : ""}
      </div>
      ${s.note ? `<div class="item-body muted">${escapeHtml(s.note)}</div>` : ""}
      <div class="item-foot">
        <div>${s.url ? `<a href="${escapeHtml(s.url)}" target="_blank" rel="noopener">링크 열기 ↗</a>` : ""}</div>
        <div class="item-actions">
          <select class="status-select" data-survey-status="${s.id}">
            ${["진행중", "발표대기", "당첨", "미당첨", "마감"]
              .map((opt) => `<option value="${opt}" ${s.status === opt ? "selected" : ""}>${opt}</option>`)
              .join("")}
          </select>
          <button class="btn-small btn-danger" data-survey-del="${s.id}">삭제</button>
        </div>
      </div>
    </div>`
    )
    .join("");
}

function blogPillColor(status) {
  if (status === "발행완료") return "green";
  if (status === "예약발행") return "blue";
  if (status === "임시저장") return "orange";
  return "";
}

function renderBlogs() {
  const counts = {
    초안: cachedBlogs.filter((b) => b.status === "초안").length,
    임시저장: cachedBlogs.filter((b) => b.status === "임시저장").length,
    예약발행: cachedBlogs.filter((b) => b.status === "예약발행").length,
    발행완료: cachedBlogs.filter((b) => b.status === "발행완료").length,
  };
  $("blog-stats").innerHTML = `
    <div class="stat-box"><div class="stat-num">${counts.초안}</div><div class="stat-label">초안</div></div>
    <div class="stat-box"><div class="stat-num">${counts.임시저장}</div><div class="stat-label">임시저장</div></div>
    <div class="stat-box"><div class="stat-num">${counts.예약발행}</div><div class="stat-label">예약발행</div></div>
    <div class="stat-box"><div class="stat-num">${counts.발행완료}</div><div class="stat-label">발행완료</div></div>
  `;

  const pf = $("blog-platform-filter").value;
  const sf = $("blog-status-filter").value;
  const filtered = cachedBlogs.filter((b) => {
    if (pf !== "ALL" && b.platform !== pf) return false;
    if (sf !== "ALL" && b.status !== sf) return false;
    return true;
  });

  const el = $("blog-list");
  if (!filtered.length) {
    el.innerHTML = `<div class="card muted">등록된 블로그 글이 없습니다.</div>`;
    return;
  }
  el.innerHTML = filtered
    .map(
      (b) => `
    <div class="item-card">
      <div class="item-head">
        <div class="item-title">
          <span class="pill">${escapeHtml(b.platform)}</span>
          ${escapeHtml(b.title)}
        </div>
        <span class="pill ${blogPillColor(b.status)}">${escapeHtml(b.status)}</span>
      </div>
      <div class="item-meta">
        ${b.date ? `<span>📅 ${escapeHtml(b.date)}</span>` : ""}
        ${b.owner ? `<span>· 작성 ${escapeHtml(b.owner)}</span>` : ""}
      </div>
      ${b.keywords ? `<div class="item-body muted">🏷️ ${escapeHtml(b.keywords)}</div>` : ""}
      <div class="item-foot">
        <div>${b.url ? `<a href="${escapeHtml(b.url)}" target="_blank" rel="noopener">글 보기 ↗</a>` : ""}</div>
        <div class="item-actions">
          <select class="status-select" data-blog-status="${b.id}">
            ${["초안", "임시저장", "예약발행", "발행완료"]
              .map((opt) => `<option value="${opt}" ${b.status === opt ? "selected" : ""}>${opt}</option>`)
              .join("")}
          </select>
          <button class="btn-small btn-danger" data-blog-del="${b.id}">삭제</button>
        </div>
      </div>
    </div>`
    )
    .join("");
}

// Event Listeners
$("pin-form").addEventListener("submit", (e) => {
  e.preventDefault();
  tryUnlock($("pin-input").value);
});

$("lock-btn").addEventListener("click", lockApp);

document.querySelectorAll(".tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
    btn.classList.add("active");
    $(`tab-${btn.dataset.tab}`).classList.add("active");
  });
});

$("memo-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = $("memo-text").value.trim();
  if (!text) return;
  await push(roomRef("memos"), {
    author: $("memo-author").value,
    tag: $("memo-tag").value,
    text,
    done: false,
    createdAt: Date.now(),
  });
  $("memo-text").value = "";
});

$("survey-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const title = $("survey-title").value.trim();
  if (!title) return;
  await push(roomRef("surveys"), {
    no: $("survey-no").value.trim(),
    title,
    prize: $("survey-prize").value.trim(),
    owner: $("survey-owner").value,
    deadline: $("survey-deadline").value.trim(),
    announce: $("survey-announce").value.trim(),
    status: $("survey-status").value,
    url: $("survey-url").value.trim(),
    note: $("survey-note").value.trim(),
    createdAt: Date.now(),
  });
  e.target.reset();
});

$("blog-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const title = $("blog-title").value.trim();
  if (!title) return;
  await push(roomRef("blogs"), {
    platform: $("blog-platform").value,
    status: $("blog-status").value,
    title,
    date: $("blog-date").value.trim(),
    owner: $("blog-owner").value,
    keywords: $("blog-keywords").value.trim(),
    url: $("blog-url").value.trim(),
    createdAt: Date.now(),
  });
  e.target.reset();
});

$("survey-search").addEventListener("input", renderSurveys);
$("survey-filter").addEventListener("change", renderSurveys);
$("blog-platform-filter").addEventListener("change", renderBlogs);
$("blog-status-filter").addEventListener("change", renderBlogs);

document.addEventListener("click", async (e) => {
  const t = e.target;
  if (t.dataset.memoToggle) {
    const done = t.dataset.done === "true";
    await update(roomRef(`memos/${t.dataset.memoToggle}`), { done: !done });
  } else if (t.dataset.memoDel) {
    await remove(roomRef(`memos/${t.dataset.memoDel}`));
  } else if (t.dataset.surveyDel) {
    await remove(roomRef(`surveys/${t.dataset.surveyDel}`));
  } else if (t.dataset.blogDel) {
    await remove(roomRef(`blogs/${t.dataset.blogDel}`));
  } else if (t.dataset.copy) {
    const text = $(t.dataset.copy).textContent;
    await navigator.clipboard.writeText(text);
    t.textContent = "복사됨!";
    setTimeout(() => (t.textContent = "복사"), 1200);
  }
});

document.addEventListener("change", async (e) => {
  const t = e.target;
  if (t.dataset.surveyStatus) {
    await update(roomRef(`surveys/${t.dataset.surveyStatus}`), { status: t.value });
  } else if (t.dataset.blogStatus) {
    await update(roomRef(`blogs/${t.dataset.blogStatus}`), { status: t.value });
  }
});

// 자동 잠금 해제 시도 (세션 유지 시)
const savedPin = sessionStorage.getItem("pickle_office_pin");
if (savedPin) {
  tryUnlock(savedPin);
}
