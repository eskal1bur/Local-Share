let ws;
let refreshInterval;
let lastViewedToken = null;

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

// ========== Скачивание ==========
const downloadQueue = [];
let isDownloading = false;

function downloadFile(name) {
  ws.send(JSON.stringify({ type: 'download', name, action: 'save' }));
}

async function downloadSelected() {
  const names = Array.from(selectedItems).filter(name => {
    const item = currentItems.find(i => i.name === name);
    return item && item.type === 'file';
  });
  
  if (names.length === 0) return;
  
  showNotification(`📥 Скачивание ${names.length} файл(ов)...`);
  
  for (const name of names) {
    downloadQueue.push(name);
  }
  
  processDownloadQueue();
  exitSelectionMode();
}

function processDownloadQueue() {
  if (isDownloading || downloadQueue.length === 0) return;
  
  isDownloading = true;
  const name = downloadQueue.shift();
  
  ws.send(JSON.stringify({ type: 'download', name, action: 'save' }));
}

function triggerDownload(url, filename) {
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  
  setTimeout(() => {
    isDownloading = false;
    if (downloadQueue.length > 0) {
      processDownloadQueue();
    }
  }, 500);
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
    size: currentUpload.file.size
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
  ws = new WebSocket(`ws://${location.host}`);
  ws.binaryType = 'arraybuffer';
  
  ws.onopen = () => {
    ws.send(JSON.stringify({
      type: 'auth',
      code: code || document.getElementById('codeInput').value.trim()
    }));
  };

  ws.onmessage = async (e) => {
    const msg = JSON.parse(e.data);

    if (msg.type === 'auth') {
      if (msg.ok) {
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
        alert('Неверный код!');
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

document.getElementById('connectBtn').onclick = () => connect();

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
  const url = `/download/${token}`;
  const ext = filename.split('.').pop().toLowerCase();
  
  viewerContent.innerHTML = '';
  
  if (['mp4', 'webm', 'ogg'].includes(ext)) {
    viewerContent.innerHTML = `
      <video controls autoplay playsinline>
        <source src="${url}" type="video/${ext === 'ogg' ? 'ogg' : ext}">
      </video>
      <p class="viewer-filename">${filename}</p>
    `;
  }
  else if (['mp3', 'wav', 'ogg', 'm4a'].includes(ext)) {
    viewerContent.innerHTML = `
      <div class="audio-player">
        <h3>🎵 ${filename}</h3>
        <audio controls autoplay>
          <source src="${url}">
        </audio>
      </div>
    `;
  }
  else if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg'].includes(ext)) {
    viewerContent.innerHTML = `
      <img src="${url}" alt="${filename}">
      <p class="viewer-filename">${filename}</p>
    `;
  }
  else if (ext === 'pdf') {
    viewerContent.innerHTML = `<iframe src="${url}"></iframe>`;
  }
  else if (['txt', 'md', 'json', 'xml', 'html', 'css', 'js', 'py', 'java', 'cpp', 'c', 'php'].includes(ext)) {
    fetch(url)
      .then(r => r.text())
      .then(text => {
        viewerContent.innerHTML = `
          <div class="text-viewer">
            <h3>📄 ${filename}</h3>
            <pre>${escapeHtml(text)}</pre>
          </div>
        `;
      });
  }
  else {
    triggerDownload(url, filename);
    return;
  }
  
  viewer.hidden = false;
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

        const del = document.createElement('span');
        del.className = 'delete';
        del.textContent = '🗑';
        del.onclick = e => {
          e.stopPropagation();
          deleteFolder(item.name);
        };
        li.appendChild(del);
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