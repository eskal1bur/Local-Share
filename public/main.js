let ws;
let refreshInterval;
let lastViewedToken = null;

const SAVED_PASS_KEY = 'localshare_password';

// Очередь загрузок
const uploadQueue = [];
let currentUpload = null;

// Выделение файлов
let selectionMode = false;
const selectedItems = new Set();

// Сортировка
let currentSort = { field: 'name', order: 'asc' };

// Текущие данные
let currentItems = [];
let currentPath = '/';

// Флаг инициализации обработчиков загрузок
let uploadListenersAttached = false;

// DOM элементы
const auth = document.getElementById('auth');
const app = document.getElementById('app');
const fileList = document.getElementById('fileList');
const pathSpan = document.getElementById('path');
const fileInput = document.getElementById('fileInput');
const uploadInfo = document.getElementById('uploadInfo');
const viewer = document.getElementById('viewer');
const viewerContent = document.getElementById('viewerContent');
const closeViewer = document.getElementById('closeViewer');

// ========== Очистка медиа ==========
async function closeViewerCompletely() {
  const video = viewerContent.querySelector('video');
  if (video) {
    video.pause();
    video.removeAttribute('src');
    video.load();
    video.querySelectorAll('source').forEach(s => s.remove());
  }
  
  const audio = viewerContent.querySelector('audio');
  if (audio) {
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    audio.querySelectorAll('source').forEach(s => s.remove());
  }
  
  const iframe = viewerContent.querySelector('iframe');
  if (iframe) {
    iframe.src = 'about:blank';
  }
  
  const img = viewerContent.querySelector('img');
  if (img) {
    img.removeAttribute('src');
  }
  
  viewerContent.innerHTML = '';
  viewer.hidden = true;
  lastViewedToken = null;
  
  await new Promise(resolve => setTimeout(resolve, 100));
}

closeViewer.onclick = closeViewerCompletely;

document.querySelector('.viewer-overlay').onclick = (e) => {
  if (e.target.classList.contains('viewer-overlay')) {
    closeViewerCompletely();
  }
};

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (!viewer.hidden) {
      closeViewerCompletely();
    } else if (selectionMode) {
      exitSelectionMode();
    }
  }
});

// ========== Сортировка ==========
function getFileExtension(filename) {
  const parts = filename.split('.');
  return parts.length > 1 ? parts.pop().toLowerCase() : '';
}

function sortItems(items) {
  const sorted = [...items];
  
  sorted.sort((a, b) => {
    if (a.type !== b.type) {
      return a.type === 'dir' ? -1 : 1;
    }
    
    let comparison = 0;
    
    switch (currentSort.field) {
      case 'name':
        comparison = a.name.localeCompare(b.name, 'ru', { numeric: true });
        break;
      case 'size':
        comparison = (a.size || 0) - (b.size || 0);
        break;
      case 'date':
        comparison = (a.modified || 0) - (b.modified || 0);
        break;
      case 'type':
        const extA = getFileExtension(a.name);
        const extB = getFileExtension(b.name);
        comparison = extA.localeCompare(extB);
        if (comparison === 0) {
          comparison = a.name.localeCompare(b.name, 'ru', { numeric: true });
        }
        break;
    }
    
    return currentSort.order === 'asc' ? comparison : -comparison;
  });
  
  return sorted;
}

function setSort(field) {
  if (currentSort.field === field) {
    currentSort.order = currentSort.order === 'asc' ? 'desc' : 'asc';
  } else {
    currentSort.field = field;
    currentSort.order = 'asc';
  }
  
  updateSortButtons();
  render(currentPath, currentItems);
}

function updateSortButtons() {
  document.querySelectorAll('.sort-btn').forEach(btn => {
    const field = btn.dataset.sort;
    btn.classList.remove('active', 'asc', 'desc');
    
    if (field === currentSort.field) {
      btn.classList.add('active', currentSort.order);
    }
  });
}

// ========== Режим выделения ==========
function toggleSelectionMode() {
  selectionMode = !selectionMode;
  selectedItems.clear();
  
  document.getElementById('selectModeBtn').classList.toggle('active', selectionMode);
  document.getElementById('selectionActions').hidden = !selectionMode;
  document.getElementById('selectAllBtn').textContent = 'Выбрать всё';
  
  render(currentPath, currentItems);
  updateSelectionCount();
}

function exitSelectionMode() {
  selectionMode = false;
  selectedItems.clear();
  
  document.getElementById('selectModeBtn').classList.remove('active');
  document.getElementById('selectionActions').hidden = true;
  document.getElementById('selectAllBtn').textContent = 'Выбрать всё';
  document.getElementById('selectedCount').textContent = 'Выберите файлы';
  document.getElementById('deleteSelectedBtn').disabled = true;
  document.getElementById('downloadSelectedBtn').disabled = true;
  
  render(currentPath, currentItems);
}

function toggleItemSelection(name, event) {
  if (event) event.stopPropagation();
  
  if (selectedItems.has(name)) {
    selectedItems.delete(name);
  } else {
    selectedItems.add(name);
  }
  
  updateSelectionCount();
  updateItemCheckbox(name);
}

function updateItemCheckbox(name) {
  const li = document.querySelector(`[data-item-name="${CSS.escape(name)}"]`);
  if (li) {
    const checkbox = li.querySelector('.item-checkbox');
    if (checkbox) {
      checkbox.classList.toggle('checked', selectedItems.has(name));
    }
  }
}

function updateSelectionCount() {
  const count = selectedItems.size;
  const total = currentItems ? currentItems.length : 0;
  
  const fileCount = Array.from(selectedItems).filter(name => {
    const item = currentItems.find(i => i.name === name);
    return item && item.type === 'file';
  }).length;
  
  const countSpan = document.getElementById('selectedCount');
  countSpan.textContent = count > 0 ? `Выбрано: ${count}` : 'Выберите файлы';
  
  document.getElementById('deleteSelectedBtn').disabled = count === 0;
  document.getElementById('downloadSelectedBtn').disabled = fileCount === 0;
  
  const selectAllBtn = document.getElementById('selectAllBtn');
  if (total > 0 && count === total) {
    selectAllBtn.textContent = 'Снять всё';
  } else {
    selectAllBtn.textContent = 'Выбрать всё';
  }
}

function selectAll() {
  if (!selectionMode) {
    selectionMode = true;
    document.getElementById('selectModeBtn').classList.add('active');
    document.getElementById('selectionActions').hidden = false;
    render(currentPath, currentItems);
  }
  
  const total = currentItems ? currentItems.length : 0;
  const allSelected = total > 0 && selectedItems.size === total;
  
  if (allSelected) {
    selectedItems.clear();
  } else {
    selectedItems.clear();
    currentItems.forEach(item => selectedItems.add(item.name));
  }
  
  render(currentPath, currentItems);
  updateSelectionCount();
}

async function deleteSelected() {
  const count = selectedItems.size;
  if (count === 0) return;
  
  const names = Array.from(selectedItems);
  const fileCount = names.filter(n => {
    const item = currentItems.find(i => i.name === n);
    return item && item.type === 'file';
  }).length;
  const dirCount = count - fileCount;
  
  let message;
  if (fileCount > 0 && dirCount > 0) {
    message = `Удалить ${fileCount} файл(ов) и ${dirCount} папок?`;
  } else if (dirCount > 0) {
    message = `Удалить ${dirCount} папок со всем содержимым?`;
  } else {
    message = `Удалить ${fileCount} файл(ов)?`;
  }
  
  if (!confirm(message)) return;
  
  await closeViewerCompletely();
  await new Promise(resolve => setTimeout(resolve, 300));
  
  for (const name of names) {
    const item = currentItems.find(i => i.name === name);
    if (item) {
      const type = item.type === 'dir' ? 'rmdir' : 'rm';
      ws.send(JSON.stringify({ type, name }));
    }
  }
  
  exitSelectionMode();
}

function renameItem(oldName) {
  const newName = prompt('Новое имя:', oldName);
  if (newName && newName !== oldName) {
    ws.send(JSON.stringify({
      type: 'rename',
      oldName: oldName,
      newName: newName
    }));
  }
}

// ========== Скачивание ==========
const downloadQueue = [];
let isDownloading = false;

function downloadFile(name) {
  ws.send(JSON.stringify({ type: 'download', name, action: 'save' }));
}

function downloadSelected() {
  const names = Array.from(selectedItems);
  if (names.length === 0) return;

  // Если выбран 1 файл (и это именно файл, а не папка)
  if (names.length === 1) {
    const item = currentItems.find(i => i.name === names[0]);
    if (item && item.type === 'file') {
      downloadQueue.push(item.name);
      processDownloadQueue();
      exitSelectionMode();
      return;
    }
  }

  // Если выбрано много файлов ИЛИ выбрана папка -> качаем ZIP
  showNotification('📦 Создание архива...');
  
  ws.send(JSON.stringify({
    type: 'download_zip',
    files: names
  }));
  
  exitSelectionMode();
}

function processDownloadQueue() {
  if (isDownloading || downloadQueue.length === 0) return;
  
  isDownloading = true;
  const name = downloadQueue.shift();
  
  ws.send(JSON.stringify({ type: 'download', name, action: 'save' }));
}

function triggerDownload(url, filename) {
  // Для ZIP и обычных файлов используем location.assign для лучшей совместимости
  window.location.assign(url);
  
  setTimeout(() => {
    isDownloading = false;
    if (downloadQueue.length > 0) {
      processDownloadQueue();
    }
  }, 1000);
}

// ========== Загрузки (Upload) ==========
function generateUploadId() {
  return 'upload_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
}

function updateUploadUI() {
  // 1. Создаем контейнер, если его нет
  let container = document.querySelector('.uploads-list');
  if (!container) {
    uploadInfo.innerHTML = '<div class="uploads-list"></div>';
    container = document.querySelector('.uploads-list');
  }

  // ===================================
  // 1. ОБНОВЛЕНИЕ АКТИВНОЙ ЗАГРУЗКИ
  // ===================================
  // Ищем существующий элемент активной загрузки по специальному ID
  let activeEl = document.getElementById('active-upload-item');

  if (currentUpload) {
    // Рассчитываем данные
    const percent = currentUpload.size > 0
      ? Math.min(100, (currentUpload.received / currentUpload.size * 100)).toFixed(1)
      : 0;
    const speedText = currentUpload.speed > 0 ? formatSpeed(currentUpload.speed) : '...';
    const progressText = `${formatBytes(currentUpload.received)} / ${formatBytes(currentUpload.size)}`;

    if (!activeEl) {
      // Если элемента нет - создаем его (один раз!)
      activeEl = document.createElement('div');
      activeEl.id = 'active-upload-item'; // Важно для поиска
      activeEl.className = 'upload-item uploading';
      
      // Вставляем HTML с классами для прямого доступа к полям
      activeEl.innerHTML = `
        <span class="upload-status">⏳</span>
        <div class="upload-info-block">
          <span class="upload-name" title="${currentUpload.file.name}">${currentUpload.file.name}</span>
          
          <div class="upload-progress-bar">
            <div class="upload-progress-fill" style="width: 0%"></div>
          </div>
          
          <div class="upload-stats-row">
            <span class="upload-percent">0%</span>
            <span class="upload-size-progress"></span>
            <span class="upload-speed"></span>
          </div>
        </div>
        <button type="button" class="upload-cancel" data-action="cancel">✕</button>
      `;
      // Вставляем в начало списка
      container.prepend(activeEl);
    }

    // ТЕПЕРЬ ОБНОВЛЯЕМ ТОЛЬКО ЗНАЧЕНИЯ (DOM остаётся стабильным!)
    // Кнопка не удаляется, клик проходит успешно
    activeEl.querySelector('.upload-progress-fill').style.width = `${percent}%`;
    activeEl.querySelector('.upload-percent').textContent = `${percent}%`;
    activeEl.querySelector('.upload-size-progress').textContent = progressText;
    activeEl.querySelector('.upload-speed').textContent = speedText;

  } else {
    // Если загрузки нет, но элемент висит - удаляем
    if (activeEl) activeEl.remove();
  }

  // ===================================
  // 2. ОБНОВЛЕНИЕ ОЧЕРЕДИ
  // ===================================
  // Обновляем очередь только если изменилось количество элементов.
  // Это предотвращает мигание кнопок удаления в очереди.
  const pendingItems = container.querySelectorAll('.upload-item.pending');
  
  if (pendingItems.length !== uploadQueue.length) {
    // Удаляем старые элементы очереди
    pendingItems.forEach(el => el.remove());

    // Рисуем очередь заново
    uploadQueue.forEach((item, index) => {
      const div = document.createElement('div');
      div.className = 'upload-item pending';
      div.innerHTML = `
        <span class="upload-status">⏸️</span>
        <div class="upload-info-block">
          <span class="upload-name" title="${item.file.name}">${item.file.name}</span>
          <span class="upload-pending-size">Ожидание · ${formatBytes(item.file.size)}</span>
        </div>
        <button type="button" class="upload-cancel" data-action="remove" data-index="${index}">✕</button>
      `;
      container.appendChild(div);
    });
  }
}

// Инициализация обработчиков загрузок (вызывается один раз)
function initUploadListeners() {
  if (uploadListenersAttached) return;
  uploadListenersAttached = true;
  
  uploadInfo.addEventListener('click', (e) => {
    const button = e.target.closest('.upload-cancel');
    if (!button) return;
    
    e.preventDefault();
    e.stopPropagation();
    
    const action = button.dataset.action;
    
    console.log('🖱️ Клик по кнопке отмены, action:', action);
    
    if (action === 'cancel') {
      cancelCurrentUpload();
    } else if (action === 'remove') {
      const index = parseInt(button.dataset.index, 10);
      removeFromQueue(index);
    }
  });
  
  console.log('✅ Upload listeners initialized');
}

// Отмена текущей загрузки
function cancelCurrentUpload() {
  if (!currentUpload) {
    return;
  }

  console.log('⛔ ЗАПРОС ОТМЕНЫ:', currentUpload.file.name);

  // 1. Ставим флаг, который увидит цикл sendFileChunks
  currentUpload.cancelled = true;
  
  const uploadId = currentUpload.id;

  // 2. Сообщаем серверу
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'upload_cancel', uploadId: uploadId }));
  }

  // 3. Обновляем UI мгновенно
  const tempName = currentUpload.file.name;
  currentUpload = null; // Убираем глобальную ссылку
  updateUploadUI();
  showNotification(`🛑 Загрузка отменена: ${tempName}`, 'error');

  // 4. Запускаем следующую загрузку с паузой
  setTimeout(() => processNextUpload(), 500);
}

// Удаление из очереди
function removeFromQueue(index) {
  if (index >= 0 && index < uploadQueue.length) {
    const removed = uploadQueue.splice(index, 1);
    console.log('🗑️ Удалено из очереди:', removed[0]?.file?.name);
    updateUploadUI();
  }
}

function processNextUpload() {
  if (currentUpload || uploadQueue.length === 0) return;
  
  const next = uploadQueue.shift();
  currentUpload = {
    id: next.id,
    file: next.file,
    received: 0,
    size: next.file.size,
    cancelled: false,
    startTime: Date.now(),
    lastProgressTime: Date.now(),
    lastProgressBytes: 0,
    speed: 0
  };
  
  ws.send(JSON.stringify({
    type: 'upload_start',
    uploadId: currentUpload.id,
    name: currentUpload.file.name,
    size: currentUpload.file.size,
    modified: currentUpload.file.lastModified
  }));
  
  updateUploadUI();
}

async function sendFileChunks() {
  if (!currentUpload || currentUpload.cancelled) return;

  const activeTask = currentUpload; // Локальная ссылка
  const file = activeTask.file;
  const chunkSize = 1024 * 1024;
  let offset = 0;

  try {
    while (offset < file.size) {
      // Пауза для обработки клика (обязательно оставьте!)
      await new Promise(resolve => setTimeout(resolve, 0));

      if (activeTask.cancelled) return;

      const end = Math.min(offset + chunkSize, file.size);
      const chunk = await file.slice(offset, end).arrayBuffer();

      if (activeTask.cancelled) return;

      if (ws.bufferedAmount > 0) {
        while (ws.bufferedAmount > chunkSize) {
          await new Promise(resolve => setTimeout(resolve, 10));
          if (activeTask.cancelled) return;
        }
      }

      ws.send(chunk);
      offset = end;
    }

    if (!activeTask.cancelled) {
      ws.send(JSON.stringify({ type: 'upload_end', uploadId: activeTask.id }));
    }
  } catch (err) {
    console.error('Upload error:', err);
  }
}

// ========== Подключение ==========
function connect(code) {
  // Если код не передан, берем из поля ввода
  const passwordToUse = code || document.getElementById('codeInput').value.trim();
  
  if (!passwordToUse) {
    alert('Введите пароль!');
    return;
  }

  ws = new WebSocket(`ws://${location.host}`);
  ws.binaryType = 'arraybuffer';
  
  ws.onopen = () => {
    ws.send(JSON.stringify({
      type: 'auth',
      code: passwordToUse
    }));
  };

  ws.onmessage = async (e) => {
    const msg = JSON.parse(e.data);

    if (msg.type === 'auth') {
      if (msg.ok) {
        // УСПЕХ: Сохраняем пароль в память браузера
        sessionStorage.setItem(SAVED_PASS_KEY, passwordToUse);
        
        auth.hidden = true;
        app.hidden = false;
        
        // Инициализируем обработчики загрузок
        initUploadListeners();
        
        ws.send(JSON.stringify({ type: 'ls' }));
        
        refreshInterval = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN && !currentUpload) {
            ws.send(JSON.stringify({ type: 'refresh' }));
          }
        }, 5000);
      } else {
        // ОШИБКА: Если сохраненный пароль больше не подходит — удаляем его
        sessionStorage.removeItem(SAVED_PASS_KEY);
        auth.hidden = false;
        app.hidden = true;
        
        // Если это была попытка ручного ввода — ругаемся
        if (!code) {
           alert('Неверный пароль!');
           document.getElementById('codeInput').value = '';
        }
      }
      return;
    }

    if (msg.type === 'ls' || msg.type === 'cd') {
      currentPath = msg.path;
      currentItems = msg.items;
      render(msg.path, msg.items);
    }

    if (msg.type === 'download_ready') {
      const url = `/download/${msg.token}`;
      
      if (msg.action === 'save') {
        triggerDownload(url, msg.filename);
      } else {
        lastViewedToken = msg.token;
        openFile(msg.token, msg.filename);
      }
    }

    if (msg.type === 'upload_ready') {
      if (currentUpload && currentUpload.id === msg.uploadId) {
        sendFileChunks();
      }
    }

    if (msg.type === 'upload_progress') {
      if (currentUpload && currentUpload.id === msg.uploadId) {
        const now = Date.now();
        const timeDiff = (now - currentUpload.lastProgressTime) / 1000;
        const bytesDiff = msg.received - currentUpload.lastProgressBytes;
        
        if (timeDiff > 0.05 && bytesDiff > 0) {
          const instantSpeed = bytesDiff / timeDiff;
          
          if (currentUpload.speed === 0) {
            currentUpload.speed = instantSpeed;
          } else {
            currentUpload.speed = currentUpload.speed * 0.7 + instantSpeed * 0.3;
          }
          
          currentUpload.lastProgressTime = now;
          currentUpload.lastProgressBytes = msg.received;
        }
        
        currentUpload.received = msg.received;
        currentUpload.size = msg.size;
        updateUploadUI();
      }
    }

    if (msg.type === 'upload_done') {
      if (currentUpload && currentUpload.id === msg.uploadId) {
        currentUpload = null;
        updateUploadUI();
        showNotification('✅ Файл загружен!');
        ws.send(JSON.stringify({ type: 'ls' }));
        setTimeout(() => processNextUpload(), 100);
      }
    }

    if (msg.type === 'upload_error') {
      if (currentUpload && currentUpload.id === msg.uploadId) {
        showNotification(`❌ Ошибка: ${msg.message}`, 'error');
        currentUpload = null;
        updateUploadUI();
        processNextUpload();
      }
    }

    if (msg.type === 'rename') {
      ws.send(JSON.stringify({ type: 'ls' })); // Просто обновляем список
    }

    if (msg.type === 'zip_ready') {
      const url = `/zip/${msg.token}`;
      triggerDownload(url, 'archive.zip');
    }

    if (msg.type === 'rm' || msg.type === 'rmdir' || msg.type === 'mkdir') {
      ws.send(JSON.stringify({ type: 'ls' }));
    }

    if (msg.type === 'error') {
      showNotification(`❌ ${msg.message}`, 'error');
    }
  };

  ws.onclose = () => {
    clearInterval(refreshInterval);
    uploadQueue.length = 0;
    currentUpload = null;
  };

  ws.onerror = (err) => {
    console.error('WebSocket error:', err);
  };
}

// ========== ПРИВЯЗКА СОБЫТИЙ ВХОДА ==========
// 1. Привязка клика по кнопке
document.getElementById('connectBtn').onclick = () => connect();
// 2. Обработка нажатия Enter в поле ввода
document.getElementById('codeInput').onkeydown = (e) => {
  if (e.key === 'Enter') {
    connect(); 
  }
};

// АВТО-ВХОД ПРИ ЗАГРУЗКЕ СТРАНИЦЫ
window.addEventListener('load', () => {
    const savedPass = sessionStorage.getItem(SAVED_PASS_KEY);
    if (savedPass) {
        console.log('🔄 Авто-вход по сохраненному паролю...');
        connect(savedPass);
    }
});

// ========== Кнопка Refresh ==========
document.getElementById('refreshBtn').onclick = () => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    const icon = document.querySelector('#refreshBtn .refresh-icon');
    icon.classList.add('spinning');
    
    ws.send(JSON.stringify({ type: 'ls' }));
    
    setTimeout(() => {
      icon.classList.remove('spinning');
    }, 600);
  } else {
    showNotification('❌ Нет соединения', 'error');
  }
};

// ========== Выход (если кнопка добавлена в HTML) ==========
const logoutBtn = document.getElementById('logoutBtn');
if (logoutBtn) {
  logoutBtn.onclick = () => {
    sessionStorage.removeItem(SAVED_PASS_KEY);
    if (ws) ws.close();
    app.hidden = true;
    auth.hidden = false;
    document.getElementById('codeInput').value = '';
    currentUpload = null;
    uploadQueue.length = 0;
    updateUploadUI();
  };
}

// ========== Уведомления ==========
function showNotification(text, type = 'success') {
  document.querySelectorAll('.notification').forEach(n => n.remove());
  
  const notification = document.createElement('div');
  notification.className = `notification ${type}`;
  notification.textContent = text;
  document.body.appendChild(notification);
  
  setTimeout(() => notification.remove(), 3000);
}

// ========== Иконки файлов ==========
function getFileIcon(filename) {
  const ext = filename.split('.').pop().toLowerCase();
  
  const icons = {
    'mp4': '🎬', 'avi': '🎬', 'mkv': '🎬', 'mov': '🎬', 'webm': '🎬', 'flv': '🎬',
    'mp3': '🎵', 'wav': '🎵', 'ogg': '🎵', 'flac': '🎵', 'm4a': '🎵',
    'jpg': '🖼️', 'jpeg': '🖼️', 'png': '🖼️', 'gif': '🖼️', 'bmp': '🖼️', 'svg': '🖼️', 'webp': '🖼️',
    'pdf': '📕', 'doc': '📘', 'docx': '📘', 'txt': '📄', 'md': '📄',
    'xls': '📗', 'xlsx': '📗', 'ppt': '📙', 'pptx': '📙',
    'js': '📜', 'html': '📜', 'css': '📜', 'py': '📜', 'java': '📜', 'cpp': '📜', 'c': '📜',
    'php': '📜', 'json': '📜', 'xml': '📜',
    'zip': '📦', 'rar': '📦', '7z': '📦', 'tar': '📦', 'gz': '📦',
    'exe': '⚙️', 'apk': '📱', 'iso': '💿'
  };
  
  return icons[ext] || '📄';
}

// ========== Открытие файлов ==========
function openFile(token, filename) {
  const url = `/download/${token}?action=view`; 
  
  const ext = filename.split('.').pop().toLowerCase();
  
  viewerContent.innerHTML = '';
  viewer.hidden = false;

  // 1. ВИДЕО
  if (['mp4', 'webm', 'ogg', 'mkv', 'mov', 'avi'].includes(ext)) {
    // === ИСПРАВЛЕНИЕ 2: Убираем type="..." для MKV/AVI ===
    // Если не указывать type, браузер сам попробует определить кодеки.
    // Это иногда помогает со звуком (если там AAC/MP3), но с AC3 чуда не будет.
    let sourceTag = `<source src="${url}">`;
    
    // Для MP4 лучше оставить тип явно, это ускоряет старт
    if (ext === 'mp4') sourceTag = `<source src="${url}" type="video/mp4">`;
    
    viewerContent.innerHTML = `
      <div style="width: 100%; max-width: 1000px;">
        <video controls autoplay playsinline style="width: 100%; max-height: 80vh; background: black;">
           ${sourceTag}
           Ваш браузер не поддерживает воспроизведение этого файла.
        </video>
        <p class="viewer-filename">${filename}</p>
        ${(ext === 'mkv' || ext === 'avi') ? '<p style="font-size:11px; color:#666; margin-top:5px">⚠️ Если нет звука, значит используется кодек AC3/DTS, который браузеры не поддерживают.</p>' : ''}
      </div>`;
  }
  // 2. АУДИО
  else if (['mp3', 'wav', 'ogg', 'm4a', 'flac'].includes(ext)) {
    viewerContent.innerHTML = `
      <div class="audio-player">
        <h3>🎵 ${filename}</h3>
        <audio controls autoplay style="width: 100%;"><source src="${url}"></audio>
      </div>`;
  }
  
  // 3. КАРТИНКИ
  else if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'ico'].includes(ext)) {
    viewerContent.innerHTML = `<img src="${url}" alt="${filename}" style="max-width: 100%; max-height: 85vh;">`;
  }
  
  // 4. PDF (Iframe - самый надежный способ для десктопа)
  else if (ext === 'pdf') {
    // Благодаря ?action=view сервер отдаст Content-Disposition: inline
    // И Chrome корректно отобразит PDF внутри iframe, а не скачает его
    viewerContent.innerHTML = `<iframe src="${url}" style="width: 80vw; height: 85vh; border: none; background: white;"></iframe>`;
  }
  
  // 5. DOCX (КРАСИВЫЙ WORD)
  else if (ext === 'docx') {
    viewerContent.innerHTML = `
      <div class="doc-container" style="background: #e0e0e0; padding: 20px; width: 100%; height: 85vh; overflow: auto; display: flex; justify-content: center;">
         <div id="docx-wrapper" style="background: white; color: black; padding: 0; box-shadow: 0 0 10px rgba(0,0,0,0.5);">Загрузка документа...</div>
      </div>`;
    
    fetch(url)
      .then(res => res.blob())
      .then(blob => {
        const docxOptions = {
          inWrapper: false, // Рендерить чисто контент
          ignoreWidth: false,
          experimental: true
        };
        // docx-preview библиотека
        docx.renderAsync(blob, document.getElementById("docx-wrapper"), null, docxOptions)
          .then(() => console.log("Docx rendered"))
          .catch(e => document.getElementById("docx-wrapper").innerHTML = `Ошибка: ${e}`);
      });
  }
  
  // 6. XLSX / XLS (EXCEL)
  else if (['xlsx', 'xls', 'csv'].includes(ext)) {
    viewerContent.innerHTML = `
      <div class="excel-container" style="background: white; color: black; padding: 10px; width: 90vw; height: 85vh; overflow: auto;">
        <div id="excel-wrapper">Загрузка таблицы...</div>
      </div>`;
      
    fetch(url)
      .then(res => res.arrayBuffer())
      .then(data => {
        const workbook = XLSX.read(data, {type: 'array'});
        const firstSheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[firstSheetName];
        const html = XLSX.utils.sheet_to_html(worksheet);
        document.getElementById('excel-wrapper').innerHTML = html;
        
        // Немного стилей для таблицы
        const table = document.getElementById('excel-wrapper').querySelector('table');
        if (table) {
            table.style.borderCollapse = 'collapse';
            table.style.width = '100%';
            table.querySelectorAll('td, th').forEach(td => {
                td.style.border = '1px solid #ccc';
                td.style.padding = '4px';
                td.style.fontSize = '12px';
            });
        }
      });
  }
  
  // 7. ZIP / RAR (Архивы - просмотр списка)
  // Примечание: JSZip читает только ZIP. Для RAR нужны тяжелые либы. Сделаем пока для ZIP.
  else if (ext === 'zip') {
    viewerContent.innerHTML = `
      <div class="archive-viewer" style="background: #222; padding: 20px; width: 500px; max-width: 90vw; border-radius: 10px; text-align: left;">
        <h3 style="margin-bottom: 10px; color: #4ecca3;">📦 Содержимое архива</h3>
        <ul id="zip-list" style="list-style: none; max-height: 60vh; overflow: auto;">Загрузка списка...</ul>
      </div>`;
      
    fetch(url)
      .then(res => res.blob())
      .then(JSZip.loadAsync)
      .then(zip => {
        const list = document.getElementById('zip-list');
        list.innerHTML = '';
        
        // Перебираем файлы
        zip.forEach((relativePath, zipEntry) => {
           const li = document.createElement('li');
           li.style.padding = '5px 0';
           li.style.borderBottom = '1px solid #333';
           li.style.color = zipEntry.dir ? '#f1c40f' : '#ccc'; // Папки желтым
           li.textContent = (zipEntry.dir ? '📁 ' : '📄 ') + zipEntry.name;
           list.appendChild(li);
        });
      })
      .catch(e => {
         document.getElementById('zip-list').innerHTML = `<li style="color: red">Не удалось прочитать архив (возможно, запаролен).</li>`;
      });
  }
  
  // 8. ТЕКСТ / КОД
  else if (['txt', 'md', 'json', 'xml', 'html', 'css', 'js', 'py', 'java', 'c', 'cpp', 'ini', 'log'].includes(ext)) {
    fetch(url)
      .then(r => r.text())
      .then(text => {
         if (text.length > 100000) text = text.substring(0, 100000) + '\n... (файл обрезан)';
         viewerContent.innerHTML = `
           <div class="text-viewer" style="background: #222; text-align: left; width: 80vw; max-height: 80vh; overflow: auto; padding: 20px;">
             <pre style="white-space: pre-wrap; word-break: break-all; color: #ddd;">${escapeHtml(text)}</pre>
           </div>`;
      });
  }
  
  // 9. ОСТАЛЬНОЕ
  else {
    viewer.hidden = true;
    triggerDownload(url, filename);
  }
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// ========== Форматирование ==========
function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 Б';
  const k = 1024;
  const sizes = ['Б', 'КБ', 'МБ', 'ГБ'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return (bytes / Math.pow(k, i)).toFixed(1) + ' ' + sizes[i];
}

function formatSpeed(bytesPerSecond) {
  if (!bytesPerSecond || bytesPerSecond <= 0) return '—';
  const k = 1024;
  const sizes = ['Б/с', 'КБ/с', 'МБ/с', 'ГБ/с'];
  const i = Math.floor(Math.log(bytesPerSecond) / Math.log(k));
  return (bytesPerSecond / Math.pow(k, i)).toFixed(1) + ' ' + sizes[i];
}

function formatDate(timestamp) {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  const now = new Date();
  const isToday = date.toDateString() === now.toDateString();
  
  if (isToday) {
    return date.toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' });
  }
  return date.toLocaleDateString('ru', { day: '2-digit', month: '2-digit', year: '2-digit' });
}

// ========== Удаление ==========
async function deleteFile(name) {
  if (!confirm(`Удалить файл "${name}"?`)) return;
  await closeViewerCompletely();
  await new Promise(resolve => setTimeout(resolve, 500));
  ws.send(JSON.stringify({ type: 'rm', name }));
}

async function deleteFolder(name) {
  if (!confirm(`Удалить папку "${name}" со всем содержимым?`)) return;
  await closeViewerCompletely();
  await new Promise(resolve => setTimeout(resolve, 500));
  ws.send(JSON.stringify({ type: 'rmdir', name }));
}

// ========== Рендер списка файлов ==========
function render(path, items) {
  pathSpan.textContent = path;
  currentPath = path;
  currentItems = items;
  
  const sortedItems = sortItems(items);
  
  fileList.innerHTML = '';

  if (sortedItems.length === 0) {
    fileList.innerHTML = '<li class="empty-message">📂 Папка пуста</li>';
    return;
  }

  sortedItems.forEach(item => {
    const li = document.createElement('li');
    li.className = item.type;
    li.dataset.itemName = item.name;
    
    if (selectionMode) {
      const checkbox = document.createElement('span');
      checkbox.className = 'item-checkbox' + (selectedItems.has(item.name) ? ' checked' : '');
      checkbox.onclick = (e) => toggleItemSelection(item.name, e);
      li.appendChild(checkbox);
    }
    
    const icon = item.type === 'dir' ? '📁' : getFileIcon(item.name);
    
    const iconSpan = document.createElement('span');
    iconSpan.className = 'item-icon';
    iconSpan.textContent = icon;
    
    const nameSpan = document.createElement('span');
    nameSpan.className = 'item-name';
    nameSpan.textContent = item.name;
    
    const nameContainer = document.createElement('div');
    nameContainer.className = 'item-name-container';
    nameContainer.appendChild(iconSpan);
    nameContainer.appendChild(nameSpan);
    
    li.appendChild(nameContainer);
    
    const metaContainer = document.createElement('div');
    metaContainer.className = 'item-meta';
    
    if (item.type === 'file' && item.size !== null) {
      const sizeSpan = document.createElement('span');
      sizeSpan.className = 'item-size';
      sizeSpan.textContent = formatBytes(item.size);
      metaContainer.appendChild(sizeSpan);
    }
    
    if (item.modified) {
      const dateSpan = document.createElement('span');
      dateSpan.className = 'item-date';
      dateSpan.textContent = formatDate(item.modified);
      metaContainer.appendChild(dateSpan);
    }
    
    li.appendChild(metaContainer);

    if (!selectionMode) {
      if (item.type === 'dir') {
        li.onclick = () => ws.send(JSON.stringify({ type: 'cd', name: item.name }));

        // Создаем контейнер действий для папки
        const actions = document.createElement('div');
        actions.className = 'file-actions';

        // Кнопка переименования для папки
        const renameBtn = document.createElement('span');
        renameBtn.className = 'view-btn';
        renameBtn.textContent = '✏️';
        renameBtn.title = 'Переименовать';
        renameBtn.onclick = e => {
          e.stopPropagation();
          renameItem(item.name);
        };

        const del = document.createElement('span');
        del.className = 'delete';
        del.textContent = '🗑';
        del.onclick = e => {
          e.stopPropagation();
          deleteFolder(item.name);
        };
        
        actions.appendChild(renameBtn);
        actions.appendChild(del);
        li.appendChild(actions);

      } else {
        const actions = document.createElement('div');
        actions.className = 'file-actions';
        
        const view = document.createElement('span');
        view.className = 'view-btn';
        view.textContent = '👁️';
        view.title = 'Открыть';
        view.onclick = e => {
          e.stopPropagation();
          ws.send(JSON.stringify({ type: 'download', name: item.name, action: 'view' }));
        };
        
        const download = document.createElement('span');
        download.className = 'download-btn';
        download.textContent = '💾';
        download.title = 'Скачать';
        download.onclick = e => {
          e.stopPropagation();
          downloadFile(item.name);
        };
        
        const renameBtn = document.createElement('span');
        renameBtn.className = 'view-btn'; // Используем тот же стиль, что и у просмотра
        renameBtn.textContent = '✏️';
        renameBtn.title = 'Переименовать';
        renameBtn.onclick = e => {
          e.stopPropagation();
          renameItem(item.name);
        };
        
        const del = document.createElement('span');
        del.className = 'delete';
        del.textContent = '🗑';
        del.title = 'Удалить';
        del.onclick = e => {
          e.stopPropagation();
          deleteFile(item.name);
        };
        
        actions.appendChild(view);
        actions.appendChild(download);
        actions.appendChild(renameBtn); // Добавляем в список
        actions.appendChild(del);
        li.appendChild(actions);
      }
    } else {
      li.onclick = () => toggleItemSelection(item.name);
    }

    fileList.appendChild(li);
  });
  
  updateSortButtons();
}

// ========== Навигация ==========
document.getElementById('upBtn').onclick = () => {
  ws.send(JSON.stringify({ type: 'cd', name: '..' }));
};

document.getElementById('newFolderBtn').onclick = () => {
  const name = prompt('Имя папки');
  if (name && name.trim()) {
    ws.send(JSON.stringify({ type: 'mkdir', name: name.trim() }));
  }
};

document.getElementById('uploadBtn').onclick = () => {
  fileInput.value = '';
  fileInput.click();
};

fileInput.onchange = () => {
  const files = fileInput.files;
  if (files.length === 0) return;
  
  for (const file of files) {
    uploadQueue.push({
      id: generateUploadId(),
      file: file
    });
  }
  
  updateUploadUI();
  processNextUpload();
};

// ========== Обработчики кнопок выделения ==========
document.getElementById('selectModeBtn').onclick = toggleSelectionMode;
document.getElementById('selectAllBtn').onclick = selectAll;
document.getElementById('deleteSelectedBtn').onclick = deleteSelected;
document.getElementById('downloadSelectedBtn').onclick = downloadSelected;
document.getElementById('cancelSelectionBtn').onclick = exitSelectionMode;

// ========== Обработчики сортировки ==========
document.querySelectorAll('.sort-btn').forEach(btn => {
  btn.onclick = () => setSort(btn.dataset.sort);
});