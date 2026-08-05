// Connexion par lien (job #54) : le serveur a déjà posé le cookie de session à partir de
// `?pin=...` avant de servir cette page (src/server.js) — il ne reste qu'à nettoyer la barre
// d'adresse pour que le PIN ne traîne pas dans l'historique navigateur plus que le strict chargement.
(function stripPinFromAddressBar() {
  const url = new URL(location.href);
  if (!url.searchParams.has("pin")) return;
  url.searchParams.delete("pin");
  history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
})();

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function fmtTime(ts) {
  if (!ts) return "—";
  const d = new Date(ts);
  return d.toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "medium" });
}

function fmtRelative(ts) {
  if (!ts) return "—";
  const diffMs = Date.now() - ts;
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return "à l'instant";
  if (mins < 60) return `il y a ${mins} min`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `il y a ${hours} h`;
  return `il y a ${Math.round(hours / 24)} j`;
}

/** Comme fmtRelative mais pour une échéance FUTURE (ex. prochain due_at d'un sensor). */
function fmtEta(ts) {
  if (!ts) return "—";
  const diffMs = ts - Date.now();
  if (diffMs <= 0) return "en retard";
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return "imminent";
  if (mins < 60) return `dans ${mins} min`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `dans ${hours} h`;
  return `dans ${Math.round(hours / 24)} j`;
}

function fmtCadence(ms) {
  if (!ms) return "—";
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins} min`;
  return `${Math.round(mins / 60)} h`;
}

function badge(status) {
  const cls = String(status ?? "").toLowerCase();
  return `<span class="badge ${escapeHtml(cls)}">${escapeHtml(status ?? "?")}</span>`;
}

async function getJson(url) {
  const res = await fetch(url);
  if (res.status === 401) {
    location.href = "/login";
    throw new Error("unauthorized");
  }
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.status === 401) {
    location.href = "/login";
    throw new Error("unauthorized");
  }
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(payload.reply || payload.error || `${url} -> ${res.status}`);
  return payload;
}

function renderRows(tbodyId, rows, rowFn, emptyText) {
  const tbody = document.getElementById(tbodyId);
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="10" class="empty">${escapeHtml(emptyText)}</td></tr>`;
    return;
  }
  tbody.innerHTML = rows.map(rowFn).join("");
}

const MODE_LABELS = {
  inherit: "Hérite du global",
  auto: "Auto",
  claude: "Claude",
  codex: "Codex",
  deepseek: "DeepSeek",
};

const MODEL_OPTIONS = {
  auto: [{ value: "auto", label: "auto" }],
  inherit: [{ value: "auto", label: "auto" }],
  claude: [
    { value: "auto", label: "défaut sub" },
    { value: "opus", label: "opus" },
    { value: "sonnet", label: "sonnet" },
    { value: "haiku", label: "haiku" },
    { value: "fable", label: "fable" },
  ],
  codex: [
    { value: "auto", label: "défaut Codex" },
    { value: "sol", label: "sol" },
    { value: "terra", label: "terra" },
    { value: "luna", label: "luna" },
    { value: "gpt-5.5", label: "gpt-5.5" },
    { value: "gpt-5.4", label: "gpt-5.4" },
    { value: "mini", label: "mini" },
  ],
  deepseek: [
    { value: "auto", label: "défaut DeepSeek" },
    { value: "pro", label: "pro" },
    { value: "flash", label: "flash" },
  ],
};

const EFFORT_OPTIONS = ["auto", "low", "medium", "high", "xhigh", "max"];

function modeOptions(scope) {
  const modes =
    scope.id === "global"
      ? ["auto", "claude", "codex", "deepseek"]
      : ["inherit", "claude", "codex", "deepseek"];
  if (!modes.includes(scope.mode)) modes.push(scope.mode);
  return modes;
}

function selectedModel(scope) {
  if (scope.mode === "codex") return scope.settings.codexModel.value || "auto";
  if (scope.mode === "deepseek") return scope.settings.deepseekModel.value || "auto";
  if (scope.mode === "claude") return scope.settings.model.value || "auto";
  return "auto";
}

function optionHtml(value, label, selected, disabled = false) {
  return `<option value="${escapeHtml(value)}"${selected ? " selected" : ""}${disabled ? " disabled" : ""}>${escapeHtml(label)}</option>`;
}

function modelOptionsHtml(mode, selected) {
  const options = MODEL_OPTIONS[mode] ?? MODEL_OPTIONS.auto;
  return options.map((o) => optionHtml(o.value, o.label, o.value === selected)).join("");
}

function currentModelLabel(scope) {
  const effort = scope.settings.effort.value || "auto";
  if (scope.mode === "inherit") return `hérite du global · effort ${effort || "auto"}`;
  if (scope.mode === "codex") return `${scope.settings.codexModel.value || "défaut Codex"} · effort ${effort}`;
  if (scope.mode === "deepseek") return `${scope.settings.deepseekModel.value || "défaut DeepSeek"} · effort ${effort}`;
  if (scope.mode === "claude") return `${scope.settings.model.value || "défaut sub"} · effort ${effort}`;
  return `routeur auto · effort ${effort}`;
}

function commandPrefix(scope) {
  return scope.scopeArg ? `${scope.scopeArg} ` : "";
}

function modelCommand(scope, mode, model) {
  const prefix = commandPrefix(scope);
  if (mode === "inherit" || mode === "auto") return `/model ${prefix}auto`.trim();
  if (mode === "claude") return model === "auto" ? `/model ${prefix}claude`.trim() : `/model ${prefix}claude ${model}`.trim();
  if (mode === "codex") return model === "auto" ? `/model ${prefix}codex`.trim() : `/model ${prefix}codex ${model}`.trim();
  if (mode === "deepseek") return model === "auto" ? `/model ${prefix}deepseek`.trim() : `/model ${prefix}deepseek ${model}`.trim();
  return `/model ${prefix}auto`.trim();
}

function effortCommand(scope, effort) {
  return `/effort ${commandPrefix(scope)}${effort}`.trim();
}

async function sendSettingsCommand(command) {
  const result = await postJson("/api/settings", { command });
  return result.reply ?? "ok";
}

async function loadModelSetup() {
  const data = await getJson("/api/model-settings");
  const body = document.getElementById("model-setup-body");
  const result = document.getElementById("model-setup-result");
  if (!data.scopes?.length) {
    body.innerHTML = `<p class="empty">réglages indisponibles : base SQLite illisible</p>`;
    return;
  }
  const disabled = data.settingsAvailable ? "" : " disabled";
  body.innerHTML = `<div class="table-wrap model-form">
    <table>
      <thead><tr><th>Portée</th><th>État actuel</th><th>Moteur</th><th>Modèle</th><th>Effort</th><th>Action</th></tr></thead>
      <tbody>
        ${data.scopes
          .map((scope) => {
            const modes = modeOptions(scope);
            const currentMode = modes.includes(scope.mode) ? scope.mode : modes[0];
            const selected = selectedModel(scope);
            return `<tr data-scope="${escapeHtml(scope.id)}" data-scope-arg="${escapeHtml(scope.scopeArg)}">
              <td>${escapeHtml(scope.label)}</td>
              <td class="model-current">${escapeHtml(currentModelLabel(scope))}</td>
              <td><select class="model-mode"${disabled}>
                ${modes.map((m) => optionHtml(m, MODE_LABELS[m] ?? m, m === currentMode)).join("")}
              </select></td>
              <td><select class="model-choice"${disabled}>${modelOptionsHtml(currentMode, selected)}</select></td>
              <td><select class="model-effort"${disabled}>
                ${EFFORT_OPTIONS.map((e) => optionHtml(e, e, e === (scope.settings.effort.value || "auto"))).join("")}
              </select></td>
              <td class="model-actions">
                <button type="button" data-action="apply"${disabled}>Appliquer</button>
                <button type="button" class="secondary" data-action="unpin"${disabled}>Auto</button>
              </td>
            </tr>`;
          })
          .join("")}
      </tbody>
    </table>
  </div>`;

  if (!data.settingsAvailable) {
    result.textContent = "Réglages désactivés : DASHBOARD_SETTINGS_TOKEN manque côté dashboard ou daemon.";
  }

  body.querySelectorAll(".model-mode").forEach((select) => {
    select.addEventListener("change", () => {
      const row = select.closest("tr");
      const modelSelect = row.querySelector(".model-choice");
      modelSelect.innerHTML = modelOptionsHtml(select.value, "auto");
    });
  });

  body.querySelectorAll("button[data-action]").forEach((button) => {
    button.addEventListener("click", async () => {
      const row = button.closest("tr");
      const scope = { id: row.dataset.scope, scopeArg: row.dataset.scopeArg };
      const action = button.dataset.action;
      const commands =
        action === "unpin"
          ? [`/unpin ${commandPrefix(scope)}`.trim()]
          : [
              modelCommand(scope, row.querySelector(".model-mode").value, row.querySelector(".model-choice").value),
              effortCommand(scope, row.querySelector(".model-effort").value),
            ];
      result.textContent = "application…";
      try {
        const replies = [];
        for (const command of commands) replies.push(await sendSettingsCommand(command));
        result.textContent = replies.join(" · ");
        await loadModelSetup();
        await loadStatus();
      } catch (e) {
        result.textContent = `échec : ${e.message}`;
      }
    });
  });
}

async function loadStatus() {
  const s = await getJson("/api/status");
  const daemonBadge = s.daemon?.up ? badge("ok") : badge("down");
  const quota = s.copilotQuota;
  document.getElementById("status-body").innerHTML = `
    <div class="k">Daemon</div><div>${daemonBadge}</div>
    <div class="k">SHA déployé</div><div class="hash">${escapeHtml(s.daemonGitSha ?? "inconnu")}</div>
    <div class="k">Dernière activité</div><div>${fmtRelative(s.lastActivityAt)} <span class="muted small">(${fmtTime(s.lastActivityAt)})</span></div>
    <div class="k">Base SQLite</div><div>${s.db.ok ? badge("ok") : `${badge("down")} <span class="small muted">${escapeHtml(s.db.error ?? "")}</span>`}</div>
  `;
  const quotaBody = document.getElementById("quota-body");
  if (!quota) {
    quotaBody.innerHTML = `<div class="empty">aucune donnée ce mois-ci</div>`;
  } else {
    const pct = Math.min(100, Math.round((quota.used / quota.budget) * 100));
    quotaBody.innerHTML = `
      <div class="grid-2">
        <div class="k">Mois</div><div>${escapeHtml(quota.month)}</div>
        <div class="k">Utilisé</div><div>${quota.used.toFixed(2)} / ${quota.budget} (${pct}%) <span class="muted small">— seuil sûr ${quota.safeLimit}</span></div>
      </div>`;
  }
}

async function loadJobs() {
  const { jobs } = await getJson("/api/jobs?limit=15");
  renderRows(
    "jobs-body",
    jobs,
    (j) => `<tr>
      <td>${j.id}</td>
      <td class="truncate" title="${escapeHtml(j.intent)}">${escapeHtml(j.intent)}</td>
      <td>${badge(j.status)}</td>
      <td>${fmtRelative(j.updated_at)}</td>
    </tr>`,
    "aucun job",
  );
}

async function loadWakes() {
  const { pending, recent } = await getJson("/api/wakes?limit=15");
  renderRows(
    "wakes-pending-body",
    pending,
    (w) => `<tr>
      <td>${w.id}</td>
      <td>${fmtTime(w.due_at)}</td>
      <td class="truncate" title="${escapeHtml(w.intent)}">${escapeHtml(w.intent)}</td>
      <td>${escapeHtml(w.created_by)}</td>
      <td>${w.recurrence_ms ? `${Math.round(w.recurrence_ms / 60000)} min` : "—"}</td>
    </tr>`,
    "aucun réveil en attente",
  );
  renderRows(
    "wakes-recent-body",
    recent,
    (w) => `<tr>
      <td>${w.id}</td>
      <td>${fmtTime(w.due_at)}</td>
      <td class="truncate" title="${escapeHtml(w.intent)}">${escapeHtml(w.intent)}</td>
      <td>${badge(w.status)}</td>
    </tr>`,
    "aucun réveil récent",
  );
}

/** Rend le décompte réel `sensor_evals` d'un sensor pour la fenêtre en cours (job #54) — "historique
 *  en cours de constitution" si la fenêtre est bornée au boot du daemon et qu'aucune évaluation n'y
 *  est encore tombée, plutôt qu'un "0" trompeur sans contexte. */
function fmtEvalCounts(counts, evalWindow) {
  const total = (counts?.changedTrue ?? 0) + (counts?.changedFalse ?? 0);
  const buildingSince = evalWindow?.daemonBootedAt && evalWindow.daemonBootedAt === evalWindow.sinceMs;
  if (total === 0) {
    return buildingSince
      ? `<span class="muted small">historique en cours de constitution depuis ${escapeHtml(fmtTime(evalWindow.daemonBootedAt))}</span>`
      : `<span class="muted small">aucune évaluation sur la fenêtre</span>`;
  }
  const t = counts.changedTrue;
  return `🔇 ${counts.changedFalse} silencieux · 🔔 ${t} réveil${t > 1 ? "s" : ""} réel${t > 1 ? "s" : ""}`;
}

async function loadSensors() {
  const { sensors, registryError, note, evalWindow } = await getJson("/api/sensors");
  document.getElementById("sensors-note").textContent = note ?? "";
  const tbody = document.getElementById("sensors-body");
  if (registryError) {
    tbody.innerHTML = `<tr><td colspan="6" class="empty">registre des sensors illisible : ${escapeHtml(registryError)}</td></tr>`;
    return;
  }
  if (!sensors.length) {
    tbody.innerHTML = `<tr><td colspan="6" class="empty">aucun sensor enregistré</td></tr>`;
    return;
  }
  tbody.innerHTML = sensors
    .map((s) => {
      const activity = fmtEvalCounts(s.evalCounts, evalWindow);
      if (!s.wakes.length) {
        return `<tr><td>${escapeHtml(s.name)}</td><td colspan="4" class="empty">aucun wake actif ne porte ce sensor</td><td>${activity}</td></tr>`;
      }
      return s.wakes
        .map(
          (w) => `<tr>
            <td>${escapeHtml(s.name)}</td>
            <td>${fmtCadence(w.recurrence_ms)}</td>
            <td>${fmtTime(w.due_at)} <span class="muted small">(${fmtEta(w.due_at)})</span></td>
            <td>#${w.id}</td>
            <td>${badge(w.status)}</td>
            <td>${activity}</td>
          </tr>`,
        )
        .join("");
    })
    .join("");
}

async function loadContext() {
  const { files } = await getJson("/api/context");
  const container = document.getElementById("context-body");
  container.innerHTML = files
    .map((f) => {
      if (!f.present) {
        return `<div class="context-file"><div class="k">${escapeHtml(f.label)}</div><div class="empty">fichier absent du dépôt monté</div></div>`;
      }
      const sizeKb = (f.size / 1024).toFixed(1);
      const body = f.truncated
        ? `<p class="empty">fichier trop volumineux pour l'aperçu (${sizeKb} Ko)</p>`
        : `<pre>${escapeHtml(f.content)}</pre>`;
      return `<details class="context-file">
        <summary>${escapeHtml(f.label)} <span class="muted small">(${sizeKb} Ko)</span></summary>
        <p class="small muted">${escapeHtml(f.note)}</p>
        ${body}
      </details>`;
    })
    .join("");
}

/** Un knowledge repo : nom + lien GitHub + visibilité + domaines couverts. Métadonnées seulement —
 *  le contenu de ces dépôts n'est jamais lu ni affiché (cf. src/knowledge-repos.js). */
function knowledgeRepoRow(r) {
  const link = r.url
    ? `<a href="${escapeHtml(r.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(r.name)}</a>`
    : `${escapeHtml(r.name)} <span class="muted small">(remote non reconnu)</span>`;
  const domains = r.domains.length
    ? `<div class="tags">${r.domains.map((d) => `<span class="tag">${escapeHtml(d)}</span>`).join("")}</div>`
    : `<p class="small muted">aucun domaine déclaré au registre</p>`;
  const loadWhen = r.loadWhen ? `<p class="small muted">Chargé quand : ${escapeHtml(r.loadWhen)}</p>` : "";
  const status = r.status ? `<p class="small muted">${escapeHtml(r.status)}</p>` : "";
  return `<div class="knowledge-repo">
    <div><strong>${link}</strong> <span class="badge private">${escapeHtml(r.visibility)}</span></div>
    ${domains}
    ${loadWhen}
    ${status}
  </div>`;
}

async function loadGithub() {
  const links = await getJson("/api/github");
  const container = document.getElementById("github-body");
  const entry = (label, l) => `
    <div class="context-file">
      <div class="k">${escapeHtml(label)}</div>
      <div><a href="${escapeHtml(l.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(l.url)}</a>
        <span class="muted small">(${escapeHtml(l.visibility)})</span></div>
      <p class="small muted">${escapeHtml(l.description)}</p>
    </div>`;
  let knowledgeBody;
  if (links.knowledgeError) {
    knowledgeBody = `<p class="empty">${escapeHtml(links.knowledgeError)}</p>`;
  } else if (!links.knowledge.length) {
    knowledgeBody = `<p class="empty">aucun knowledge repo déclaré dans ${escapeHtml(links.knowledgeSource)}</p>`;
  } else {
    knowledgeBody = links.knowledge.map(knowledgeRepoRow).join("");
  }
  container.innerHTML =
    entry(links.main.label, links.main) +
    entry(links.public.label, links.public) +
    `<div class="context-file"><div class="k">Knowledge repos <span class="muted small">(${links.knowledge?.length ?? 0})</span></div>
      <p class="small muted">${escapeHtml(links.knowledgeNote)}</p>
      ${knowledgeBody}
      <p class="small muted">Source : <code>${escapeHtml(links.knowledgeSource)}</code> — lu en direct dans le dépôt monté.</p>
    </div>`;
}

/** Les VRAIES sessions Dream journalisées (source `dream`), cliquables via #/sessions/<id> comme
 *  n'importe quelle autre session. Vide tant que le daemon n'a pas redémarré avec la journalisation
 *  ET qu'un cycle nocturne n'a pas tourné : on le dit, plutôt que d'afficher un tableau vide muet. */
function dreamSessionsBlock(sessions) {
  if (!sessions?.length) {
    return `<p class="empty">aucune session Dream journalisée pour l'instant — la journalisation
      (<code>source: dream</code>) date du 30/07/2026 côté harnais : la première ligne apparaîtra
      après le prochain cycle nocturne.</p>`;
  }
  const rows = sessions
    .map(
      (s) => `<tr>
        <td class="hash"><a href="#/sessions/${encodeURIComponent(s.session_id)}" title="${escapeHtml(s.session_id)}">${escapeHtml(s.session_id.slice(0, 8))}…</a></td>
        <td>${fmtRelative(s.last_seen)} <span class="muted small">(${fmtTime(s.last_seen)})</span></td>
        <td>${(s.last_cost_usd ?? 0).toFixed(3)}</td>
        <td>${escapeHtml(s.model ?? "—")}</td>
        <td>${escapeHtml(s.effort ?? "—")}</td>
      </tr>`,
    )
    .join("");
  return `<div class="table-wrap">
    <table><thead><tr><th>Session</th><th>Vue à</th><th>Coût $</th><th>Modèle</th><th>Effort</th></tr></thead>
      <tbody>${rows}</tbody></table>
  </div>`;
}

async function loadDreamPrompt() {
  const d = await getJson("/api/dream-prompt");
  const container = document.getElementById("dream-prompt-body");
  const sessions = `<h3 class="small muted">Sessions Dream journalisées</h3>${dreamSessionsBlock(d.sessions)}`;
  if (!d.present) {
    container.innerHTML = `${sessions}<p class="empty">harness/persona/dream.md introuvable dans le dépôt monté.</p>`;
    return;
  }
  const newCycleBody = d.truncated
    ? `<p class="empty">fichier trop volumineux pour l'aperçu</p>`
    : `<pre>${escapeHtml(d.newCycle)}</pre>`;
  container.innerHTML = `
    ${sessions}
    <h3 class="small muted">Prompt de démarrage</h3>
    <p class="small muted">⚠️ ${escapeHtml(d.warning)}</p>
    <details class="context-file" open>
      <summary>Nouveau cycle <span class="muted small">(template actuel)</span></summary>
      ${newCycleBody}
    </details>
    <details class="context-file">
      <summary>Reprise après coupure quota</summary>
      <pre>${escapeHtml(d.resume)}</pre>
    </details>`;
}

/** Lit l'id de session ciblé dans le hash `#/sessions/<id>` (lien envoyé par /session list côté
 *  harnais, ou copié depuis la table ci-dessous) — jamais transmis au serveur, purement client. */
function sessionIdFromHash() {
  const m = location.hash.match(/^#\/sessions\/([^/?]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

async function loadSessionFocus() {
  const id = sessionIdFromHash();
  const section = document.getElementById("card-session-focus");
  if (!id) {
    section.hidden = true;
    return;
  }
  section.hidden = false;
  const body = document.getElementById("session-focus-body");
  body.innerHTML = "chargement…";
  try {
    const { session: s } = await getJson(`/api/sessions?id=${encodeURIComponent(id)}`);
    body.innerHTML = `
      <div class="k">Session</div><div class="hash">${escapeHtml(s.session_id)}</div>
      <div class="k">Scope</div><div>${escapeHtml(s.scope)}</div>
      <div class="k">Vue à</div><div>${fmtRelative(s.last_seen)} <span class="muted small">(${fmtTime(s.last_seen)})</span></div>
      <div class="k">Première vue</div><div>${fmtTime(s.first_seen)}</div>
      <div class="k">Coût</div><div>${(s.last_cost_usd ?? 0).toFixed(3)} $</div>
      <div class="k">Source</div><div>${escapeHtml(s.source ?? "—")}</div>
      <div class="k">Modèle</div><div>${escapeHtml(s.model ?? "—")}</div>
      <div class="k">Effort</div><div>${escapeHtml(s.effort ?? "—")}</div>`;
  } catch {
    body.innerHTML = `<div class="empty">session introuvable (peut-être expirée/purgée)</div>`;
  }
}

async function loadSessions() {
  const { sessions } = await getJson("/api/sessions?limit=15");
  renderRows(
    "sessions-body",
    sessions,
    (s) => `<tr>
      <td class="hash" title="${escapeHtml(s.session_id)}">${escapeHtml(s.session_id.slice(0, 8))}…</td>
      <td>${escapeHtml(s.scope)}</td>
      <td>${fmtRelative(s.last_seen)}</td>
      <td>${(s.last_cost_usd ?? 0).toFixed(3)}</td>
      <td>${escapeHtml(s.source ?? "—")}</td>
      <td>${escapeHtml(s.model ?? "—")}</td>
      <td>${escapeHtml(s.effort ?? "—")}</td>
    </tr>`,
    "aucune session",
  );
}

/** Une série de barres horizontales CSS (pas de lib de charting) : `rows` = [{label, usd, cls?}],
 *  triées par appelant. La largeur de chaque barre est proportionnelle au max de la série. */
function barRows(rows, formatLabel) {
  if (!rows.length) return `<p class="empty">aucune donnée sur la fenêtre</p>`;
  const max = Math.max(...rows.map((r) => r.usd), 0.0001);
  return rows
    .map((r) => {
      const pct = Math.max(2, Math.round((r.usd / max) * 100));
      return `<div class="bar-row">
        <div class="bar-label" title="${escapeHtml(formatLabel(r))}">${escapeHtml(formatLabel(r))}</div>
        <div class="bar-track"><div class="bar-fill ${escapeHtml(r.cls ?? "")}" style="width:${pct}%"></div></div>
        <div class="bar-value">${r.usd.toFixed(2)} $</div>
      </div>`;
    })
    .join("");
}

const CATEGORY_LABEL = { sessions: "Sessions (interactif)", job: "Jobs de fond", dream: "Cycle Dream" };

async function loadUsage() {
  const u = await getJson("/api/usage?days=30");
  document.getElementById("usage-totals").innerHTML = `
    <div class="k">7 derniers jours</div><div>${(u.totalUsd7 ?? 0).toFixed(2)} $</div>
    <div class="k">30 derniers jours</div><div>${(u.totalUsd ?? 0).toFixed(2)} $</div>
  `;

  const byDayRows = (u.byDay ?? []).map((r) => ({ label: r.day, usd: r.usd ?? 0 }));
  document.getElementById("usage-by-day").innerHTML = barRows(byDayRows, (r) => r.label);

  const byModelRows = (u.byModel ?? []).map((r) => ({
    label: r.model,
    usd: r.usd ?? 0,
    cls: r.provider === "deepseek" ? "deepseek" : r.provider === "codex" ? "codex" : "",
  }));
  document.getElementById("usage-by-model").innerHTML = barRows(byModelRows, (r) => r.label);

  const byCategoryRows = (u.byCategory ?? []).map((r) => ({
    label: CATEGORY_LABEL[r.category] ?? r.category,
    usd: r.usd ?? 0,
    cls: r.category === "job" ? "job" : r.category === "dream" ? "dream" : "",
  }));
  document.getElementById("usage-by-category").innerHTML = barRows(byCategoryRows, (r) => r.label);

  const balanceEl = document.getElementById("usage-deepseek-balance");
  if (u.deepseekBalance) {
    balanceEl.textContent = `Solde DeepSeek (API native) : ${u.deepseekBalance.usd.toFixed(2)} $ — vérifié ${fmtRelative(u.deepseekBalance.checkedAt)}`;
  } else {
    balanceEl.textContent =
      "Solde DeepSeek live : pas encore branché — le daemon n'écrit pas aujourd'hui ce solde en base (voir README).";
  }
}

async function loadApprovals() {
  const { approvals } = await getJson("/api/approvals?limit=15");
  renderRows(
    "approvals-body",
    approvals,
    (a) => `<tr>
      <td>${a.id}</td>
      <td class="truncate" title="${escapeHtml(a.description)}">${escapeHtml(a.description)}</td>
      <td>${escapeHtml(a.kind)}</td>
      <td>${badge(a.status)}</td>
      <td>${fmtRelative(a.created_at)}</td>
    </tr>`,
    "aucune approbation",
  );
}

async function loadCommits() {
  const { commits } = await getJson("/api/commits?limit=20");
  const ul = document.getElementById("commits-body");
  if (!commits.length) {
    ul.innerHTML = `<li class="empty">aucun commit trouvé</li>`;
    return;
  }
  ul.innerHTML = commits
    .map(
      (c) => `<li><span class="hash">${escapeHtml(c.hash.slice(0, 7))}</span> — ${escapeHtml(c.subject)}
        <span class="muted small">(${escapeHtml(new Date(c.date).toLocaleDateString("fr-FR"))})</span></li>`,
    )
    .join("");
}

async function refreshAll() {
  const tasks = [
    loadStatus(),
    loadJobs(),
    loadWakes(),
    loadSensors(),
    loadUsage(),
    loadSessions(),
    loadApprovals(),
    loadCommits(),
    loadSessionFocus(),
  ];
  await Promise.allSettled(tasks);
  document.getElementById("last-refresh").textContent = `actualisé à ${new Date().toLocaleTimeString("fr-FR")}`;
}

document.getElementById("session-focus-close").addEventListener("click", (e) => {
  e.preventDefault();
  location.hash = "";
});
window.addEventListener("hashchange", loadSessionFocus);

// Contexte de session, liens GitHub, panneau Dream : chargés une fois, PAS sur l'intervalle de 30 s
// — re-rendre refermerait un <details> que l'utilisateur vient d'ouvrir. C'est du contenu quasi
// statique (fichiers du dépôt monté, registre knowledge) ; seule la liste des sessions Dream bouge,
// une fois par nuit — un rechargement de page suffit largement à la voir apparaître.
loadContext();
loadGithub();
loadDreamPrompt();
loadModelSetup();
refreshAll();
setInterval(refreshAll, 30000);
