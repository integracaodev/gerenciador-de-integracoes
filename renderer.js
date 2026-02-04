const { ipcRenderer } = require('electron');
const { Terminal }  = require('xterm');
const { FitAddon } = require('@xterm/addon-fit');

const terminals = {};
let activeTab   = null;
let tabOffset   = 0;

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
  cont.innerHTML = '';

  Object.entries(projects).forEach(([projName, bats]) => {
    /* cabeçalho + botão "rodar todos" */
    const header = document.createElement('div');
    header.className = 'project-header';

    const title = document.createElement('span');
    title.textContent = '🗀 '+ projName;
    header.appendChild(title);

    const allRunning  = bats.every(b => b.running);

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
      
      container.appendChild(link);
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
  if (terminals[batPath]) { focusTab(batPath); return; }

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
  term.open(wrapper);
  const termContainer = document.getElementById('terminal-container');
  termContainer.appendChild(wrapper);

  terminals[batPath] = { term, wrapper, tab, isFinished: false, exitCode: null, projectName, statusIndicator, fitAddon };
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
});
ipcRenderer.on('focus-tab',   (_, p)      => focusTab(p));
ipcRenderer.on('terminal-output', (_, {batPath,data}) => {
  terminals[batPath]?.term.write(data.replace(/\n/g,'\r\n'));
});
ipcRenderer.on('bat-exited', (_, data) => {
  const p = typeof data === 'string' ? data : data.fullPath;
  const exitCode = typeof data === 'object' ? data.exitCode : null;
  const t = terminals[p];
  if(!t) return;
  
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
