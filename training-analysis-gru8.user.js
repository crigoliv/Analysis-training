// ==UserScript==
// @name         Training Analysis Report - Receive GRU8
// @namespace    https://github.com/SEU-USUARIO
// @version      1.0.0
// @description  Quem tem registro no Receive/Prep: OK só se concluiu os 4 cursos, ERRO se faltar algum
// @match        *://*/*
// @exclude      *://*fclm*/*
// @grant        GM_registerMenuCommand
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_setClipboard
// @run-at       document-idle
// @noframes
// @updateURL    https://raw.githubusercontent.com/SEU-USUARIO/training-analysis-gru8/main/training-analysis-gru8.user.js
// @downloadURL  https://raw.githubusercontent.com/SEU-USUARIO/training-analysis-gru8/main/training-analysis-gru8.user.js
// ==/UserScript==
(function () {
  'use strict';

  // Não roda no FCLM (proteção extra, caso o @exclude seja ignorado)
  if (/fclm/i.test(location.hostname)) return;

  // Os cursos são descobertos sozinhos a partir do relatório (coluna courseTitle).
  // O curso base é escolhido na tela. Padrão: o primeiro que tiver "prep" no nome.
  let CURSOS = [], BASE = '';

  const NOME_STATUS = {
    completed: 'Concluído', complete: 'Concluído', passed: 'Concluído',
    active: 'Em andamento', inprogress: 'Em andamento', started: 'Em andamento',
    notstarted: 'Não iniciado', enrolled: 'Não iniciado', registered: 'Não iniciado', assigned: 'Não iniciado', notattempted: 'Não iniciado',
    abandoned: 'Abandonado/Cancelado', cancelled: 'Abandonado/Cancelado', canceled: 'Abandonado/Cancelado', withdrawn: 'Abandonado/Cancelado',
    noenrollment: 'Não inscrito'
  };
  const normSt = x => String(x || '').toLowerCase().replace(/[\s_-]+/g, '');

  // Converte data (ISO, dd/mm/aaaa ou mm/dd/aaaa com hora) em número para comparar corretamente
  function paraTempo(v) {
    v = String(v || '').trim();
    if (!v) return 0;
    const m = v.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?)?/i);
    if (m) {
      let [, a, b, y, h = 0, mi = 0, se = 0, ap] = m;
      a = +a; b = +b; y = +y; h = +h; if (y < 100) y += 2000;
      if (ap) { if (/pm/i.test(ap) && h < 12) h += 12; if (/am/i.test(ap) && h === 12) h = 0; }
      const mes = a > 12 ? b : a, dia = a > 12 ? a : b; // relatórios Amazon costumam vir mm/dd
      return Date.UTC(y, mes - 1, dia, h, +mi, +se);
    }
    const t = Date.parse(v.replace(' ', 'T'));
    return isNaN(t) ? 0 : t;
  }

  // ---------- Leitura de CSV ----------
  function parseCSV(text) {
    text = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
    const l1 = text.split('\n')[0];
    const sep = [';', ',', '\t'].sort((a, b) => l1.split(b).length - l1.split(a).length)[0];
    const rows = []; let row = [], cell = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) {
        if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
        else if (c === '"') q = false;
        else cell += c;
      } else if (c === '"') q = true;
      else if (c === sep) { row.push(cell); cell = ''; }
      else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
      else cell += c;
    }
    if (cell || row.length) { row.push(cell); rows.push(row); }
    const head = (rows.shift() || []).map(h => h.trim().toLowerCase().replace(/\s+/g, ''));
    return { head, linhas: rows.filter(r => r.length > 1).map(r => Object.fromEntries(head.map((h, i) => [h, (r[i] || '').trim()]))) };
  }

  const lerArquivo = f => new Promise((ok, erro) => {
    const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = erro; r.readAsText(f, 'utf-8');
  });

  // Nome do curso = título; se não tiver título, usa o código do link
  function qualCurso(t) {
    const nome = (t.coursetitle || '').trim();
    if (nome) return nome;
    const id = (String(t.courseid || '').match(/course\/([0-9a-f-]+)/i) || [])[1];
    return id ? 'Curso ' + id.slice(0, 8) : null;
  }

  function descobrirCursos(linhas) {
    const set = new Set();
    linhas.forEach(t => { const c = qualCurso(t); if (c) set.add(c); });
    return [...set].sort((a, b) => a.localeCompare(b));
  }

  // Vale o registro MAIS RECENTE do curso (ignorando "não inscrito"), fiel ao relatório:
  // - "active" sem data de início e sem progresso = Não iniciado (só inscrito)
  // - status desconhecido aparece com o texto original do relatório
  function statusReg(r) {
    if (r.s === 'active' && !r.ini && !(r.prog > 0)) return 'Não iniciado';
    return NOME_STATUS[r.s] || r.bruto || r.s;
  }
  function melhorStatus(regs) {
    if (!regs || !regs.length) return 'Sem registro';
    const reais = regs.filter(r => r.s && r.s !== 'noenrollment');
    if (!reais.length) return NOME_STATUS.noenrollment;
    reais.sort((a, b) => a.t - b.t);
    return statusReg(reais[reais.length - 1]);
  }

  // ---------- Regra principal ----------
  function processar(A, B) {
    // Descobre sozinho qual arquivo é o relatório e qual é o roster
    let treino = A, roster = B;
    if (!A.head.includes('coursetitle') && B.head.includes('coursetitle')) { treino = B; roster = A; }
    if (!treino.head.includes('login')) throw new Error('Não achei a coluna "login" no relatório de treinamentos. Colunas lidas: ' + treino.head.join(', '));

    if (!CURSOS.length) CURSOS = descobrirCursos(treino.linhas);
    const ros = new Map();
    roster.linhas.forEach(e => { const l = (e.userid || '').toLowerCase(); if (l) ros.set(l, e); });

    const mapa = new Map();
    treino.linhas.forEach(t => {
      const l = (t.login || '').toLowerCase();
      const c = qualCurso(t);
      if (!l || !c) return;
      if (!mapa.has(l)) mapa.set(l, { info: t, st: {} });
      const m = mapa.get(l).st;
      const ini = t.starteddatetimeutc || t.starteddate || '';
      const prog = parseFloat(String(t.progress || t.percentcomplete || t.completionpercentage || '').replace(',', '.').replace('%', '')) || 0;
      (m[c] = m[c] || []).push({
        s: normSt(t.status), bruto: (t.status || '').trim(), ini, prog,
        t: Math.max(paraTempo(t.completeddatetimeutc), paraTempo(ini), paraTempo(t.createddatetimeutc), paraTempo(t.lastmodifieddatetimeutc))
      });
    });

    const res = [];
    mapa.forEach((v, l) => {
      const base = BASE ? v.st[BASE] : Object.values(v.st).flat();
      // precisa ter registro real no Prep (não conta "não inscrito")
      if (!base || !base.some(r => r.s && r.s !== 'noenrollment')) return;
      if (ros.size && !ros.has(l)) return; // só quem está no roster

      const e = ros.get(l) || {};
      const linha = {
        Resultado: '',
        Login: l,
        Nome: e.employeename || ((v.info.firstname || '') + ' ' + (v.info.lastname || '')).trim(),
        Gestor: e.managername || '',
        Turno: v.info.shiftcode || ''
      };
      const faltando = [];
      CURSOS.forEach(c => {
        linha[c] = melhorStatus(v.st[c]);
        if (linha[c] !== 'Concluído') faltando.push(c);
      });
      linha.Resultado = faltando.length ? 'ERRO' : 'OK';
      linha['Material pendente'] = faltando.join(', ') || '-';
      res.push(linha);
    });
    return { res, nTreino: treino.linhas.length, nRoster: ros.size };
  }

  // ---------- Interface ----------
  const css = `
  #tp-fab{position:fixed;bottom:22px;right:22px;z-index:2147483646;display:flex;align-items:center;gap:8px;padding:11px 18px;
    background:linear-gradient(135deg,#5b8def,#7aa7f7);color:#fff;border:none;border-radius:999px;font:600 14px 'Segoe UI',Arial,sans-serif;
    box-shadow:0 6px 18px rgba(91,141,239,.35);cursor:pointer}
  #tp-fab:hover{transform:translateY(-2px)}
  #tp-overlay{display:none;position:fixed;inset:0;background:#f7f9fc;z-index:2147483647}
  #tp-root{position:absolute;inset:0;width:100%;height:100%;background:#f7f9fc;border-radius:0;overflow:hidden;display:flex;flex-direction:column;
    font:14px 'Segoe UI',Arial,sans-serif;color:#334155;}
  #tp-root *{box-sizing:border-box;font-family:inherit}
  .tp-top{display:flex;justify-content:space-between;align-items:center;padding:18px 26px;background:#fff;border-bottom:1px solid #e6ebf2}
  .tp-title{display:flex;align-items:center;gap:12px}
  .tp-logo{width:40px;height:40px;border-radius:10px;background:linear-gradient(135deg,#dbe7ff,#eef3ff);display:flex;align-items:center;justify-content:center;font-size:20px}
  .tp-title h2{margin:0;font-size:19px;font-weight:600;color:#1e293b}
  .tp-title small{color:#94a3b8;font-size:12px}
  .tp-x{border:none;background:#f1f5f9;width:34px;height:34px;border-radius:50%;cursor:pointer;font-size:15px;color:#64748b}
  .tp-x:hover{background:#e2e8f0}
  .tp-body{flex:1;overflow:auto;padding:20px 26px}
  .tp-card{background:#fff;border:1px solid #e6ebf2;border-radius:12px;padding:16px 18px;margin-bottom:16px}
  .tp-card h3{margin:0 0 12px;font-size:13px;font-weight:600;color:#64748b;text-transform:uppercase;letter-spacing:.5px}
  .tp-files{display:flex;gap:14px;align-items:flex-end;flex-wrap:wrap}
  .tp-drop{flex:1;min-width:240px;border:1.5px dashed #c7d4ea;border-radius:10px;padding:10px 14px;background:#fafcff;cursor:pointer;display:block}
  .tp-drop:hover{border-color:#5b8def;background:#f3f7ff}
  .tp-drop b{display:block;font-size:13px;color:#1e293b}
  .tp-drop span{font-size:12px;color:#94a3b8}
  .tp-drop input{display:none}
  .tp-drop.ok{border-style:solid;border-color:#86d3a7;background:#f2fbf6}
  .tp-btn{border:none;border-radius:9px;padding:10px 20px;font-weight:600;cursor:pointer;font-size:14px}
  .tp-primary{background:#5b8def;color:#fff}.tp-primary:hover{background:#4a7de0}
  .tp-ghost{background:#f1f5f9;color:#475569}.tp-ghost:hover{background:#e2e8f0}
  .tp-kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-bottom:16px}
  .tp-kpi{background:#fff;border:1px solid #e6ebf2;border-radius:12px;padding:14px 18px;border-left:4px solid #5b8def}
  .tp-kpi .l{font-size:12px;color:#94a3b8;text-transform:uppercase;letter-spacing:.5px}
  .tp-kpi .v{font-size:26px;font-weight:700;color:#1e293b;margin-top:4px}
  .tp-kpi.ok{border-left-color:#4cbb82}.tp-kpi.ok .v{color:#2f9e66}
  .tp-kpi.er{border-left-color:#ef7d7d}.tp-kpi.er .v{color:#d65a5a}
  .tp-bar{height:6px;background:#eef2f7;border-radius:6px;margin-top:8px;overflow:hidden}
  .tp-bar div{height:100%;background:linear-gradient(90deg,#4cbb82,#7fd6a6)}
  .tp-filters{display:grid;grid-template-columns:2fr 2fr 1fr 1fr auto;gap:12px;align-items:end}
  .tp-f label{display:block;font-size:12px;color:#64748b;margin-bottom:5px;font-weight:600}
  .tp-f input,.tp-f select,.tp-f textarea{width:100%;padding:9px 11px;border:1px solid #d9e1ec;border-radius:8px;background:#fff;font-size:13px;color:#334155;outline:none}
  .tp-f input:focus,.tp-f select:focus,.tp-f textarea:focus{border-color:#5b8def;box-shadow:0 0 0 3px rgba(91,141,239,.15)}
  .tp-f textarea{resize:vertical;min-height:60px;font-family:Consolas,monospace}
  .tp-nf{font-size:12px;margin-top:6px;color:#64748b;white-space:normal;word-break:break-word}
  .tp-tablewrap{background:#fff;border:1px solid #e6ebf2;border-radius:12px;overflow:auto;max-height:calc(100vh - 430px);min-height:250px}
  .tp-table{border-collapse:separate;border-spacing:0;width:100%;font-size:13px}
  .tp-table th{position:sticky;top:0;background:#dbe7ff;color:#1e3a8a;font-weight:700;font-size:13px;text-align:left;padding:13px 14px;border-bottom:3px solid #5b8def;white-space:nowrap;z-index:1;letter-spacing:.2px}
  .tp-table th:first-child{border-top-left-radius:12px}.tp-table th:last-child{border-top-right-radius:12px}
  .tp-table td{padding:10px 12px;border-bottom:1px solid #f0f3f8;white-space:nowrap}
  .tp-table tr:hover td{background:#f8faff}
  .tp-tag{display:inline-block;padding:3px 10px;border-radius:999px;font-size:12px;font-weight:600}
  .t-ok{background:#e6f6ee;color:#2f9e66}.t-er{background:#fdeaea;color:#d65a5a}
  .t-and{background:#fff5dc;color:#b7861b}.t-ni{background:#eef1f5;color:#7b8794}
  .tp-login{font-weight:600;color:#1e293b}
  .tp-empty{padding:40px;text-align:center;color:#94a3b8}
  .tp-extra{display:inline-block;font-size:13px;font-weight:600;color:#1e3a8a;background:#eef3ff;border:1px solid #c9d8fb;border-left:4px solid #5b8def;border-radius:8px;padding:8px 14px;margin:0 0 12px}
  .tp-pitem{border-bottom:1px solid #f0f3f8}
  .tp-pitem:last-child{border-bottom:none}
  .tp-prow{display:flex;align-items:center;gap:12px;padding:10px 4px;cursor:pointer}
  .tp-prow:hover{background:#f8faff}
  .tp-pseta{color:#94a3b8;display:inline-block;transition:transform .2s;margin-right:6px}
  .tp-pitem.aberto .tp-pseta{transform:rotate(90deg)}
  .tp-pnome{flex:1;font-weight:600;color:#1e293b}
  .tp-pqtd{color:#d65a5a;font-weight:600;min-width:200px}
  .tp-psm{padding:7px 12px;font-size:12px}
  .tp-plog{display:none;padding:0 4px 14px 26px}
  .tp-pitem.aberto .tp-plog{display:block}
  .tp-plog textarea{width:100%;min-height:60px;padding:8px 10px;border:1px solid #d9e1ec;border-radius:8px;background:#fafcff;font:12px Consolas,monospace;color:#334155;resize:vertical;outline:none}
  .tp-plogbar{display:flex;justify-content:space-between;align-items:center;margin-top:8px;font-size:12px;color:#64748b}
  .tp-table th{cursor:pointer;user-select:none}
  .tp-table th:hover{background:#c9d9ff}
  .tp-table th .tp-ord{font-size:10px;margin-left:6px;color:#5b8def}
  `;
  // Remove versões antigas que ainda estejam na página
  document.querySelectorAll('#tp-host').forEach(e => e.remove());
  const host = document.createElement('div'); host.id = 'tp-host';
  document.body.appendChild(host);
  const root = host.attachShadow({ mode: 'open' });
  const st = document.createElement('style'); st.textContent = css; root.appendChild(st);

  const btn = document.createElement('button');
  btn.id = 'tp-fab'; btn.innerHTML = '📊 Analysis training ';
  root.appendChild(btn);

  const overlay = document.createElement('div');
  overlay.id = 'tp-overlay';
  overlay.innerHTML = `
  <div id="tp-root">
    <div class="tp-top">
      <div class="tp-title"><div class="tp-logo">🎓</div>
        <div><h2>Análise de Treinamento <span style="font-size:11px;background:#eef3ff;color:#5b8def;padding:2px 8px;border-radius:999px;vertical-align:middle">v5.8</span></h2><small id="tp-sub">Os cursos são reconhecidos automaticamente pelo relatório</small></div></div>
      <button class="tp-x" id="tp-fechar" title="Fechar">✕</button>
    </div>
    <div class="tp-body">
      <div class="tp-card"><h3>Arquivos</h3>
        <div class="tp-files">
          <label class="tp-drop" id="tp-da"><b>📄 Relatório de treinamentos</b><span id="tp-na">Clique para escolher o CSV</span><input type="file" id="tp-a" accept=".csv"></label>
          <label class="tp-drop" id="tp-db"><b>👥 Roster</b><span id="tp-nb">Clique para escolher o CSV</span><input type="file" id="tp-b" accept=".csv"></label>
          <button class="tp-btn tp-primary" id="tp-gerar">Gerar análise</button>
          <button class="tp-btn tp-ghost" id="tp-exportar" title="Exporta a tabela com os filtros e a ordenação atuais">⬇ Exportar relatório</button>
        </div>
        <div class="tp-filters" id="tp-cfg" style="display:none;margin-top:14px;grid-template-columns:2fr 3fr">
          <div class="tp-f"><label>Curso base (quem entra na lista)</label><select id="tp-base"></select></div>
          <div class="tp-f"><label>Cursos encontrados no relatório</label><div id="tp-lista" style="font-size:12px;color:#64748b;padding-top:6px"></div></div>
        </div>
      </div>
      <div class="tp-kpis">
        <div class="tp-kpi"><div class="l">Associados</div><div class="v" id="k-tot">–</div></div>
        <div class="tp-kpi ok"><div class="l">OK</div><div class="v" id="k-ok">–</div></div>
        <div class="tp-kpi er"><div class="l">Erro</div><div class="v" id="k-er">–</div></div>
        <div class="tp-kpi"><div class="l">% Concluído</div><div class="v" id="k-pc">–</div><div class="tp-bar"><div id="k-bar" style="width:0%"></div></div></div>
      </div>
      <div class="tp-card"><h3>Filtros</h3>
        <div class="tp-filters">
          <div class="tp-f"><label>Associado</label><input id="tp-busca" placeholder="Login ou nome..."></div>
          <div class="tp-f"><label>Gestor</label><input id="tp-gestor" placeholder="Nome do gestor..."></div>
          <div class="tp-f"><label>Turno</label><select id="tp-turno"><option value="">Todos</option></select></div>
          <div class="tp-f"><label>Resultado</label><select id="tp-res"><option value="">Todos</option><option>ERRO</option><option>OK</option></select></div>
          <button class="tp-btn tp-ghost" id="tp-limpar">Limpar</button>
        </div>
        <div class="tp-f" style="margin-top:12px">
          <label>Logins em massa (cole vários: um por linha, vírgula, ponto e vírgula ou espaço)</label>
          <textarea id="tp-lote" rows="3" placeholder="login1&#10;login2&#10;login3"></textarea>
          <div class="tp-nf" id="tp-nf"></div>
        </div>
      </div>
      <div class="tp-extra" id="tp-info"></div>
      <div class="tp-tablewrap" id="tp-tabela"><div class="tp-empty">Escolha os arquivos e clique em <b>Gerar análise</b>.</div></div>
      <div class="tp-card" id="tp-pend" style="display:none;margin-top:16px"><h3>Pendências por material</h3><div id="tp-pendlista"></div></div>
    </div>
  </div>`;
  root.appendChild(overlay);

  const $ = id => overlay.querySelector('#' + id);
  let arqA = null, arqB = null;
  let dados = [], extra = '', cache = [], colunas = [], listaAtual = [], mostrados = 0;
  const POR_PAGINA = 150;

  // ---------- Ordenação ----------
  let ordCol = '', ordDir = 0; // 0 = sem ordenação, 1 = A→Z, -1 = Z→A
  const PESO_STATUS = { 'OK': 0, 'Concluído': 0, 'Em andamento': 1, 'Não iniciado': 2, 'Abandonado/Cancelado': 3, 'Não inscrito': 4, 'Sem registro': 5, 'ERRO': 6 };
  const comparar = (a, b) => {
    const pa = PESO_STATUS[a], pb = PESO_STATUS[b];
    if (pa !== undefined && pb !== undefined) return pa - pb;
    return String(a || '').localeCompare(String(b || ''), 'pt-BR', { numeric: true, sensitivity: 'base' });
  };

  const abrir = () => { overlay.style.display = 'block'; document.documentElement.style.overflow = 'hidden'; };
  const fechar = () => { overlay.style.display = 'none'; document.documentElement.style.overflow = ''; };
  btn.onclick = abrir;
  if (typeof GM_registerMenuCommand === 'function') GM_registerMenuCommand('📋 Abrir Treinamentos', abrir);
  $('tp-fechar').onclick = fechar;
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && overlay.style.display === 'block') fechar(); });

  [['tp-a', 'tp-na', 'tp-da'], ['tp-b', 'tp-nb', 'tp-db']].forEach(([i, n, d]) =>
    $(i).addEventListener('change', () => { const f = $(i).files[0]; if (f) { $(n).textContent = '✔ ' + f.name; $(d).classList.add('ok'); } }));

  const semAcento = x => String(x || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

  $('tp-gerar').onclick = async () => {
    const f1 = $('tp-a').files[0], f2 = $('tp-b').files[0];
    if (!f1) return alert('Selecione pelo menos o relatório de treinamentos.');
    $('tp-tabela').innerHTML = '<div class="tp-empty">Processando...</div>';
    await new Promise(r => setTimeout(r, 30));
    try {
      arqA = parseCSV(await lerArquivo(f1));
      arqB = f2 ? parseCSV(await lerArquivo(f2)) : { head: [], linhas: [] };
      const tr = arqA.head.includes('coursetitle') ? arqA : arqB;
      CURSOS = descobrirCursos(tr.linhas);
      if (!CURSOS.length) throw new Error('Não encontrei nenhum curso no relatório (coluna courseTitle).');
      BASE = CURSOS.find(c => /prep/i.test(c)) || '';
      $('tp-base').innerHTML = '<option value="">Qualquer curso (todos com registro)</option>' + CURSOS.map(c => `<option${c === BASE ? ' selected' : ''}>${c}</option>`).join('');
      $('tp-lista').innerHTML = CURSOS.map(c => `<span class="tp-tag t-ni" style="margin:0 4px 4px 0">${c}</span>`).join('');
      $('tp-sub').textContent = CURSOS.length + ' cursos reconhecidos automaticamente';
      $('tp-cfg').style.display = 'grid';
      gerar();
    } catch (e) {
      $('tp-tabela').innerHTML = `<div class="tp-empty" style="color:#d65a5a">${e.message}</div>`;
    }
  };

  $('tp-base').addEventListener('change', () => { BASE = $('tp-base').value; gerar(); });

  function gerar() {
    try {
      const r = processar(arqA, arqB);
      dados = r.res.sort((a, b) => a.Resultado.localeCompare(b.Resultado) || a.Nome.localeCompare(b.Nome));
      cache = dados.map(d => ({ d, a: semAcento(d.Login + ' ' + d.Nome), g: semAcento(d.Gestor) }));
      colunas = dados.length ? Object.keys(dados[0]) : [];
      const turnos = [...new Set(dados.map(d => d.Turno).filter(Boolean))].sort();
      $('tp-turno').innerHTML = '<option value="">Todos</option>' + turnos.map(t => `<option>${t}</option>`).join('');
      extra = `Linhas lidas: relatório ${r.nTreino} · roster ${r.nRoster}`;
      mostrar();
    } catch (e) {
      $('tp-tabela').innerHTML = `<div class="tp-empty" style="color:#d65a5a">${e.message}</div>`;
    }
  }

  const ids = ['tp-busca', 'tp-res', 'tp-turno', 'tp-gestor', 'tp-lote'];
  let timer;
  const agendar = () => { clearTimeout(timer); timer = setTimeout(mostrar, 250); };
  ids.forEach(id => $(id).addEventListener(['tp-busca', 'tp-gestor', 'tp-lote'].includes(id) ? 'input' : 'change', agendar));
  $('tp-limpar').onclick = () => { ids.forEach(id => $(id).value = ''); ordCol = ''; ordDir = 0; mostrar(); };

  const tag = v => {
    const c = { 'OK': 't-ok', 'Concluído': 't-ok', 'ERRO': 't-er', 'Abandonado/Cancelado': 't-er', 'Em andamento': 't-and', 'Não iniciado': 't-ni', 'Não inscrito': 't-ni', 'Sem registro': 't-ni' }[v];
    return c ? `<span class="tp-tag ${c}">${v}</span>` : v;
  };

  function linhaHTML(d) {
    let h = '<tr>';
    for (const k of colunas) h += `<td${k === 'Login' ? ' class="tp-login"' : ''}>${tag(d[k])}</td>`;
    return h + '</tr>';
  }

  function mostrar() {
    if (!dados.length) return;
    const b = semAcento($('tp-busca').value), s = $('tp-res').value, tu = $('tp-turno').value, g = semAcento($('tp-gestor').value);
    // Logins em massa: separa por linha, vírgula, ponto e vírgula ou espaço; remove @dominio se vier e-mail
    const lote = new Set($('tp-lote').value.toLowerCase().split(/[\s,;]+/).map(x => x.replace(/@.*$/, '').trim()).filter(Boolean));
    if (lote.size) {
      const achados = new Set(dados.map(d => d.Login));
      const nf = [...lote].filter(x => !achados.has(x));
      $('tp-nf').innerHTML = `🔎 ${lote.size} logins colados · <b style="color:#2f9e66">${lote.size - nf.length} encontrados</b>` +
        (nf.length ? ` · <b style="color:#d65a5a">${nf.length} não encontrados:</b> ${nf.join(', ')}` : '');
    } else $('tp-nf').textContent = '';
    const base = [];
    for (const c of cache) {
      if (lote.size && !lote.has(c.d.Login)) continue;
      if (tu && c.d.Turno !== tu) continue;
      if (g && !c.g.includes(g)) continue;
      if (b && !c.a.includes(b)) continue;
      base.push(c.d);
    }
    listaAtual = s ? base.filter(d => d.Resultado === s) : base;
    if (ordCol && ordDir) listaAtual = [...listaAtual].sort((x, y) => comparar(x[ordCol], y[ordCol]) * ordDir);
    let ok = 0; for (const d of base) if (d.Resultado === 'OK') ok++;
    const pc = base.length ? Math.round(ok / base.length * 100) : 0;
    $('k-tot').textContent = base.length; $('k-ok').textContent = ok; $('k-er').textContent = base.length - ok;
    $('k-pc').textContent = pc + '%'; $('k-bar').style.width = pc + '%';
    $('tp-info').textContent = `📊 ${listaAtual.length} resultados  ·  ${extra}`;
    mostrarPendencias(base);
    if (!listaAtual.length) { $('tp-tabela').innerHTML = '<div class="tp-empty">Nenhum resultado para esses filtros.</div>'; return; }
    mostrados = 0;
    $('tp-tabela').innerHTML = `<table class="tp-table"><thead><tr>${colunas.map(k => `<th data-col="${k}">${k}<span class="tp-ord">${k === ordCol && ordDir ? (ordDir === 1 ? '▲' : '▼') : '⇅'}</span></th>`).join('')}</tr></thead><tbody id="tp-tbody"></tbody></table>
      <div style="text-align:center;padding:12px"><button class="tp-btn tp-ghost" id="tp-mais">Mostrar mais</button></div>`;
    $('tp-mais').onclick = maisLinhas;
    maisLinhas();
  }

  function maisLinhas() {
    const fim = Math.min(mostrados + POR_PAGINA, listaAtual.length);
    let h = '';
    for (let i = mostrados; i < fim; i++) h += linhaHTML(listaAtual[i]);
    $('tp-tbody').insertAdjacentHTML('beforeend', h);
    mostrados = fim;
    const bt = $('tp-mais');
    if (mostrados >= listaAtual.length) bt.parentNode.style.display = 'none';
    else bt.textContent = `Mostrar mais (${mostrados} de ${listaAtual.length})`;
  }

  // Carrega mais linhas sozinho ao chegar perto do fim da tabela
  $('tp-tabela').addEventListener('scroll', e => {
    const el = e.target;
    if (mostrados < listaAtual.length && el.scrollTop + el.clientHeight > el.scrollHeight - 200) maisLinhas();
  }, { passive: true });

  // ---------- Exportar relatório (CSV para Excel) ----------
  $('tp-exportar').onclick = () => {
    if (!listaAtual.length) return alert('Gere a análise primeiro (ou ajuste os filtros: não há resultados para exportar).');
    const esc = v => { v = String(v ?? ''); return /[";\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
    const linhas = [colunas.map(esc).join(';')].concat(listaAtual.map(d => colunas.map(k => esc(d[k])).join(';')));
    const blob = new Blob(['\uFEFF' + linhas.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const agora = new Date(), z = n => String(n).padStart(2, '0');
    const nome = `Analise_Treinamento_GRU8_${agora.getFullYear()}-${z(agora.getMonth() + 1)}-${z(agora.getDate())}_${z(agora.getHours())}${z(agora.getMinutes())}.csv`;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = nome;
    root.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  // Clique no cabeçalho: A→Z, Z→A e volta à ordem original
  $('tp-tabela').addEventListener('click', e => {
    const th = e.target.closest('th[data-col]');
    if (!th) return;
    const col = th.dataset.col;
    if (ordCol !== col) { ordCol = col; ordDir = 1; }
    else if (ordDir === 1) ordDir = -1;
    else { ordCol = ''; ordDir = 0; }
    mostrar();
  });

  // ---------- Pendências por material + logins + botão Registrar (Umbrella) ----------
  let pendAtual = [];
  const abertos = new Set(); // materiais com a lista de logins aberta
  const lerLinks = () => { try { return JSON.parse(GM_getValue('umbrellaLinks', '{}')) || {}; } catch (e) { return {}; } };
  const salvarLinks = l => GM_setValue('umbrellaLinks', JSON.stringify(l));
  const copiar = txt => {
    if (typeof GM_setClipboard === 'function') GM_setClipboard(txt, 'text');
    else if (navigator.clipboard) navigator.clipboard.writeText(txt);
  };
  const pedirLink = (c, atual) => {
    const u = prompt(`Cole o link da baixa no Umbrella para o material:\n\n${c}`, atual || '');
    if (u === null) return null;
    const links = lerLinks();
    if (u.trim()) links[c] = u.trim(); else delete links[c];
    salvarLinks(links);
    return u.trim() || null;
  };
  const avisar = (bt, msg) => {
    const txt = bt.textContent;
    bt.textContent = msg;
    setTimeout(() => { bt.textContent = txt; }, 2500);
  };

  function mostrarPendencias(base) {
    const por = {}; CURSOS.forEach(c => por[c] = []);
    base.forEach(d => {
      if (d.Resultado !== 'ERRO') return;
      CURSOS.forEach(c => { if (d[c] !== 'Concluído') por[c].push(d.Login); });
    });
    pendAtual = CURSOS.filter(c => por[c].length).map(c => ({ c, logins: por[c] }));
    if (!pendAtual.length) { $('tp-pend').style.display = 'none'; return; }
    const links = lerLinks();
    $('tp-pendlista').innerHTML = pendAtual.map((p, i) => `
      <div class="tp-pitem${abertos.has(p.c) ? ' aberto' : ''}" data-item="${i}">
        <div class="tp-prow" data-i="${i}">
          <div class="tp-pnome"><span class="tp-pseta">▶</span>${p.c}</div>
          <div class="tp-pqtd">${p.logins.length} associado${p.logins.length > 1 ? 's' : ''} em erro</div>
          <button class="tp-btn tp-ghost tp-psm" data-i="${i}" data-a="ver">👁 Logins</button>
          <button class="tp-btn tp-primary tp-psm" data-i="${i}" data-a="reg">📋 Registrar</button>
          <button class="tp-btn tp-ghost tp-psm" data-i="${i}" data-a="link" title="${links[p.c] ? 'Alterar link' : 'Sem link salvo'}">🔗 ${links[p.c] ? 'Link' : 'Definir link'}</button>
        </div>
        <div class="tp-plog">
          <textarea readonly>${p.logins.join(', ')}</textarea>
          <div class="tp-plogbar">
            <span>${p.logins.length} login${p.logins.length > 1 ? 's' : ''} separados por vírgula</span>
            <button class="tp-btn tp-primary tp-psm" data-i="${i}" data-a="copy">📄 Copiar logins</button>
          </div>
        </div>
      </div>`).join('');
    $('tp-pend').style.display = 'block';
  }

  $('tp-pendlista').addEventListener('click', e => {
    const bt = e.target.closest('button[data-a]');
    const row = e.target.closest('.tp-prow');
    if (!bt && !row) return;
    const p = pendAtual[+(bt || row).dataset.i];
    if (!p) return;
    const item = (bt || row).closest('.tp-pitem');

    // Clicar no material (ou em "Logins") abre/fecha a lista
    if (!bt || bt.dataset.a === 'ver') {
      if (abertos.has(p.c)) abertos.delete(p.c); else abertos.add(p.c);
      item.classList.toggle('aberto', abertos.has(p.c));
      return;
    }
    if (bt.dataset.a === 'copy') {
      copiar(p.logins.join(', '));
      avisar(bt, `✔ ${p.logins.length} copiados`);
      return;
    }
    if (bt.dataset.a === 'link') { pedirLink(p.c, lerLinks()[p.c]); mostrar(); return; }
    // Registrar
    let url = lerLinks()[p.c] || pedirLink(p.c, '');
    if (!url) return;
    copiar(p.logins.join(', '));
    window.open(url, '_blank');
    avisar(bt, `✔ ${p.logins.length} logins copiados`);
  });

  console.log('[Treinamentos] script carregado (v5.8)');
})();
