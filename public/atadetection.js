// atadetection.ts
// Renders an ATA helper screen + "DETECT" that asks the backend to verify ATA existence.
// Assumes URL has ?token=...&server_id=...

type SpinAtaCheckResponse = {
  ok?: boolean;
  ata_exists?: boolean;
  token_name?: string;
  mint_address?: string;
  is_superadmin?: boolean;
  error?: string;
  message?: string;
};

(function () {
  const qs = new URLSearchParams(window.location.search);
  const signedToken = qs.get('token') || '';
  const serverId = qs.get('server_id') || '';

  // Simple guard
  if (!signedToken || !serverId) {
    document.body.innerHTML = `<div style="color:#fff;background:#000;font-family:Inter,system-ui,sans-serif;padding:24px">
      <h1 style="margin:0 0 8px">Missing parameters</h1>
      <p>URL must include <code>token</code> and <code>server_id</code>.</p>
    </div>`;
    return;
  }

  // ----- Styles -----
  const style = document.createElement('style');
  style.textContent = `
    :root { --bg:#000; --fg:#fff; --muted:#b7b7b7; --accent:#ff4500; --panel:#121212; }
    html, body {
      margin:0; padding:0; background:var(--bg); color:var(--fg);
      font-family: Inter, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif;
    }
    .wrap {
      max-width: 980px; margin: 0 auto; padding: clamp(16px, 5vw, 36px);
    }
    .headline {
      font-weight: 900; line-height: 1.15; margin: 0 0 8px; font-size: clamp(24px, 5vw, 40px);
      letter-spacing: -0.5px;
    }
    .subhead {
      margin: 0; font-weight: 700; color: #ffd16b; font-size: clamp(16px, 2.8vw, 22px);
    }
    /* EXTRA blank line under subhead */
    .spacer-under-subhead { height: 16px; }
    .explain {
      color: var(--fg); opacity: 0.9; font-size: clamp(14px, 2.4vw, 18px);
      line-height: 1.5; margin: 0;
    }
    /* EXTRA blank line between text and panels */
    .spacer-before-panels { height: 18px; }

    .panels {
      display: grid; grid-template-columns: 1fr; gap: 14px;
    }
    @media (min-width: 840px) {
      .panels { grid-template-columns: 1fr 1fr; gap: 16px; }
    }
    .panel {
      background: var(--panel); border-radius: 16px; padding: 18px 18px 14px;
      border: 1px solid rgba(255,255,255,0.06);
      box-shadow: 0 8px 24px rgba(0,0,0,0.35);
    }
    .panel h3 {
      margin: 0 0 10px; font-weight: 900; letter-spacing: -0.3px;
    }
    /* SOLFLARE title 2pt larger than PHANTOM */
    .panel.solflare h3 { font-size: 20px; }
    .panel.phantom h3  { font-size: 18px; }

    .steps {
      margin: 0; padding-left: 20px; font-size: 15px; line-height: 1.55;
    }
    .steps li { margin-bottom: 6px; }
    .token-chip {
      display:inline-block; padding:2px 8px; border-radius: 999px; background:#1d1d1d; border:1px solid rgba(255,255,255,0.12); font-weight:700;
    }

    .detect-row {
      display: flex; align-items: center; gap: 10px; margin-top: 18px;
    }
    .btn {
      appearance: none; border: none; outline: none; cursor: pointer;
      background: var(--accent); color: #fff; font-weight: 800;
      padding: 12px 18px; border-radius: 12px; font-size: 16px;
      transition: filter .15s ease;
    }
    .btn:disabled { opacity: .6; cursor: not-allowed; }
    .btn:hover { filter: brightness(1.05); }

    .status {
      font-weight: 800; font-size: 15px;
    }
    .ok { color: #25d366; }      /* green */
    .warn { color: #ffa800; }    /* amber */
    .bad { color: #ff6b6b; }     /* red */

    .foot {
      margin-top: 22px; color: var(--muted); font-size: 13px;
    }
    code.addr {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
      font-size: 12.5px; background:#111; border:1px solid rgba(255,255,255,.08);
      padding:2px 6px; border-radius:8px;
    }
  `;
  document.head.appendChild(style);

  // ----- DOM -----
  const wrap = document.createElement('div');
  wrap.className = 'wrap';
  wrap.innerHTML = `
    <h1 class="headline">First create a <span id="tokenNameHead" class="token-chip">[Token name]</span> ATA to receive rewards</h1>
    <p class="subhead">Cost is ~0.002&nbsp;SOL (rent) — refundable by closing the token account later.</p>
    <div class="spacer-under-subhead"></div>
    <p class="explain">
      Follow the instructions below to set up your ATA (Associated Token Account) for
      <span id="tokenNameText">[Token name]</span> to get started.
      This is like staking a small amount of SOL to prevent spam; you can reclaim it later by removing the token account.
    </p>
    <div class="spacer-before-panels"></div>

    <div class="panels">
      <div class="panel solflare">
        <h3>SOLFLARE</h3>
        <ol class="steps" id="solflareSteps">
          <!-- Filled after we know token name & address -->
        </ol>
      </div>
      <div class="panel phantom">
        <h3>Phantom</h3>
        <ol class="steps">
          <li>Open Phantom Wallet.</li>
          <li>On the Tokens list, tap <strong>+ Add / Manage</strong>.</li>
          <li>Paste the <strong><span id="tokenNamePhantomA">[Token name]</span></strong> mint address:<br/><code class="addr" id="mintAddrPhantom">[token address]</code></li>
          <li>Select <strong><span id="tokenNamePhantomB">[Token name]</span></strong>, then choose <strong>Receive</strong>.</li>
          <li>If prompted, choose <strong>Create Token Account</strong>.</li>
          <li>Approve the transaction (rent ~0.002 SOL).</li>
          <li>Return here and press <strong>DETECT</strong>.</li>
        </ol>
      </div>
    </div>

    <div class="detect-row">
      <button id="detectBtn" class="btn">DETECT</button>
      <div id="status" class="status"></div>
    </div>

    <div class="foot">
      Tip: If you don’t see the prompt to create the token account, first add the token by mint address, then open it and press <em>Receive</em>.
    </div>
  `;
  document.body.appendChild(wrap);

  const tokenHead = document.getElementById('tokenNameHead') as HTMLSpanElement;
  const tokenText = document.getElementById('tokenNameText') as HTMLSpanElement;
  const tokenNamePhA = document.getElementById('tokenNamePhantomA') as HTMLSpanElement;
  const tokenNamePhB = document.getElementById('tokenNamePhantomB') as HTMLSpanElement;
  const mintAddrPh = document.getElementById('mintAddrPhantom') as HTMLSpanElement;
  const solflareSteps = document.getElementById('solflareSteps') as HTMLOListElement;
  const detectBtn = document.getElementById('detectBtn') as HTMLButtonElement;
  const statusDiv = document.getElementById('status') as HTMLDivElement;

  // Fill Solflare steps with your exact wording (1–9), using real token name + mint
  function setSolflareSteps(tokenName: string, mint: string) {
    solflareSteps.innerHTML = `
      <li>Open Solflare Wallet</li>
      <li>Scroll down to the bottom of tokens</li>
      <li>Click <strong>+Add New Asset</strong></li>
      <li>Paste the <strong>${escapeHtml(tokenName)}</strong> address:</li>
      <li><code class="addr">${escapeHtml(mint)}</code></li>
      <li>The Token should appear. Click <strong>+Add</strong></li>
      <li><strong>Create Token Account</strong></li>
      <li><strong>CONFIRM</strong> (≈ 0.002 SOL Needed)</li>
      <li>ATA Token Account should now be created.</li>
    `;
  }

  // Updates titles/placeholders after backend informs us of token/mint
  function setTokenMeta(name: string, mint: string) {
    tokenHead.textContent = name;
    tokenText.textContent = name;
    tokenNamePhA.textContent = name;
    tokenNamePhB.textContent = name;
    mintAddrPh.textContent = mint;
    setSolflareSteps(name, mint);
  }

  // First, probe backend for token metadata (and superadmin override if you use it).
  // We use ata_check=true to get mint/token name without side effects.
  let currentMint = '';
  let currentName = 'Token';

  async function bootstrapMeta() {
    statusDiv.textContent = 'Loading token info…';
    statusDiv.className = 'status';
    try {
      const resp = await fetch('/api/spin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: signedToken, server_id: serverId, ata_check: true })
      });
      const data = (await resp.json()) as SpinAtaCheckResponse;

      // If server doesn’t support ata_check, try a plain config call (no spin)
      if (!resp.ok && !data?.token_name) {
        const r2 = await fetch('/api/spin', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: signedToken, server_id: serverId })
        });
        const d2 = await r2.json();
        if (r2.ok && d2?.tokenConfig?.token_name) {
          currentName = d2.tokenConfig.token_name || 'Token';
          currentMint = d2.contract_address || d2.tokenConfig.mint_address || '';
        } else {
          throw new Error(data?.error || d2?.error || 'Failed to load token metadata');
        }
      } else {
        currentName = data.token_name || 'Token';
        currentMint = data.mint_address || '';
      }

      if (!currentMint) throw new Error('Missing mint address');
      setTokenMeta(currentName, currentMint);
      statusDiv.textContent = '';
    } catch (e: any) {
      statusDiv.textContent = (e?.message || 'Failed to load token info');
      statusDiv.className = 'status bad';
    }
  }

  // DETECT button: ask backend to verify ATA existence for the user wallet.
  detectBtn.addEventListener('click', async () => {
    detectBtn.disabled = true;
    statusDiv.textContent = 'Checking ATA on-chain…';
    statusDiv.className = 'status';
    try {
      const resp = await fetch('/api/spin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: signedToken, server_id: serverId, ata_check: true })
      });
      const data = (await resp.json()) as SpinAtaCheckResponse;

      if (!resp.ok) {
        // graceful message for older backends
        const msg = data?.message || data?.error || 'Detection failed';
        throw new Error(msg);
      }

      const exists = !!data.ata_exists;
      const name = data.token_name || currentName;
      const mint = data.mint_address || currentMint;
      if (!currentMint && mint) setTokenMeta(name, mint);

      if (exists) {
        statusDiv.textContent = `Detected: Your ${name} ATA exists. You can spin now.`;
        statusDiv.className = 'status ok';
      } else {
        statusDiv.innerHTML = `No ${escapeHtml(name)} ATA found yet. Follow the steps above, then press <strong>DETECT</strong> again.`;
        statusDiv.className = 'status bad';
      }
    } catch (e: any) {
      statusDiv.textContent = e?.message || 'Detection failed';
      statusDiv.className = 'status bad';
    } finally {
      detectBtn.disabled = false;
    }
  });

  // utils
  function escapeHtml(s: string) {
    return s.replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as any)[c]
    );
  }

  // init
  bootstrapMeta();
})();
