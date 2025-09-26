// public/atadetection.js
//
// Single-file ATA gate + helper UI. Minimal coupling to index-v2.
// - Intercepts the SPIN button via a capturing listener.
// - Asks the server if the user's ATA exists (POST /api/spin with { ata_check: true }).
// - If missing (or superadmin test mode), shows the helper with Phantom/Solflare steps and a DETECT button.
// - On DETECT (and ATA exists), allows the next click through to your original handler.
// - Token-aware (uses config from the server, including token_name and mint_address).
//
// Assumptions:
// - /api/spin already accepts { token, server_id } and returns tokenConfig on first call.
// - We've added support for { ata_check: true } + it returns { ata_exists, token_name, mint_address, is_superadmin }.
// - The main page has #spin-button and we load this file AFTER the inline <script> in index-v2 so the original listener is attached.

(function () {
  const qs = new URLSearchParams(window.location.search);
  const TOKEN = qs.get("token") || "";
  const SERVER_ID = qs.get("server_id") || "";

  const SPIN_BTN_ID = "spin-button";
  const spinBtn = document.getElementById(SPIN_BTN_ID);
  if (!spinBtn) return;

  // We attach once.
  let attached = false;
  // Once DETECT passes, we set this so we stop intercepting.
  let gatePassed = false;
  // Cache values from server for dynamic copy
  let tokenName = "Token";
  let mintAddress = "";
  let isSuperadmin = false;

  // Fetch a live SOL→USD for the subheadline. If it fails, show "~$0.50".
  async function getSolUsdEstimate() {
    try {
      const r = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd", { cache: "no-store" });
      const j = await r.json();
      const usd = j?.solana?.usd;
      if (typeof usd === "number" && isFinite(usd)) return (0.002 * usd).toFixed(2);
    } catch (e) {}
    return "~0.50";
  }

  async function serverAtaCheck() {
    const res = await fetch("/api/spin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: TOKEN, server_id: SERVER_ID, ata_check: true })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error || "ATA check failed");
    // Capture fields for UI
    tokenName = data?.token_name || tokenName;
    mintAddress = data?.mint_address || mintAddress;
    isSuperadmin = !!data?.is_superadmin;
    return !!data?.ata_exists;
  }

  function ensureGateHost() {
    let host = document.getElementById("ata-gate-host");
    if (host) return host;
    host = document.createElement("div");
    host.id = "ata-gate-host";
    // Fullscreen overlay
    host.style.position = "fixed";
    host.style.inset = "0";
    host.style.background = "rgba(0,0,0,0.9)";
    host.style.color = "#fff";
    host.style.zIndex = "3000";
    host.style.display = "none";
    host.style.overflow = "auto";
    host.style.padding = "24px";
    host.style.boxSizing = "border-box";
    document.body.appendChild(host);
    return host;
  }

  async function showGate() {
    const host = ensureGateHost();
    const usd = await getSolUsdEstimate();
    host.innerHTML = `
      <div style="max-width:980px; margin:40px auto; font-family: Inter, system-ui, sans-serif;">
        <h1 style="font-size:28px; margin:0 0 8px; font-weight:900;">
          First create a ${escapeHtml(tokenName)} ATA to receive rewards
        </h1>
        <div style="opacity:0.9; font-size:16px; margin:0 0 16px;">
          Cost is 0.002 SOL ≈ ${usd} USD — Refundable to you!
        </div>
        <p style="opacity:0.9; line-height:1.5; font-size:15px; margin:0 0 20px;">
          Follow the instructions below to set up your ATA (Associated Token Account) for ${escapeHtml(tokenName)} to get started.
          This is like staking a small amount of SOL to prevent spam, and you can get it back by removing all the tokens in the ATA.
        </p>

        <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap:16px; margin:16px 0 24px;">
          <div style="background:#0f0f0f; border:1px solid #222; border-radius:16px; padding:16px; text-align:left;">
            <div style="font-weight:800; margin-bottom:8px;">Phantom</div>
            <ol style="padding-left:18px; margin:0; line-height:1.5;">
              <li>Open <b>Wallet → Tokens</b> → <b>Add/Manage</b>.</li>
              <li>Paste the ${escapeHtml(tokenName)} mint address:<br/>
                  <code style="word-break:break-all">${escapeHtml(mintAddress)}</code></li>
              <li>Tap <b>${escapeHtml(tokenName)}</b> → <b>Receive</b>.<br/>
                  Phantom will prompt <i>Create Token Account</i> if it doesn't exist.</li>
              <li>Approve the create account transaction (≈ 0.002 SOL).</li>
              <li>The ${escapeHtml(tokenName)} account should now exist — you can spin.</li>
            </ol>
          </div>

          <div style="background:#0f0f0f; border:1px solid #222; border-radius:16px; padding:16px; text-align:left;">
            <div style="font-weight:800; margin-bottom:8px;">Solflare</div>
            <ol style="padding-left:18px; margin:0; line-height:1.5;">
              <li><b>Portfolio → Add Token → Custom</b> (if needed).</li>
              <li>Paste the ${escapeHtml(tokenName)} mint address:<br/>
                  <code style="word-break:break-all">${escapeHtml(mintAddress)}</code></li>
              <li>Open <b>${escapeHtml(tokenName)} → Receive</b> (or the ⋯ menu).<br/>
                  Solflare will show <i>Create Token Account</i> if missing.</li>
              <li>Approve (≈ 0.002 SOL).</li>
              <li>${escapeHtml(tokenName)} account should now be created.</li>
            </ol>
          </div>
        </div>

        <div style="display:flex; gap:12px; flex-wrap:wrap; align-items:center;">
          <button id="ata-detect" style="
            padding:12px 22px; font-size:16px; font-weight:800; background:#ff4500; color:#fff; border:none; border-radius:14px; cursor:pointer;">
            DETECT
          </button>
          <button id="ata-cancel" style="
            padding:10px 16px; font-size:14px; font-weight:700; background:#222; color:#fff; border:1px solid #333; border-radius:12px; cursor:pointer;">
            Cancel
          </button>
          <div style="opacity:0.7; font-size:13px;">Mint: <code style="word-break:break-all">${escapeHtml(mintAddress)}</code></div>
        </div>
      </div>
    `;
    host.style.display = "block";

    const detectBtn = document.getElementById("ata-detect");
    const cancelBtn = document.getElementById("ata-cancel");
    detectBtn?.addEventListener("click", async () => {
      detectBtn.setAttribute("disabled", "true");
      detectBtn.textContent = "Checking…";
      try {
        const ok = await serverAtaCheck();
        if (ok) {
          host.style.display = "none";
          gatePassed = true;
          // Trigger the original click now that gate has passed
          spinBtn.click();
        } else {
          detectBtn.textContent = "Not found yet — Try again";
          detectBtn.removeAttribute("disabled");
        }
      } catch (e) {
        detectBtn.textContent = "Error — Try again";
        detectBtn.removeAttribute("disabled");
      }
    });
    cancelBtn?.addEventListener("click", () => {
      host.style.display = "none";
    });
  }

  function escapeHtml(s) {
    return String(s || "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // Intercept the spin button click before the original handler
  function attachGate() {
    if (attached) return;
    attached = true;

    spinBtn.addEventListener(
      "click",
      async (e) => {
        // If we've already passed the gate, let the original handler run
        if (gatePassed) return;

        e.stopImmediatePropagation();
        e.preventDefault();

        let exists = false;
        try {
          exists = await serverAtaCheck();
        } catch (_) {
          // If the check endpoint is missing, fail safe by showing the helper (so you don't pay rent by accident).
          exists = false;
        }

        // For superadmin, force helper first (testing), even if exists
        const forceHelper = (typeof isSuperadmin === "boolean" && isSuperadmin === true);

        if (!exists || forceHelper) {
          await showGate();
          return; // Wait for DETECT
        }

        // Gate passed; allow the original handler to run on next click
        gatePassed = true;
        spinBtn.click();
      },
      { capture: true } // capture so we run before the original module handler
    );
  }

  attachGate();
})();
