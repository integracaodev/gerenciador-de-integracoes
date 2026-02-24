const { ipcRenderer, clipboard } = require('electron');
const { Terminal }  = require('xterm');
const { FitAddon } = require('@xterm/addon-fit');

const terminals = {};
let activeTab   = null;
let tabOffset   = 0;

// Debug run tracking (no secrets)
const __dbgRuns = {}; // { [batPath]: { runId, startedAt, endedAt, outBytes, outChunks, afterExitLogged } }

// Receive debug events from main and forward to debug ingest.
ipcRenderer.on('agent-debug-log', (_evt, payload) => {
  // #region agent log
  fetch('http://127.0.0.1:7323/ingest/1f0c69e2-0346-404d-8293-c49438d755ed',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'38d153'},body:JSON.stringify(payload)}).catch(()=>{});
  // #endregion
});

/* ---------- barra de abas scrollável ---------- */
function moveTabs(dir) {
  const wrapper = document.getElementById('tabs-wrapper');
  const tabsDiv = document.getElementById('tabs');
  const maxScroll = Math.max(0, tabsDiv.scrollWidth - wrapper.clientWidth);
  tabOffset = Math.min(Math.max(0, tabOffset + dir * 100), maxScroll);
  tabsDiv.style.transform = `translateX(-${tabOffset}px)`;
}
document.getElementById('tab-left' ).onclick = () => moveTabs(-1);
document.getElementById('tab-right').onclick = () => moveTabs(+1);

/* ---------- carrega projetos/bats ---------- */
async function loadProjects() {
  const projects = await ipcRenderer.invoke('list-bats');
  const cont     = document.getElementById('projects');

  // Preservar quais projetos estavam expandidos (evita fechar menu lateral em execução automática)
  const expandedProjects = new Set();
  cont.querySelectorAll('.project').forEach(projectEl => {
    const list = projectEl.querySelector('.project-bats');
    const headerSpan = projectEl.querySelector('.project-header span');
    if (list?.classList.contains('show') && headerSpan) {
      const name = headerSpan.textContent.replace(/^🗀\s*/, '').trim();
      expandedProjects.add(name);
    }
  });

  cont.innerHTML = '';

  Object.entries(projects).forEach(([projName, bats]) => {
    /* cabeçalho + botão "rodar todos" */
    const header = document.createElement('div');
    header.className = 'project-header';

    const title = document.createElement('span');
    title.textContent = '🗀 '+ projName;
    header.appendChild(title);

    const allRunning = bats.every(b => (b?.dbStatus?.status ? b.dbStatus.status === 'running' : !!b.running));

    const playBtn = document.createElement('button');
    playBtn.textContent = allRunning ? '⏹' : '▶';
    playBtn.title       = allRunning ? 'Parar todos' : 'Executar todos';
    playBtn.onclick = e => {
      e.stopPropagation();
      ipcRenderer.send(allRunning ? 'stop-all' : 'run-all', projName);
    };
    header.appendChild(playBtn);

    /* lista de bats (recolhível) */
    const list = document.createElement('div');
    list.className = 'project-bats';
    bats.forEach(b => {
      const container = document.createElement('div');
      container.style.display = 'flex';
      container.style.alignItems = 'center';
      container.style.gap = '8px';
      
      const link = document.createElement('div');
      link.className = 'bat-link';
      link.textContent = b.name;
      link.style.flex = '1';
      link.setAttribute('data-bat-path', b.path); // CRITICAL: Set data attribute for global status tracking
      link.onclick = () => ipcRenderer.send('run-bat', b.path);

      // Verificar status do terminal
      const termEntry = terminals[b.path];
      if (termEntry) {
        if (termEntry.isFinished) {
          // Script terminou
          if (termEntry.exitCode === 0) {
            link.classList.add('success'); // Verde - sucesso
          } else {
            link.classList.add('error'); // Vermelho - erro
          }
        } else {
          link.classList.add('running'); // Verde - rodando
        }
      } else {
        link.classList.add('idle'); // Cinza - parado
      }
      
      // Botão de configuração de agendamento
      const scheduleBtn = document.createElement('button');
      scheduleBtn.className = 'schedule-btn';
      scheduleBtn.innerHTML = '⏱';
      scheduleBtn.title = 'Configurar intervalo';
      scheduleBtn.onclick = (e) => {
        e.stopPropagation();
        openScheduleModal(b.path, b.name);
      };

      // Botão de start/stop (toggle) baseado no status do BANCO (dbStatus),
      // pois em multi-servidor/auto-restart o procMap local pode não refletir o estado desejado.
      // - dbStatus.status === 'running' => ⏹
      // - caso contrário => ▶
      const isRunning = (b?.dbStatus?.status ? b.dbStatus.status === 'running' : !!b.running);
      const startStopBtn = document.createElement('button');
      startStopBtn.className = 'stop-btn';
      startStopBtn.innerHTML = isRunning ? '⏹' : '▶';
      startStopBtn.title = isRunning ? 'Parar script' : 'Iniciar script';
      startStopBtn.onclick = (e) => {
        e.stopPropagation();
        if (isRunning) {
          // Mesmo comportamento do "X" da tab: fecha UI se existir e para o processo
          removeTabUI(b.path);
          ipcRenderer.send('stop-bat', b.path);
          return;
        }
        ipcRenderer.send('run-bat', b.path);
      };
      
      container.appendChild(link);
      container.appendChild(startStopBtn);
      container.appendChild(scheduleBtn);

      list.appendChild(container);
    });

// wrap them so they stay together
    const projectEl = document.createElement('div');
    projectEl.className = 'project';

    projectEl.appendChild(header);
    projectEl.appendChild(list);

    // toggle the list when clicking the header
    header.onclick = () => list.classList.toggle('show');

    // Restaurar estado expandido preservado antes do reload
    if (expandedProjects.has(projName)) list.classList.add('show');

    cont.appendChild(projectEl);
  });
  
  // Update global status after loading projects
  updateGlobalStatus();
  
  // Reapply current filter
  filterProjects(currentFilter);
}

/* ---------- abas ---------- */
function removeTabUI(batPath) {
  const termEntry = terminals[batPath];
  if (!termEntry) return;

  if (termEntry.clearIntervalId) clearInterval(termEntry.clearIntervalId);
  try { termEntry.wrapper?.remove(); } catch {}
  try { termEntry.tab?.remove(); } catch {}
  delete terminals[batPath];

  if (activeTab === batPath) {
    activeTab = null;
    const remaining = Object.keys(terminals);
    if (remaining.length) focusTab(remaining[0]);
  }

  loadProjects();
}

function addTab(batPath) {
  if (terminals[batPath]) {
    // Tab já existe (ex: reinício automático) - atualizar estado sem roubar foco do usuário
    const t = terminals[batPath];
    t.isFinished = false;
    t.exitCode = null;
    if (t.statusIndicator) {
      t.statusIndicator.classList.remove('tab-status-success', 'tab-status-error');
      t.statusIndicator.classList.add('tab-status-running');
      t.statusIndicator.title = 'Executando';
    }
    if (t.tab) t.tab.classList.remove('finished');
    // Reiniciar timer de limpeza periódica da saída
    if (t.clearIntervalId) clearInterval(t.clearIntervalId);
    const CLEAR_MS = 5 * 60 * 1000;
    t.clearIntervalId = setInterval(() => {
      const e = terminals[batPath];
      if (!e || e.isFinished) return;
      try {
        e.term.clear();
        e.term.write('\r\n[Saída limpa - script ainda em execução às ' + new Date().toLocaleTimeString() + ']\r\n');
      } catch (_) {}
    }, CLEAR_MS);
    return;
  }

  const pathSegments = batPath.split(/[\\/]/);
  const name = pathSegments.length >= 2 ? pathSegments.slice(-2)[1] : path.basename(batPath);
  
  // Extract project name from path (e.g., "integracao-autosat" from path)
  const projectNameMatch = batPath.match(/[\\\/]([^\\\/]+)[\\\/](public|bats)[\\\/]/);
  const projectName = projectNameMatch ? projectNameMatch[1] : null;
  
  const tab  = document.createElement('div');
  tab.className = 'tab';
  
  // Add status indicator (colored circle)
  const statusIndicator = document.createElement('span');
  statusIndicator.className = 'tab-status-indicator tab-status-running';
  statusIndicator.title = 'Executando';
  tab.appendChild(statusIndicator);
  
  // Add tab name
  const tabName = document.createElement('span');
  tabName.className = 'tab-name';
  tabName.textContent = name || path.basename(batPath);
  tab.appendChild(tabName);
  
  tab.onclick = () => focusTab(batPath);

  const close = document.createElement('span');
  close.className = 'tab-close';
  close.textContent = 'ˣ';
  close.onclick = e => {
    e.stopPropagation();
    removeTabUI(batPath);
    ipcRenderer.send('stop-bat', batPath);
  };
  tab.appendChild(close);

  const tabsContainer = document.getElementById('tabs');
  tabsContainer.appendChild(tab);

  const wrapper = document.createElement('div');
  wrapper.className = 'terminal-wrapper';
  const term = new Terminal({ convertEol:true });
  const fitAddon = new FitAddon();
  term.loadAddon(fitAddon);
  // Ctrl+C: copiar texto selecionado para a área de transferência
  term.attachCustomKeyEventHandler((e) => {
    if (e.ctrlKey && (e.key === 'c' || e.key === 'C')) {
      const sel = term.getSelection();
      if (sel) {
        clipboard.writeText(sel);
        return true; // evento tratado
      }
    }
    return false;
  });
  term.open(wrapper);
  const termContainer = document.getElementById('terminal-container');
  termContainer.appendChild(wrapper);

  const CLEAR_OUTPUT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutos
  const clearIntervalId = setInterval(() => {
    const entry = terminals[batPath];
    if (!entry || entry.isFinished) return;
    try {
      entry.term.clear();
      entry.term.write('\r\n[Saída limpa - script ainda em execução às ' + new Date().toLocaleTimeString() + ']\r\n');
    } catch (_) {}
  }, CLEAR_OUTPUT_INTERVAL_MS);

  terminals[batPath] = { term, wrapper, tab, isFinished: false, exitCode: null, projectName, statusIndicator, fitAddon, clearIntervalId };
  focusTab(batPath);
}

function focusTab(batPath){
  if(!terminals[batPath]) return;
  if(activeTab){
    terminals[activeTab].wrapper.classList.remove('active');
    terminals[activeTab].tab   .classList.remove('active');
  }
  terminals[batPath].wrapper.classList.add('active');
  terminals[batPath].tab   .classList.add('active');
  activeTab = batPath;
  
  // Fit the terminal to its container after it becomes visible
  setTimeout(() => {
    if (terminals[batPath]?.fitAddon) {
      terminals[batPath].fitAddon.fit();
    }
  }, 10);
}

/* ---------- IPC handlers ---------- */
ipcRenderer.on('bat-started', (_, p) => {
  addTab(p); 
  loadProjects();
  const now = Date.now();
  const runId = `${now}-${Math.random().toString(16).slice(2)}`;
  __dbgRuns[p] = { runId, startedAt: now, endedAt: null, outBytes: 0, outChunks: 0, afterExitLogged: false };
  // #region agent log
  fetch('http://127.0.0.1:7323/ingest/1f0c69e2-0346-404d-8293-c49438d755ed',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'38d153'},body:JSON.stringify({sessionId:'38d153',runId,hypothesisId:'C',location:'renderer.js:bat-started',message:'bat-started received',data:{script:String(p).split(/[\\/]/).slice(-1)[0]||'?',hasTerminal:!!terminals[p]},timestamp:Date.now()})}).catch(()=>{});
  // #endregion
});
ipcRenderer.on('focus-tab',   (_, p)      => focusTab(p));
ipcRenderer.on('terminal-output', (_, {batPath,data}) => {
  const r = __dbgRuns[batPath];
  if (r) {
    const txt = (typeof data === 'string') ? data : String(data ?? '');
    r.outChunks += 1;
    r.outBytes += txt.length;
    // If output arrives after bat-exited, log once
    if (r.endedAt && !r.afterExitLogged) {
      r.afterExitLogged = true;
      // #region agent log
      fetch('http://127.0.0.1:7323/ingest/1f0c69e2-0346-404d-8293-c49438d755ed',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'38d153'},body:JSON.stringify({sessionId:'38d153',runId:r.runId,hypothesisId:'A',location:'renderer.js:terminal-output',message:'terminal-output after bat-exited',data:{script:String(batPath).split(/[\\/]/).slice(-1)[0]||'?',chunkChars:txt.length},timestamp:Date.now()})}).catch(()=>{});
      // #endregion
    }
  }
  terminals[batPath]?.term.write(data.replace(/\n/g,'\r\n'));
});
ipcRenderer.on('bat-exited', (_, data) => {
  const p = typeof data === 'string' ? data : data.fullPath;
  const exitCode = typeof data === 'object' ? data.exitCode : null;
  const t = terminals[p];
  if(!t) return;

  const now = Date.now();
  const r = __dbgRuns[p];
  if (r) {
    r.endedAt = now;
    const durationMs = (r.startedAt ? (now - r.startedAt) : null);
    // #region agent log
    fetch('http://127.0.0.1:7323/ingest/1f0c69e2-0346-404d-8293-c49438d755ed',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'38d153'},body:JSON.stringify({sessionId:'38d153',runId:r.runId,hypothesisId:'B',location:'renderer.js:bat-exited',message:'bat-exited summary',data:{script:String(p).split(/[\\/]/).slice(-1)[0]||'?',exitCode,hadOutput:r.outChunks>0,outChunks:r.outChunks,outChars:r.outBytes,durationMs},timestamp:Date.now()})}).catch(()=>{});
    // #endregion
  }
  
  if (t.clearIntervalId) { clearInterval(t.clearIntervalId); t.clearIntervalId = null; }
  // Mark the terminal as finished but keep it visible
  t.isFinished = true;
  t.exitCode = exitCode;
  
  // Update status indicator based on exit code
  if (t.statusIndicator) {
    t.statusIndicator.classList.remove('tab-status-running');
    if (exitCode === 0) {
      t.statusIndicator.classList.add('tab-status-success');
      t.statusIndicator.title = 'Concluído com sucesso';
    } else {
      t.statusIndicator.classList.add('tab-status-error');
      t.statusIndicator.title = `Erro (código: ${exitCode})`;
    }
  }
  
  if (t.tab) {
    t.tab.classList.add('finished');
  }
  
  if (t.wrapper && activeTab === p) {
    t.wrapper.classList.add('active');
  }
  
  loadProjects();
  // keep dbg run record briefly for "output after exit" detection
  setTimeout(() => { delete __dbgRuns[p]; }, 5000);
});

// Atualizar lista quando comandos remotos são executados
ipcRenderer.on('refresh-projects', () => {
  console.log('[Renderer] Atualizando lista após comando remoto');
  loadProjects();
});

// Fechar tab/terminal quando um STOP remoto for executado
ipcRenderer.on('close-tab', (_, batPath) => {
  removeTabUI(batPath);
});

window.addEventListener('resize', () => moveTabs(0));

/* ---------- Global Status Display ---------- */
let currentFilter = 'all'; // Track current filter

function updateGlobalStatus() {
  let successCount = 0;
  let errorCount = 0;
  let idleCount = 0;
  let allCount = 0;
  
  const projectsDiv = document.getElementById('projects');
  const batLinks = projectsDiv.querySelectorAll('.bat-link');
  
  batLinks.forEach(link => {
    const batPath = link.getAttribute('data-bat-path');
    
    if (batPath) {
      allCount++;
      
      const termEntry = terminals[batPath];
      
      if (termEntry) {
        if (termEntry.isFinished) {
          if (termEntry.exitCode === 0) {
            successCount++;
          } else {
            errorCount++;
          }
        } else {
          successCount++; // Running counts as success
        }
      } else {
        idleCount++;
      }
    }
  });
  
  // Update badge counts
  document.getElementById('global-all-count').textContent = allCount;
  document.getElementById('global-success-count').textContent = successCount;
  document.getElementById('global-idle-count').textContent = idleCount;
  document.getElementById('global-error-count').textContent = errorCount;
}

function filterProjects(status) {
  currentFilter = status;
  
  // Update active badge
  document.querySelectorAll('.global-badge').forEach(badge => {
    badge.classList.remove('active');
  });
  document.getElementById(`global-${status}-badge`).classList.add('active');
  
  const projectsDiv = document.getElementById('projects');
  const projects = projectsDiv.querySelectorAll('.project');
  
  projects.forEach(project => {
    const projectHeader = project.querySelector('.project-header');
    if (!projectHeader) return;
    
    // Get project name from header text
    const projectName = projectHeader.textContent.trim().split('\n')[0].trim();
    
    // Check if this project has any bats matching the filter
    const batLinks = project.querySelectorAll('.bat-link');
    let hasMatchingBats = false;
    
    if (status === 'all') {
      hasMatchingBats = true; // Show all projects
    } else {
      batLinks.forEach(link => {
        const batPath = link.getAttribute('data-bat-path');
        if (!batPath) return;
        
        const termEntry = terminals[batPath];
        let batStatus = 'idle';
        
        if (termEntry) {
          if (termEntry.isFinished) {
            batStatus = termEntry.exitCode === 0 ? 'success' : 'error';
          } else {
            batStatus = 'success'; // Running
          }
        }
        
        if (batStatus === status) {
          hasMatchingBats = true;
        }
      });
    }
    
    if (hasMatchingBats) {
      project.classList.remove('hidden');
    } else {
      project.classList.add('hidden');
    }
  });
}

// Badge click handlers - filter projects instead of showing modal
document.getElementById('global-all-badge').addEventListener('click', () => {
  filterProjects('all');
});

document.getElementById('global-success-badge').addEventListener('click', () => {
  filterProjects('success');
});

document.getElementById('global-idle-badge').addEventListener('click', () => {
  filterProjects('idle');
});

document.getElementById('global-error-badge').addEventListener('click', () => {
  filterProjects('error');
});

/* ---------- Schedule Configuration Modal ---------- */
async function openScheduleModal(scriptPath, scriptName) {
  // Get current schedule if exists
  const schedule = await ipcRenderer.invoke('get-script-schedule', scriptPath);
  
  const enabled = schedule ? schedule.enabled : true;
  const intervalSeconds = schedule ? schedule.interval_seconds : 30;
  
  // Create modal
  const modal = document.createElement('div');
  modal.className = 'modal-overlay';
  modal.innerHTML = `
    <div class="modal-content">
      <h3> Configurar Agendamento</h3>
      <p class="modal-script-name">${scriptName}</p>
      
      <div class="modal-form">
        <label class="checkbox-label">
          <input type="checkbox" id="schedule-enabled" ${enabled ? 'checked' : ''}>
          <span>Ativar execução automática</span>
        </label>
        
        <div class="form-group">
          <label for="schedule-interval">Intervalo entre execuções (segundos):</label>
          <input type="number" id="schedule-interval" value="${intervalSeconds}" min="1" max="3600">
          <small>Após cada execução, o script será reiniciado automaticamente após este intervalo.</small>
        </div>
      </div>
      
      <div class="modal-buttons">
        <button class="btn-primary" id="save-schedule"> Salvar</button>
        <button class="btn-secondary" id="cancel-schedule"> Cancelar</button>
        ${schedule ? '<button class="btn-danger" id="delete-schedule"> Remover Agendamento</button>' : ''}
      </div>
      
      <div id="schedule-message" class="modal-message"></div>
    </div>
  `;
  
  document.body.appendChild(modal);
  
  // Close on overlay click
  modal.addEventListener('click', (e) => {
    if (e.target === modal) {
      document.body.removeChild(modal);
    }
  });
  
  // Save button
  document.getElementById('save-schedule').addEventListener('click', async () => {
    const enabled = document.getElementById('schedule-enabled').checked;
    const intervalSeconds = parseInt(document.getElementById('schedule-interval').value);
    
    if (intervalSeconds < 1) {
      showScheduleMessage('Intervalo deve ser maior que 0 segundos', 'error');
      return;
    }
    
    showScheduleMessage('Salvando...', 'info');
    
    const result = await ipcRenderer.invoke('save-script-schedule', scriptPath, enabled, intervalSeconds);
    
    if (result.success) {
      showScheduleMessage(result.message, 'success');
      setTimeout(() => {
        document.body.removeChild(modal);
        loadProjects();
      }, 1500);
    } else {
      showScheduleMessage(result.message, 'error');
    }
  });
  
  // Cancel button
  document.getElementById('cancel-schedule').addEventListener('click', () => {
    document.body.removeChild(modal);
  });
  
  // Delete button (if exists)
  const deleteBtn = document.getElementById('delete-schedule');
  if (deleteBtn) {
    deleteBtn.addEventListener('click', async () => {
      if (!confirm('Tem certeza que deseja remover o agendamento deste script?')) {
        return;
      }
      
      showScheduleMessage('Removendo...', 'info');
      
      const result = await ipcRenderer.invoke('delete-script-schedule', scriptPath);
      
      if (result.success) {
        showScheduleMessage(result.message, 'success');
        setTimeout(() => {
          document.body.removeChild(modal);
          loadProjects();
        }, 1500);
      } else {
        showScheduleMessage(result.message, 'error');
      }
    });
  }
  
  function showScheduleMessage(message, type) {
    const msgEl = document.getElementById('schedule-message');
    msgEl.textContent = message;
    msgEl.className = `modal-message ${type}`;
  }
}

loadProjects();

// Refit all terminals when window is resized
window.addEventListener('resize', () => {
  Object.values(terminals).forEach(t => {
    if (t.fitAddon) {
      t.fitAddon.fit();
    }
  });
});
