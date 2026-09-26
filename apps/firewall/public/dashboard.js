// Yakusoku dashboard — vanilla JS, no framework, no build step (WU10).
// Loads GET /receipts + GET /intents once, then applies live SSE events from
// GET /events. Reconnects the SSE stream if it drops.

"use strict";

const USDC_DECIMALS = 6;

// WU13 — the dashboard is the only caller expected to send this header;
// the firewall also requires the request to come from a loopback peer
// (index.ts's `requireLocalAdmin`). Not real auth, just a minimal local-demo
// guard on the pause/resume/revoke endpoints.
const ADMIN_HEADERS = { "x-yakusoku-admin": "1" };

const state = {
  receipts: new Map(), // receiptId -> DecisionReceipt
  intents: new Map(), // intentId -> serialized intent
  approvals: new Map(), // receiptId -> GET /approvals/:id response
  selectedReceiptId: null,
  control: { paused: false }, // GET /control shape
};

const els = {
  connStatus: document.getElementById("conn-status"),
  pauseBadge: document.getElementById("pause-badge"),
  pauseToggle: document.getElementById("pause-toggle"),
  intentsList: document.getElementById("intents-list"),
  rows: document.getElementById("rows"),
  detailEmpty: document.getElementById("detail-empty"),
  detailContent: document.getElementById("detail-content"),
};

// --- small formatting helpers -----------------------------------------------

function escapeHtml(value) {
  if (value === undefined || value === null) return "";
  return String(value).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]));
}

function cssEscapeAttr(value) {
  return window.CSS && CSS.escape ? CSS.escape(value) : value.replace(/["\\]/g, "\\$&");
}

function formatUsdc(atomic) {
  if (atomic === undefined || atomic === null || atomic === "") return "—";
  const n = Number(atomic) / 10 ** USDC_DECIMALS;
  if (Number.isNaN(n)) return "—";
  return `${n.toFixed(2)} USDC`;
}

function shortAddr(addr) {
  if (!addr || addr.length < 10) return addr || "—";
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function resourcePath(url) {
  if (!url) return "—";
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

function formatTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString();
}

function pct(n) {
  if (typeof n !== "number" || Number.isNaN(n)) return "—";
  return `${Math.round(n * 100)}%`;
}

// --- receipt classification --------------------------------------------------

/** Maps a receipt to the badge shown on the "with Yakusoku" lane. */
function classifyReceipt(r) {
  if (r.state === "awaiting_world_id") {
    return { code: "waiting", label: "WAITING FOR HUMAN" };
  }
  if (r.state === "world_id_denied" || r.state === "world_id_expired") {
    return { code: "expired", label: "EXPIRED / DENIED" };
  }
  if (r.verdict === "pay") {
    return { code: "paid", label: "PAID" };
  }
  return { code: "blocked", label: "BLOCKED" };
}

function decidingStage(r) {
  if (!r.timeline || r.timeline.length === 0) return "—";
  return r.timeline[r.timeline.length - 1].stage;
}

function reasonText(r) {
  return (r.reasons && r.reasons[0]) || "";
}

// --- rendering: header intents ------------------------------------------------

function intentCardHtml(i) {
  const revokeControl = i.revoked
    ? `<span class="revoked-badge">REVOKED</span>`
    : `<button class="revoke-btn" data-revoke-intent-id="${escapeHtml(i.id)}">Revoke</button>`;
  return `
      <div class="intent-card${i.revoked ? " revoked" : ""}">
        <div class="intent-task">${escapeHtml(i.message.task)} ${revokeControl}</div>
        <div class="intent-meta">
          <span>budget ${formatUsdc(i.message.budget)}</span>
          <span>remaining ${formatUsdc(i.remainingBudget)}</span>
          <span>signer ${shortAddr(i.signer)}</span>
        </div>
      </div>`;
}

function renderIntents() {
  const intents = [...state.intents.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  if (intents.length === 0) {
    els.intentsList.innerHTML = `<p class="muted">No signed intents yet.</p>`;
    return;
  }
  els.intentsList.innerHTML = intents.map(intentCardHtml).join("");
  els.intentsList.querySelectorAll("[data-revoke-intent-id]").forEach((btn) => {
    btn.addEventListener("click", () => revokeIntent(btn.dataset.revokeIntentId));
  });
}

// --- rendering + actions: kill switch (WU13) ---------------------------------

function renderControl() {
  const paused = Boolean(state.control.paused);
  els.pauseBadge.hidden = !paused;
  els.pauseToggle.disabled = false;
  els.pauseToggle.textContent = paused ? "Resume signing" : "Pause signing";
  els.pauseToggle.classList.toggle("is-paused", paused);
  els.pauseToggle.classList.toggle("is-running", !paused);
  els.pauseToggle.title = paused && state.control.reason ? `Paused: ${state.control.reason}` : "";
}

async function fetchControl() {
  try {
    const res = await fetch("/control", { headers: ADMIN_HEADERS });
    if (!res.ok) return;
    state.control = await res.json();
    renderControl();
  } catch (err) {
    console.error("failed to load control state", err);
  }
}

async function togglePause() {
  els.pauseToggle.disabled = true;
  const paused = Boolean(state.control.paused);
  try {
    const res = await fetch(paused ? "/control/resume" : "/control/pause", {
      method: "POST",
      headers: { ...ADMIN_HEADERS, "content-type": "application/json" },
      body: paused ? undefined : JSON.stringify({ reason: "paused from the dashboard" }),
    });
    if (res.ok) state.control = await res.json();
  } catch (err) {
    console.error("failed to toggle pause", err);
  } finally {
    renderControl();
  }
}

async function revokeIntent(intentId) {
  if (!intentId) return;
  try {
    const res = await fetch(`/intents/${encodeURIComponent(intentId)}/revoke`, {
      method: "POST",
      headers: ADMIN_HEADERS,
    });
    if (!res.ok) return;
    const intent = await res.json();
    state.intents.set(intent.id, intent);
    renderIntents();
  } catch (err) {
    console.error("failed to revoke intent", err);
  }
}

// --- rendering: two-lane timeline --------------------------------------------

function rowHtml(r) {
  const cls = classifyReceipt(r);
  const stage = decidingStage(r);
  const reason = reasonText(r);
  return `
    <div class="row" data-receipt-id="${r.receiptId}">
      <div class="lane lane-left">
        <div class="would-pay">WOULD PAY ${formatUsdc(r.amount)} to ${shortAddr(r.payTo)}</div>
        <div class="would-pay-resource">for ${escapeHtml(resourcePath(r.resourceUrl))}</div>
      </div>
      <div class="lane lane-right">
        <span class="badge badge-${cls.code}">${cls.label}</span>
        <div class="verdict-detail">
          <span class="stage">${escapeHtml(stage)}</span>
          <span class="reason">${escapeHtml(reason)}</span>
        </div>
        <div class="row-time">${formatTime(r.createdAt)}</div>
      </div>
    </div>`;
}

function renderRows() {
  const receipts = [...state.receipts.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  if (receipts.length === 0) {
    els.rows.innerHTML = `<p class="muted">No payment attempts yet — waiting for the agent…</p>`;
    return;
  }
  els.rows.innerHTML = receipts.map(rowHtml).join("");
  els.rows.querySelectorAll(".row").forEach((el) => {
    el.addEventListener("click", () => selectReceipt(el.dataset.receiptId));
  });
  if (state.selectedReceiptId) {
    const el = els.rows.querySelector(`.row[data-receipt-id="${cssEscapeAttr(state.selectedReceiptId)}"]`);
    if (el) el.classList.add("selected");
  }
}

// --- rendering: detail panel --------------------------------------------------

function timelineHtml(r) {
  if (!r.timeline || r.timeline.length === 0) {
    return `<p class="muted">No stages recorded.</p>`;
  }
  const rows = r.timeline
    .map(
      (t) => `
      <tr>
        <td>${escapeHtml(t.stage)}</td>
        <td><span class="outcome outcome-${escapeHtml(t.outcome)}">${escapeHtml(t.outcome)}</span></td>
        <td>${t.ms} ms</td>
        <td>${escapeHtml(t.reason ?? "")}</td>
      </tr>`,
    )
    .join("");
  return `
    <table class="timeline-table">
      <thead><tr><th>Stage</th><th>Outcome</th><th>ms</th><th>Reason</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function jevHtml(jev) {
  if (!jev) return "";
  return `
    <div class="detail-block">
      <h3>Jev — semantic intent match</h3>
      <dl class="kv">
        <dt>Matches intent</dt><dd>${pct(jev.matchesIntent)}</dd>
        <dt>Social engineering</dt><dd>${pct(jev.looksLikeSocialEngineering)}</dd>
        <dt>Untrusted-content source</dt><dd>${pct(jev.paymentSourceIsUntrustedContent)}</dd>
        <dt>Action</dt><dd>${escapeHtml(jev.actionChoice)} (${pct(jev.actionConfidence)} confidence)</dd>
        <dt>Risk</dt><dd>${jev.riskScore} (normalized ${pct(jev.riskNormalized)})</dd>
        <dt>Jev verdict</dt><dd>${escapeHtml(jev.verdict)}</dd>
        <dt>Model</dt><dd>${escapeHtml(jev.model)} · ${jev.latencyMs} ms</dd>
      </dl>
    </div>`;
}

function interceptaHtml(intercepta) {
  if (!intercepta) return "";
  return `
    <div class="detail-block">
      <h3>Intercepta — address/token screening</h3>
      <dl class="kv">
        <dt>Address verdict</dt><dd>${escapeHtml(intercepta.addressVerdict)}${
    typeof intercepta.addressScore === "number" ? ` (score ${intercepta.addressScore})` : ""
  }</dd>
        <dt>Token verdict</dt><dd>${escapeHtml(intercepta.tokenVerdict ?? "—")}</dd>
        <dt>Cached</dt><dd>${intercepta.cached ? "yes" : "no"}</dd>
        <dt>Latency</dt><dd>${intercepta.latencyMs} ms</dd>
      </dl>
    </div>`;
}

function worldIdHtml(r) {
  const relevant =
    r.state === "awaiting_world_id" ||
    r.state === "world_id_denied" ||
    r.state === "world_id_expired" ||
    r.worldId !== undefined;
  if (!relevant) return "";

  if (r.state === "awaiting_world_id") {
    const approval = state.approvals.get(r.receiptId);
    if (!approval) {
      return `<div class="detail-block"><h3>World ID approval</h3><p class="muted">Loading approval details…</p></div>`;
    }
    return `
      <div class="detail-block">
        <h3>World ID approval — waiting for a human</h3>
        <p>Open on the phone that signed in, or scan/open this link:</p>
        <p><a href="${escapeHtml(approval.verificationUri)}" target="_blank" rel="noopener">${escapeHtml(
      approval.verificationUri ?? "—",
    )}</a></p>
        <p class="user-code">${escapeHtml(approval.userCode ?? "—")}</p>
        <p class="muted">Expires ${formatTime(approval.expiresAt)}</p>
      </div>`;
  }

  const label = r.state === "world_id_denied" ? "Denied" : r.state === "world_id_expired" ? "Expired" : r.worldId?.approved ? "Approved" : "—";
  const attestation = r.worldId?.attestation;
  // WU12: a signed StepUp EIP-712 attestation — portable, independently
  // verifiable proof this exact payment was human-approved (not just the
  // firewall's own say-so). Absent on denied/expired/pre-WU12 receipts.
  const attestationHtml = attestation
    ? `<p class="attested">Human approval attested ✓ (signer ${shortAddr(attestation.signer)})</p>
       <p class="muted"><a href="/receipts/${escapeHtml(r.receiptId)}/attestation" target="_blank" rel="noopener">view attestation JSON</a></p>`
    : "";
  return `
    <div class="detail-block">
      <h3>World ID approval</h3>
      <p>${escapeHtml(label)}</p>
      ${attestationHtml}
    </div>`;
}

function settlementHtml(r) {
  if (!r.settlement) return "";
  const url = `https://sepolia.basescan.org/tx/${r.settlement.txHash}`;
  return `
    <div class="detail-block">
      <h3>Settlement</h3>
      <p><a href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(r.settlement.txHash)}</a></p>
      <p class="muted">${escapeHtml(r.settlement.network)} · reported ${formatTime(r.settlement.reportedAt)}</p>
    </div>`;
}

function detailHtml(r) {
  return `
    <div class="detail-header">
      <h2>${escapeHtml(r.receiptId)}</h2>
      <p class="muted">${formatTime(r.createdAt)}</p>
      <p>${escapeHtml(r.task ?? "—")}</p>
      <dl class="kv">
        <dt>Resource</dt><dd>${escapeHtml(r.resourceUrl ?? "—")}</dd>
        <dt>Amount</dt><dd>${formatUsdc(r.amount)}</dd>
        <dt>Pay to</dt><dd>${escapeHtml(r.payTo ?? "—")}</dd>
        <dt>Verdict</dt><dd>${escapeHtml(r.verdict)} (${escapeHtml(r.state)})</dd>
        <dt>Reason</dt><dd>${escapeHtml(reasonText(r))}</dd>
      </dl>
    </div>
    <div class="detail-block">
      <h3>Pipeline timeline</h3>
      ${timelineHtml(r)}
    </div>
    ${jevHtml(r.jev)}
    ${interceptaHtml(r.intercepta)}
    ${worldIdHtml(r)}
    ${settlementHtml(r)}
  `;
}

function renderDetail() {
  const r = state.selectedReceiptId ? state.receipts.get(state.selectedReceiptId) : undefined;
  if (!r) {
    els.detailEmpty.hidden = false;
    els.detailContent.hidden = true;
    return;
  }
  els.detailEmpty.hidden = true;
  els.detailContent.hidden = false;
  els.detailContent.innerHTML = detailHtml(r);
  if (r.state === "awaiting_world_id" && !state.approvals.has(r.receiptId)) {
    fetchApproval(r.receiptId);
  }
}

function selectReceipt(receiptId) {
  state.selectedReceiptId = receiptId;
  renderRows();
  renderDetail();
}

// --- data loading --------------------------------------------------------------

async function fetchApproval(receiptId) {
  try {
    // WU-P1: /approvals/:receiptId now requires either the agent's own
    // mandate key or (as here) the local-admin identity the dashboard
    // already uses for pause/resume/revoke.
    const res = await fetch(`/approvals/${receiptId}`, { headers: ADMIN_HEADERS });
    if (!res.ok) return;
    const data = await res.json();
    state.approvals.set(receiptId, data);
    if (state.selectedReceiptId === receiptId) renderDetail();
  } catch (err) {
    console.error("failed to load approval detail", err);
  }
}

async function refreshIntents() {
  try {
    const res = await fetch("/intents");
    if (!res.ok) return;
    const intents = await res.json();
    state.intents = new Map(intents.map((i) => [i.id, i]));
    renderIntents();
  } catch (err) {
    console.error("failed to refresh intents", err);
  }
}

async function loadInitial() {
  const [receiptsRes, intentsRes] = await Promise.all([fetch("/receipts?limit=50"), fetch("/intents")]);
  if (receiptsRes.ok) {
    const receipts = await receiptsRes.json();
    for (const r of receipts) state.receipts.set(r.receiptId, r);
  }
  if (intentsRes.ok) {
    const intents = await intentsRes.json();
    for (const i of intents) state.intents.set(i.id, i);
  }
  renderIntents();
  renderRows();
  renderDetail();
  await fetchControl();
}

// --- live updates (SSE) ---------------------------------------------------------

let eventSource = null;
let reconnectTimer = null;

function setConnStatus(status) {
  const labels = {
    connecting: "connecting…",
    connected: "connected",
    disconnected: "disconnected — retrying…",
  };
  els.connStatus.textContent = labels[status] ?? status;
  els.connStatus.className = `status status-${status}`;
}

function upsertReceipt(receipt) {
  state.receipts.set(receipt.receiptId, receipt);
  renderRows();
  if (state.selectedReceiptId === receipt.receiptId) renderDetail();
}

function connectSSE() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  setConnStatus("connecting");
  eventSource = new EventSource("/events");

  eventSource.addEventListener("open", () => setConnStatus("connected"));

  eventSource.addEventListener("error", () => {
    setConnStatus("disconnected");
    if (eventSource) eventSource.close();
    if (!reconnectTimer) {
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connectSSE();
      }, 2000);
    }
  });

  eventSource.addEventListener("intent.created", (evt) => {
    const intent = JSON.parse(evt.data);
    state.intents.set(intent.id, intent);
    renderIntents();
  });

  eventSource.addEventListener("decision", (evt) => {
    upsertReceipt(JSON.parse(evt.data));
    refreshIntents();
  });

  eventSource.addEventListener("settlement.reported", (evt) => {
    upsertReceipt(JSON.parse(evt.data));
  });

  eventSource.addEventListener("approval.requested", (evt) => {
    const data = JSON.parse(evt.data);
    state.approvals.set(data.receiptId, data);
    if (state.selectedReceiptId === data.receiptId) renderDetail();
  });

  eventSource.addEventListener("approval.resolved", (evt) => {
    const data = JSON.parse(evt.data);
    if (state.selectedReceiptId === data.receiptId) renderDetail();
  });

  eventSource.addEventListener("control.changed", (evt) => {
    state.control = JSON.parse(evt.data);
    renderControl();
  });

  eventSource.addEventListener("intent.revoked", (evt) => {
    const intent = JSON.parse(evt.data);
    state.intents.set(intent.id, intent);
    renderIntents();
  });
}

// --- bootstrap -----------------------------------------------------------------

els.pauseToggle.addEventListener("click", togglePause);

loadInitial()
  .catch((err) => console.error("failed to load initial dashboard data", err))
  .finally(connectSSE);
