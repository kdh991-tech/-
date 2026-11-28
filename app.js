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
let cachedMemos = [];
let editingMemoId = null;
let replyingMemoId = null;
let cachedImages = [];
let cachedDrafts = [];
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
  $("api-images-example").textContent =
    `GET ${baseUrl}/images.json  (각 항목의 dataUrl을 base64 디코딩하여 파일 저장)`;
  $("api-drafts-example").textContent =
    `POST ${baseUrl}/drafts.json  {"author":"구구","platform":"티스토리","title":"제목","filename":"post.md","content":"본문...","status":"검수대기"}`;

  // 1. 메모 실시간 구독
  unsubs.push(
    onValue(roomRef("memos"), (snap) => {
      const val = snap.val() || {};
      cachedMemos = Object.entries(val)
        .map(([id, item]) => ({ id, ...item }))
        .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      renderMemos();
    })
  );

  // 1-2. 이미지 실시간 구독
  unsubs.push(
    onValue(roomRef("images"), (snap) => {
      const val = snap.val() || {};
      cachedImages = Object.entries(val)
        .map(([id, item]) => ({ id, ...item }))
        .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      renderImages();
    })
  );

  // 1-3. 초안·파일 실시간 구독
  unsubs.push(
    onValue(roomRef("drafts"), (snap) => {
      const val = snap.val() || {};
      cachedDrafts = Object.entries(val)
        .map(([id, item]) => ({ id, ...item }))
        .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      renderDrafts();
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

function renderMemos() {
  const el = $("memo-list");
  if (!cachedMemos.length) {
    el.innerHTML = `<div class="card muted">아직 등록된 메모가 없어요. 첫 메모를 남겨보세요!</div>`;
    return;
  }
  el.innerHTML = cachedMemos
    .map((m) => {
      const isEditing = editingMemoId === m.id;
      const isReplying = replyingMemoId === m.id;
      const replies = Object.entries(m.replies || {})
        .map(([rid, r]) => ({ rid, ...r }))
        .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
      return `
    <div class="item-card ${m.done ? "is-done" : ""}">
      <div class="item-head">
        <div>
          <span class="pill ${m.tag === "지시" ? "orange" : m.tag === "보고" ? "green" : "blue"}">${escapeHtml(m.tag || "전달")}</span>
          <strong>${escapeHtml(m.author || "비서")}</strong>
        </div>
        <span class="muted">${formatTime(m.createdAt)}${m.updatedAt ? " (수정됨)" : ""}</span>
      </div>
      ${
        isEditing
          ? `
        <div class="memo-edit-box">
          <select id="memo-edit-tag-${m.id}">
            ${["전달", "지시", "보고", "아이디어"]
              .map((tag) => `<option value="${tag}" ${m.tag === tag ? "selected" : ""}>${tag}</option>`)
              .join("")}
          </select>
          <textarea id="memo-edit-text-${m.id}" rows="3">${escapeHtml(m.text)}</textarea>
          <div class="memo-edit-actions">
            <button type="button" class="btn-small" data-memo-cancel="${m.id}">취소</button>
            <button type="button" class="btn-primary" style="padding:5px 12px;font-size:12px;" data-memo-save="${m.id}">저장</button>
          </div>
        </div>`
          : `
        <div class="item-body">${escapeHtml(m.text)}</div>
        <div class="item-foot">
          <span></span>
          <div class="item-actions">
            <button class="btn-small" data-reply-open="${m.id}">💬 답글${replies.length ? ` (${replies.length})` : ""}</button>
            <button class="btn-small" data-memo-edit="${m.id}">✏️ 수정</button>
            <button class="btn-small" data-memo-toggle="${m.id}" data-done="${Boolean(m.done)}">
              ${m.done ? "↩️ 다시 열기" : "✔️ 확인 완료"}
            </button>
            <button class="btn-small btn-danger" data-memo-del="${m.id}">삭제</button>
          </div>
        </div>`
      }
      ${
        replies.length
          ? `<div class="memo-replies">
              ${replies
                .map(
                  (r) => `
                <div class="reply-item">
                  <div class="reply-head">
                    <span><strong>${escapeHtml(r.author || "비서")}</strong> <span class="muted">${formatTime(r.createdAt)}</span></span>
                    <button type="button" class="reply-del-btn" data-reply-del="${m.id}/${r.rid}" title="답글 삭제">✕</button>
                  </div>
                  <div class="reply-text">${escapeHtml(r.text)}</div>
                </div>`
                )
                .join("")}
            </div>`
          : ""
      }
      ${
        isReplying
          ? `<div class="reply-form-box">
              <div class="reply-form-row">
                <select id="reply-author-${m.id}">
                  <option value="도형님" selected>👤 도형님</option>
                  <option value="비글">🐶 비글 (실장)</option>
                  <option value="피구">📱 피구 (대리)</option>
                  <option value="키루루">🔑 키루루 (사원)</option>
                  <option value="쿠링">🔔 쿠링 (사원)</option>
                  <option value="구구">🕊️ 구구 (인턴)</option>
                  <option value="꼬붕">🐣 꼬붕 (신입)</option>
                </select>
                <input id="reply-text-${m.id}" type="text" placeholder="답글을 입력하세요..." />
              </div>
              <div class="memo-edit-actions">
                <button type="button" class="btn-small" data-reply-cancel="${m.id}">취소</button>
                <button type="button" class="btn-primary" style="padding:5px 12px;font-size:12px;" data-reply-save="${m.id}">답글 등록</button>
              </div>
            </div>`
          : ""
      }
    </div>`;
    })
    .join("");
}

function renderImages() {
  const el = $("image-list");
  if (!cachedImages.length) {
    el.innerHTML = `<div class="card muted" style="grid-column:1/-1;">아직 올라온 이미지가 없어요. 사진을 올려 비서들과 공유해 보세요!</div>`;
    return;
  }
  el.innerHTML = cachedImages
    .map(
      (img) => `
    <div class="image-card">
      <div class="image-thumb-wrap" data-image-open="${img.id}" title="클릭하여 원본 보기">
        <img class="image-thumb" src="${img.dataUrl}" alt="${escapeHtml(img.caption || img.filename || "공유 이미지")}" />
      </div>
      <div class="image-info">
        <div class="image-caption">${escapeHtml(img.caption || img.filename || "제목 없음")}</div>
        <div class="image-meta">
          ${escapeHtml(img.author || "도형님")} · ${formatTime(img.createdAt)}
          ${img.width && img.height ? ` · ${img.width}×${img.height}` : ""}
          ${img.sizeKB ? ` · ${img.sizeKB}KB` : ""}
        </div>
        <div class="image-actions">
          <a class="btn-small btn-download" href="${img.dataUrl}" download="${escapeHtml(img.filename || `image_${img.id}.jpg`)}">⬇️ 다운로드</a>
          <button type="button" class="btn-small btn-danger" data-image-del="${img.id}">삭제</button>
        </div>
      </div>
    </div>`
    )
    .join("");
}

function compressImageToDataUrl(file, maxSide = 1280, quality = 0.85) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = reject;
    reader.onload = () => {
      const img = new Image();
      img.onerror = reject;
      img.onload = () => {
        let { width, height } = img;
        if (width > maxSide || height > maxSide) {
          if (width >= height) {
            height = Math.round((height * maxSide) / width);
            width = maxSide;
          } else {
            width = Math.round((width * maxSide) / height);
            height = maxSide;
          }
        }
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, width, height);
        const dataUrl = canvas.toDataURL("image/jpeg", quality);
        const sizeKB = Math.round((dataUrl.length * 3) / 4 / 1024);
        const baseName = file.name.replace(/\.[^.]+$/, "");
        resolve({
          dataUrl,
          width,
          height,
          sizeKB,
          filename: `${baseName}.jpg`,
        });
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

function draftPillColor(status) {
  if (status === "반영완료") return "green";
  if (status === "검수완료") return "blue";
  if (status === "검수대기") return "orange";
  if (status === "수정필요") return "red";
  return "";
}

function renderDrafts() {
  const q = $("draft-search").value.trim().toLowerCase();
  const pf = $("draft-platform-filter").value;
  const sf = $("draft-status-filter").value;
  const filtered = cachedDrafts.filter((d) => {
    if (pf !== "ALL" && d.platform !== pf) return false;
    if (sf !== "ALL" && d.status !== sf) return false;
    if (!q) return true;
    return [d.title, d.author, d.filename, d.keywords, d.content]
      .filter(Boolean)
      .some((v) => String(v).toLowerCase().includes(q));
  });

  const el = $("draft-list");
  if (!filtered.length) {
    el.innerHTML = `<div class="card muted">등록된 초안이나 파일이 없습니다.</div>`;
    return;
  }

  el.innerHTML = filtered
    .map((d) => {
      const hasContent = Boolean(d.content);
      const hasFile = Boolean(d.content || d.dataUrl);
      const lineCount = hasContent ? d.content.split(/\r?\n/).length : 0;
      const charCount = hasContent ? d.content.length : 0;
      return `
    <div class="item-card">
      <div class="item-head">
        <div class="item-title">
          <span class="pill">${escapeHtml(d.platform || "기타")}</span>
          ${escapeHtml(d.title || d.filename || "제목 없음")}
        </div>
        <span class="pill ${draftPillColor(d.status)}">${escapeHtml(d.status || "검수대기")}</span>
      </div>
      <div class="item-meta">
        <span>${escapeHtml(d.author || "비서")} · ${formatTime(d.createdAt)}</span>
        ${d.filename ? `<span class="draft-file-badge">📄 ${escapeHtml(d.filename)}${d.sizeKB ? ` (${d.sizeKB}KB)` : ""}</span>` : ""}
      </div>
      ${d.keywords ? `<div class="item-body muted">🏷️ ${escapeHtml(d.keywords)}</div>` : ""}
      ${
        hasContent
          ? `<details class="draft-preview">
              <summary>본문 미리보기 (${charCount.toLocaleString()}자 · ${lineCount}줄)</summary>
              <pre>${escapeHtml(d.content)}</pre>
            </details>`
          : ""
      }
      <div class="item-foot">
        <div class="item-actions">
          ${hasContent ? `<button type="button" class="btn-small" data-draft-copy="${d.id}">📋 원문 복사</button>` : ""}
          ${hasFile ? `<button type="button" class="btn-small" data-draft-download="${d.id}">⬇️ 다운로드</button>` : ""}
        </div>
        <div class="item-actions">
          <select class="status-select" data-draft-status="${d.id}">
            ${["검수대기", "수정필요", "검수완료", "반영완료"]
              .map((opt) => `<option value="${opt}" ${d.status === opt ? "selected" : ""}>${opt}</option>`)
              .join("")}
          </select>
          <button type="button" class="btn-small btn-danger" data-draft-del="${d.id}">삭제</button>
        </div>
      </div>
    </div>`;
    })
    .join("");
}

function isTextDraftFile(file) {
  const name = (file.name || "").toLowerCase();
  if (/\.(md|txt|html|htm|csv|json|xml|yaml|yml|log)$/.test(name)) return true;
  return (file.type || "").startsWith("text/");
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = reject;
    reader.onload = () => resolve(reader.result);
    reader.readAsDataURL(file);
  });
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

$("image-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const files = Array.from($("image-file").files || []);
  if (!files.length) return;
  const author = $("image-author").value;
  const caption = $("image-caption").value.trim();
  const statusEl = $("image-upload-status");
  const btn = $("image-submit-btn");

  btn.disabled = true;
  try {
    for (let i = 0; i < files.length; i++) {
      statusEl.textContent = `업로드 중... (${i + 1}/${files.length})`;
      const converted = await compressImageToDataUrl(files[i]);
      await push(roomRef("images"), {
        author,
        caption: files.length > 1 && caption ? `${caption} (${i + 1}/${files.length})` : caption,
        filename: converted.filename,
        width: converted.width,
        height: converted.height,
        sizeKB: converted.sizeKB,
        dataUrl: converted.dataUrl,
        createdAt: Date.now(),
      });
    }
    $("image-file").value = "";
    $("image-caption").value = "";
    statusEl.textContent = `${files.length}장 업로드 완료!`;
    setTimeout(() => {
      statusEl.textContent = "";
    }, 2500);
  } catch (err) {
    console.error(err);
    statusEl.textContent = "이미지 업로드에 실패했습니다.";
  } finally {
    btn.disabled = false;
  }
});

$("draft-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const title = $("draft-title").value.trim();
  const textInput = $("draft-content").value.trim();
  const file = ($("draft-file").files || [])[0];
  const statusEl = $("draft-upload-status");
  const btn = $("draft-submit-btn");

  if (!title) return;
  if (!file && !textInput) {
    statusEl.textContent = "파일을 첨부하거나 초안 본문을 입력해 주세요.";
    return;
  }

  btn.disabled = true;
  statusEl.textContent = "등록 중...";
  try {
    let filename = "";
    let mimeType = "text/markdown";
    let sizeKB = 0;
    let content = textInput;
    let dataUrl = "";

    if (file) {
      if (file.size > 3 * 1024 * 1024) {
        statusEl.textContent = "파일 크기는 3MB 이하만 올릴 수 있어요.";
        btn.disabled = false;
        return;
      }
      filename = file.name;
      mimeType = file.type || "application/octet-stream";
      sizeKB = Math.max(1, Math.round(file.size / 1024));
      if (isTextDraftFile(file)) {
        const fileText = await file.text();
        content = textInput ? `${textInput}\n\n${fileText}` : fileText;
      } else {
        dataUrl = await readFileAsDataUrl(file);
      }
    } else {
      const safeTitle = title.replace(/[\\/:*?"<>|]/g, "_").slice(0, 40) || "draft";
      filename = `${safeTitle}.md`;
      sizeKB = Math.max(1, Math.round(new Blob([content]).size / 1024));
    }

    await push(roomRef("drafts"), {
      author: $("draft-author").value,
      platform: $("draft-platform").value,
      title,
      keywords: $("draft-keywords").value.trim(),
      filename,
      mimeType,
      sizeKB,
      content: content || "",
      dataUrl: dataUrl || "",
      status: "검수대기",
      createdAt: Date.now(),
    });

    e.target.reset();
    statusEl.textContent = "등록 완료!";
    setTimeout(() => {
      statusEl.textContent = "";
    }, 2500);
  } catch (err) {
    console.error(err);
    statusEl.textContent = "초안/파일 등록에 실패했습니다.";
  } finally {
    btn.disabled = false;
  }
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

$("draft-search").addEventListener("input", renderDrafts);
$("draft-platform-filter").addEventListener("change", renderDrafts);
$("draft-status-filter").addEventListener("change", renderDrafts);
$("survey-search").addEventListener("input", renderSurveys);
$("survey-filter").addEventListener("change", renderSurveys);
$("blog-platform-filter").addEventListener("change", renderBlogs);
$("blog-status-filter").addEventListener("change", renderBlogs);

document.addEventListener("click", async (e) => {
  const t = e.target;
  const openWrap = t.closest("[data-image-open]");
  if (openWrap) {
    const img = cachedImages.find((item) => item.id === openWrap.dataset.imageOpen);
    if (img) {
      const win = window.open();
      if (win) {
        win.document.write(
          `<title>${escapeHtml(img.filename || "image")}</title><body style="margin:0;background:#111;display:flex;align-items:center;justify-content:center;min-height:100vh;"><img src="${img.dataUrl}" style="max-width:100%;max-height:100vh;" /></body>`
        );
      }
    }
    return;
  }
  if (t.dataset.replyOpen) {
    replyingMemoId = replyingMemoId === t.dataset.replyOpen ? null : t.dataset.replyOpen;
    renderMemos();
  } else if (t.dataset.replyCancel) {
    replyingMemoId = null;
    renderMemos();
  } else if (t.dataset.replySave) {
    const id = t.dataset.replySave;
    const text = $(`reply-text-${id}`).value.trim();
    const author = $(`reply-author-${id}`).value;
    if (!text) return;
    await push(roomRef(`memos/${id}/replies`), {
      author,
      text,
      createdAt: Date.now(),
    });
    replyingMemoId = null;
  } else if (t.dataset.replyDel) {
    await remove(roomRef(`memos/${t.dataset.replyDel}`));
  } else if (t.dataset.memoEdit) {
    editingMemoId = t.dataset.memoEdit;
    renderMemos();
  } else if (t.dataset.memoCancel) {
    editingMemoId = null;
    renderMemos();
  } else if (t.dataset.memoSave) {
    const id = t.dataset.memoSave;
    const newText = $(`memo-edit-text-${id}`).value.trim();
    const newTag = $(`memo-edit-tag-${id}`).value;
    if (!newText) return;
    await update(roomRef(`memos/${id}`), {
      tag: newTag,
      text: newText,
      updatedAt: Date.now(),
    });
    editingMemoId = null;
  } else if (t.dataset.memoToggle) {
    const done = t.dataset.done === "true";
    await update(roomRef(`memos/${t.dataset.memoToggle}`), { done: !done });
  } else if (t.dataset.memoDel) {
    await remove(roomRef(`memos/${t.dataset.memoDel}`));
  } else if (t.dataset.imageDel) {
    await remove(roomRef(`images/${t.dataset.imageDel}`));
  } else if (t.dataset.draftCopy) {
    const d = cachedDrafts.find((item) => item.id === t.dataset.draftCopy);
    if (d && d.content) {
      await navigator.clipboard.writeText(d.content);
      t.textContent = "복사됨!";
      setTimeout(() => (t.textContent = "📋 원문 복사"), 1200);
    }
  } else if (t.dataset.draftDownload) {
    const d = cachedDrafts.find((item) => item.id === t.dataset.draftDownload);
    if (d) {
      const a = document.createElement("a");
      if (d.dataUrl) {
        a.href = d.dataUrl;
      } else if (d.content) {
        const blob = new Blob([d.content], { type: d.mimeType || "text/plain;charset=utf-8" });
        a.href = URL.createObjectURL(blob);
      }
      a.download = d.filename || `draft_${d.id}.md`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      if (!d.dataUrl && a.href) setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    }
  } else if (t.dataset.draftDel) {
    await remove(roomRef(`drafts/${t.dataset.draftDel}`));
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
  } else if (t.dataset.draftStatus) {
    await update(roomRef(`drafts/${t.dataset.draftStatus}`), { status: t.value });
  }
});

// 자동 잠금 해제 시도 (세션 유지 시)
const savedPin = sessionStorage.getItem("pickle_office_pin");
if (savedPin) {
  tryUnlock(savedPin);
}
