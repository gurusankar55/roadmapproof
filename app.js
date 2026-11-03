// RoadmapProof frontend — talks to the RoadmapProof Intelligent Contract on GenLayer Studionet.
import { createClient, createAccount, generatePrivateKey } from "https://esm.sh/genlayer-js@latest";
import { studionet } from "https://esm.sh/genlayer-js@latest/chains";

// Paste your deployed contract address here (or in the yellow box on the page).
const DEFAULT_CONTRACT = "0x13DCb5fE3EF0D349291fFfCB6F67a5ADDC461c10";

const $ = (id) => document.getElementById(id);
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};

let CONTRACT = DEFAULT_CONTRACT || store.get("rp_contract");
let client, accountLabel;
let promises = [];
let filter = "ALL";

// ---------- wallet ----------
function useBurner() {
  let pk = store.get("rp_burner");
  if (!pk) { pk = generatePrivateKey(); store.set("rp_burner", pk); }
  const account = createAccount(pk);
  client = createClient({ chain: studionet, account });
  accountLabel = short(account.address) + " (browser key)";
  $("acct").innerHTML = "<b>" + accountLabel + "</b>";
}

async function useMetaMask() {
  if (!window.ethereum) { alert("MetaMask is not installed. The page will keep using the browser key."); return; }
  try {
    const [addr] = await window.ethereum.request({ method: "eth_requestAccounts" });
    client = createClient({ chain: studionet, account: addr });
    try { await client.connect("studionet"); } catch {}
    accountLabel = short(addr) + " (MetaMask)";
    $("acct").innerHTML = "<b>" + accountLabel + "</b>";
    $("connectBtn").textContent = "MetaMask connected";
  } catch (e) { toastError("MetaMask connection was rejected."); }
}

// ---------- helpers ----------
const short = (a) => a ? a.slice(0, 6) + "…" + a.slice(-4) : "";
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
function toWei(gen) {
  const [i, f = ""] = String(gen || "0").split(".");
  return BigInt(i || "0") * 10n ** 18n + BigInt((f + "0".repeat(18)).slice(0, 18));
}
function fromWei(w) {
  const v = BigInt(w || "0");
  const whole = v / 10n ** 18n, frac = (v % 10n ** 18n).toString().padStart(18, "0").slice(0, 2);
  return frac === "00" ? whole.toString() : `${whole}.${frac}`;
}
const parse = (r) => { try { return typeof r === "string" ? JSON.parse(r) : r; } catch { return null; } };

async function read(fn, args = []) {
  return parse(await client.readContract({ address: CONTRACT, functionName: fn, args }));
}

// ---------- transaction lifecycle ----------
const ORDER = ["SIGN", "PENDING", "PROPOSING", "ACCEPTED", "FINALIZED"];
const FAIL = ["UNDETERMINED", "CANCELED", "LEADER_TIMEOUT", "VALIDATORS_TIMEOUT"];
function setStage(stage, failed = false) {
  const idx = ORDER.indexOf(stage);
  document.querySelectorAll("#txSteps li").forEach((li, i) => {
    li.className = failed && i === Math.max(idx, 1) ? "fail" : i < idx ? "done" : i === idx ? (stage === "FINALIZED" ? "done" : "now") : "";
  });
}
function mapStatus(name) {
  name = String(name || "").toUpperCase();
  if (FAIL.includes(name)) return { stage: "PROPOSING", failed: true };
  if (["COMMITTING", "REVEALING", "PROPOSING"].includes(name)) return { stage: "PROPOSING" };
  if (name.startsWith("APPEAL")) return { stage: "ACCEPTED" };
  if (ORDER.includes(name)) return { stage: name };
  return { stage: "PENDING" };
}

async function sendTx(title, fn, args) {
  const tx = $("tx");
  $("txTitle").textContent = title;
  $("txHash").textContent = "Waiting for signature…";
  $("txResult").textContent = "";
  tx.classList.add("show");
  setStage("SIGN");
  document.querySelector('#txSteps li[data-s="SIGN"]').className = "now";

  let hash;
  try {
    hash = await client.writeContract({ address: CONTRACT, functionName: fn, args, value: 0n });
  } catch (e) {
    setStage("SIGN", true);
    $("txResult").textContent = "Not sent: " + (e.shortMessage || e.message || e);
    return null;
  }
  $("txHash").textContent = hash;
  setStage("PENDING");

  for (let i = 0; i < 180; i++) {
    await new Promise((r) => setTimeout(r, 2500));
    let t;
    try { t = await client.getTransaction({ hash }); } catch { continue; }
    const name = t?.statusName || t?.status_name || t?.status;
    const { stage, failed } = mapStatus(name);
    setStage(stage, failed);
    if (failed) { $("txResult").textContent = "Validators could not agree (" + name + "). You can try again."; return null; }
    if (stage === "ACCEPTED" || stage === "FINALIZED") {
      $("txResult").textContent = stage === "FINALIZED" ? "Finalized." : "Consensus reached. Finalization follows after the appeal window.";
      await refresh();
      if (stage === "FINALIZED") return t;
      // keep watching for finalization in the background
      watchFinal(hash);
      return t;
    }
  }
  $("txResult").textContent = "Still processing. Check again in a minute.";
  return null;
}
async function watchFinal(hash) {
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    try {
      const t = await client.getTransaction({ hash });
      const name = String(t?.statusName || t?.status || "").toUpperCase();
      if (name === "FINALIZED") { setStage("FINALIZED"); $("txResult").textContent = "Finalized."; refresh(); return; }
    } catch {}
  }
}
function toastError(msg) {
  $("txTitle").textContent = "Something needs fixing";
  $("txHash").textContent = "";
  $("txResult").textContent = msg;
  document.querySelectorAll("#txSteps li").forEach((li) => (li.className = ""));
  $("tx").classList.add("show");
}

// ---------- rendering ----------
function render() {
  const q = $("search").value.trim().toLowerCase();
  const rows = promises.filter((p) => (filter === "ALL" || p.status === filter) && (!q || p.project.toLowerCase().includes(q)));
  if (!CONTRACT) { $("list").innerHTML = '<div class="empty">Set the contract address above to load the ledger.</div>'; return; }
  if (!rows.length) {
    $("list").innerHTML = `<div class="empty">${promises.length ? "No promises match this filter." : "No promises yet. Make the first one with the form."}</div>`;
    return;
  }
  const today = new Date().toISOString().slice(0, 10);
  $("list").innerHTML = rows.map((p) => {
    const due = p.deadline < today ? "Deadline passed" : "Due";
    const verify = p.status === "PENDING" ? `<div class="actions"><button class="btn small go" data-verify="${esc(p.id)}">Verify now</button></div>` : "";
    return `<article class="promise ${esc(p.status)}">
      <span class="stamp">${esc(p.status)}</span>
      <div class="proj">${esc(p.project)}</div>
      <div class="claim">${esc(p.claim)}</div>
      <div class="meta"><span>${due} <b>${esc(p.deadline)}</b></span><span>By <b>${esc(short(p.creator))}</b></span><span>Checks <b>${p.checks}</b></span>
        <a href="${esc(p.evidence_url)}" target="_blank" rel="noopener">Evidence page</a></div>
      ${p.reason ? `<div class="reason">${esc(p.reason)}</div>` : ""}
      ${verify}
    </article>`;
  }).join("");
}

function renderBoard(rows) {
  rows = (rows || []).filter((r) => r.kept + r.broken > 0);
  if (!rows.length) { $("board").innerHTML = '<div class="empty">A project gets a score after its first promise is resolved.</div>'; return; }
  $("board").innerHTML = rows.map((r) => {
    const total = r.kept + r.broken + r.pending;
    const color = r.score >= 70 ? "var(--kept)" : r.score >= 40 ? "var(--pending)" : "var(--broken)";
    return `<div class="lb-row"><div class="name">${esc(r.project)}</div>
      <div class="meter" aria-label="${r.kept} kept, ${r.broken} broken, ${r.pending} pending">
        <i style="width:${(r.kept / total) * 100}%;background:var(--kept)"></i>
        <i style="width:${(r.broken / total) * 100}%;background:var(--broken)"></i>
        <i style="width:${(r.pending / total) * 100}%;background:var(--pending)"></i></div>
      <div class="score" style="color:${color}">${r.score}%</div></div>`;
  }).join("");
}

async function refresh() {
  if (!CONTRACT) { $("setup").classList.add("show"); render(); return; }
  $("setup").classList.remove("show");
  $("addrLink").textContent = short(CONTRACT);
  $("addrLink").href = "https://explorer-studio.genlayer.com/address/" + CONTRACT;
  try {
    const [list, stats, board] = await Promise.all([read("get_promises"), read("get_stats"), read("get_leaderboard")]);
    promises = list || [];
    if (stats) {
      $("sKept").textContent = stats.kept; $("sBroken").textContent = stats.broken;
      $("sPending").textContent = stats.pending; $("sBond").textContent = stats.total_checks;
    }
    renderBoard(board);
    render();
  } catch (e) {
    $("list").innerHTML = `<div class="empty">Could not read the contract. Check the address is a RoadmapProof contract on Studionet.<br><small>${esc(e.shortMessage || e.message)}</small></div>`;
  }
}

// ---------- events ----------
$("form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!CONTRACT) { toastError("Set the contract address first (yellow box)."); return; }
  const btn = $("submitBtn"); btn.disabled = true;
  const args = [$("fProject").value.trim(), $("fClaim").value.trim(), $("fUrl").value.trim(), $("fDeadline").value];
  const ok = await sendTx("Locking your promise", "create_promise", args);
  if (ok) $("form").reset();
  btn.disabled = false;
});

$("list").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-verify]");
  if (!b) return;
  b.disabled = true; b.textContent = "Validators are reading…";
  await sendTx("Verifying promise #" + b.dataset.verify, "verify_promise", [b.dataset.verify]);
  b.disabled = false; b.textContent = "Verify now";
});

document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => {
  filter = t.dataset.f;
  document.querySelectorAll(".tab").forEach((x) => x.setAttribute("aria-pressed", String(x === t)));
  render();
}));
$("search").addEventListener("input", render);
$("txClose").addEventListener("click", () => $("tx").classList.remove("show"));
$("connectBtn").addEventListener("click", useMetaMask);
$("addrInput").addEventListener("change", (e) => {
  const v = e.target.value.trim();
  if (/^0x[0-9a-fA-F]{40}$/.test(v)) { CONTRACT = v; store.set("rp_contract", v); refresh(); }
  else toastError("That does not look like a contract address (0x + 40 characters).");
});

const d = new Date(); d.setDate(d.getDate() + 30);
$("fDeadline").value = d.toISOString().slice(0, 10);
$("fDeadline").min = new Date().toISOString().slice(0, 10);

useBurner();
refresh();
setInterval(refresh, 30000);
