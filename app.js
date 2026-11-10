// RoadmapProof v2 frontend — talks to the RoadmapProof v2 Intelligent Contract on GenLayer Studionet.
import { createClient, createAccount, generatePrivateKey } from "https://esm.sh/genlayer-js@latest";
import { studionet } from "https://esm.sh/genlayer-js@latest/chains";

// Paste your deployed v2 contract address between the quotes (or in the yellow box on the page).
const DEFAULT_CONTRACT = "0x9b5D8f6155ad7578Db16B452de3aaD0E7fB7D467";

const $ = (id) => document.getElementById(id);
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};

const isAddr = (v) => /^0x[0-9a-fA-F]{40}$/.test(String(v || ""));
let CONTRACT = isAddr(DEFAULT_CONTRACT) ? DEFAULT_CONTRACT : (isAddr(store.get("rp_contract")) ? store.get("rp_contract") : "");
let client, accountLabel, myAddr = "";
let promises = [];
let projects = {};
let filter = "ALL";

// ---------- wallet ----------
function useBurner() {
  let pk = store.get("rp_burner");
  if (!pk) { pk = generatePrivateKey(); store.set("rp_burner", pk); }
  const account = createAccount(pk);
  client = createClient({ chain: studionet, account });
  myAddr = account.address.toLowerCase();
  accountLabel = short(account.address) + " (browser key)";
  $("acct").innerHTML = "<b>" + accountLabel + "</b>";
}

// Every installed wallet extension announces itself (EIP-6963), so we can
// show a picker (Rabby, MetaMask, OKX, …) like other GenLayer apps.
const announced = [];
window.addEventListener("eip6963:announceProvider", (e) => {
  const d = e.detail;
  if (d && d.info && !announced.find((x) => x.info.uuid === d.info.uuid)) announced.push(d);
});
window.dispatchEvent(new Event("eip6963:requestProvider"));

const STUDIO_CHAIN = {
  chainId: "0x" + (61999).toString(16),
  chainName: "GenLayer Studio",
  nativeCurrency: { name: "GEN", symbol: "GEN", decimals: 18 },
  rpcUrls: ["https://studio.genlayer.com/api"],
  blockExplorerUrls: ["https://explorer-studio.genlayer.com"],
};

async function switchNetwork(provider) {
  try {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: STUDIO_CHAIN.chainId }] });
  } catch (e) {
    if (e && (e.code === 4902 || String(e.message || "").includes("Unrecognized"))) {
      await provider.request({ method: "wallet_addEthereumChain", params: [STUDIO_CHAIN] });
    } else throw e;
  }
}

function openWalletPicker() {
  window.dispatchEvent(new Event("eip6963:requestProvider"));
  setTimeout(() => {
    const list = announced.slice();
    if (!list.length && window.ethereum) {
      list.push({ info: { name: "Browser wallet", icon: "", rdns: "injected", uuid: "injected" }, provider: window.ethereum });
    }
    $("wmList").innerHTML = list.length
      ? list.map((d, i) => `<button class="wm-item" data-i="${i}">${d.info.icon ? `<img src="${esc(d.info.icon)}" alt="">` : '<span class="wm-ico">👛</span>'}<span><b>${esc(d.info.name)}</b><small>Connect with ${esc(d.info.name)}</small></span></button>`).join("")
      : '<p class="wm-empty">No wallet extension found. Install MetaMask or Rabby, or use the browser key below.</p>';
    $("wmList").querySelectorAll("[data-i]").forEach((btn) => btn.addEventListener("click", () => connectWallet(list[+btn.dataset.i])));
    $("walletModal").hidden = false;
  }, 250);
}

async function connectWallet(d) {
  $("walletModal").hidden = true;
  const provider = d.provider, name = d.info.name;
  try {
    // Always open the wallet so the person can pick the account.
    try { await provider.request({ method: "wallet_requestPermissions", params: [{ eth_accounts: {} }] }); } catch (e) { if (e && e.code === 4001) throw e; }
    const [addr] = await provider.request({ method: "eth_requestAccounts" });
    try { await switchNetwork(provider); } catch { toastError("Please approve the GenLayer Studio network in " + name + "."); }
    // Hand the chosen wallet straight to the SDK — other extensions cannot interfere.
    client = createClient({ chain: studionet, account: addr, provider });
    myAddr = String(addr).toLowerCase();
    accountLabel = short(addr) + " (" + name + ")";
    $("acct").innerHTML = "<b>" + esc(accountLabel) + "</b>";
    $("connectBtn").textContent = "Switch wallet";
    $("tx").classList.remove("show");
    render();
  } catch (e) {
    toastError(name + " connection was cancelled.");
  }
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
// Same rule as the contract: lower case, letters/digits only, single spaces.
const norm = (t) => String(t || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/g, " ");
const day = (iso) => String(iso || "").slice(0, 10);
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
    const owner = projects[p.project_key || norm(p.project)];
    const isOwner = owner && owner.owner === String(p.creator).toLowerCase();
    const mine = myAddr && String(p.creator).toLowerCase() === myAddr;
    return `<article class="promise ${esc(p.status)}">
      <span class="stamp">${esc(p.status)}</span>
      <div class="proj">${esc(p.project)} <span class="pid">#${esc(p.id)}</span></div>
      <div class="claim">${esc(p.claim)}</div>
      <div class="meta"><span>Promised <b>${esc(day(p.created_at))}</b></span><span>${due} <b>${esc(p.deadline)}</b></span>
        <span>By <b>${esc(short(p.creator))}</b>${isOwner ? ' <i class="own" title="This wallet owns the project name">✓ owner</i>' : ""}${mine ? ' <i class="own you">you</i>' : ""}</span>
        <span>Checks <b>${p.checks}</b></span>
        <a href="${esc(p.evidence_url)}" target="_blank" rel="noopener">Evidence page</a></div>
      ${p.reason ? `<div class="reason">${esc(p.reason)}</div>` : ""}
      ${verify}
    </article>`;
  }).join("");
}

// Checks done in the page before a transaction, with the same rules as the
// contract, so people get a clear message instead of a failed transaction.
function precheck(project, claim) {
  const key = norm(project);
  if (key.length < 2) return "Project name needs letters or numbers.";
  const owner = projects[key];
  if (owner && myAddr && owner.owner !== myAddr) {
    return `“${owner.name}” is owned by wallet ${short(owner.owner)}. Only that wallet can add promises for it. Use your own project name.`;
  }
  const dup = promises.find((p) => (p.project_key || norm(p.project)) === key && norm(p.claim) === norm(claim));
  if (dup) return `This promise is already recorded as #${dup.id}.`;
  return "";
}

function updateOwnerHint() {
  const key = norm($("fProject").value);
  const owner = projects[key];
  const el = $("ownerHint");
  if (!key || key.length < 2) { el.textContent = ""; el.className = "owner-hint"; return; }
  if (!owner) { el.textContent = "New name. Your wallet will become the owner of this project."; el.className = "owner-hint ok"; }
  else if (myAddr && owner.owner === myAddr) { el.textContent = "You own this project. You can add promises."; el.className = "owner-hint ok"; }
  else { el.textContent = `Owned by ${short(owner.owner)}. Only that wallet can add promises.`; el.className = "owner-hint bad"; }
}

function renderBoard(rows) {
  rows = (rows || []).filter((r) => r.kept + r.broken > 0);
  if (!rows.length) { $("board").innerHTML = '<div class="empty">A project gets a score after its first promise is resolved.</div>'; return; }
  $("board").innerHTML = rows.map((r) => {
    const total = r.kept + r.broken + r.pending;
    const color = r.score >= 70 ? "var(--kept)" : r.score >= 40 ? "var(--pending)" : "var(--broken)";
    const extra = `${r.kept} kept · ${r.broken} broken` + (r.void ? ` · ${r.void} void (not counted)` : "") + ` · owner ${short(r.owner)}`;
    return `<div class="lb-row"><div class="name">${esc(r.project)}<small>${esc(extra)}</small></div>
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
    const [list, stats, board, projs] = await Promise.all([read("get_promises"), read("get_stats"), read("get_leaderboard"), read("get_projects")]);
    promises = list || [];
    projects = {};
    (projs || []).forEach((p) => { projects[p.key] = p; });
    if (stats && stats.version) $("ver").textContent = "v" + stats.version;
    if (stats) {
      $("sKept").textContent = stats.kept; $("sBroken").textContent = stats.broken;
      $("sPending").textContent = stats.pending; $("sBond").textContent = stats.total_checks;
    }
    renderBoard(board);
    render();
    updateOwnerHint();
  } catch (e) {
    $("list").innerHTML = `<div class="empty">Could not read the contract. Check the address is a RoadmapProof v2 contract on Studionet.<br><small>${esc(e.shortMessage || e.message)}</small></div>`;
  }
}

// ---------- events ----------
$("form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!CONTRACT) { toastError("Set the contract address first (yellow box)."); return; }
  const args = [$("fProject").value.trim(), $("fClaim").value.trim(), $("fUrl").value.trim(), $("fDeadline").value];
  if (!args[2].startsWith("https://")) { toastError("The evidence page must start with https://"); return; }
  const problem = precheck(args[0], args[1]);
  if (problem) { toastError(problem); return; }
  const btn = $("submitBtn"); btn.disabled = true;
  const ok = await sendTx("Locking your promise", "create_promise", args);
  if (ok) { $("form").reset(); setDefaultDeadline(); updateOwnerHint(); }
  btn.disabled = false;
});
$("fProject").addEventListener("input", updateOwnerHint);

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
$("connectBtn").addEventListener("click", openWalletPicker);
$("wmClose").addEventListener("click", () => ($("walletModal").hidden = true));
$("walletModal").addEventListener("click", (e) => { if (e.target.id === "walletModal") $("walletModal").hidden = true; });
$("wmGuest").addEventListener("click", () => { $("walletModal").hidden = true; useBurner(); $("connectBtn").textContent = "Connect wallet"; });
$("addrInput").addEventListener("change", (e) => {
  const v = e.target.value.trim();
  if (/^0x[0-9a-fA-F]{40}$/.test(v)) { CONTRACT = v; store.set("rp_contract", v); refresh(); }
  else toastError("That does not look like a contract address (0x + 40 characters).");
});

function setDefaultDeadline() {
  const d = new Date(); d.setDate(d.getDate() + 30);
  $("fDeadline").value = d.toISOString().slice(0, 10);
  $("fDeadline").min = new Date().toISOString().slice(0, 10);
}
setDefaultDeadline();

useBurner();
refresh();
setInterval(refresh, 30000);
