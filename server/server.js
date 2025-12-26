const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const WebSocket = require('ws');
const crypto = require('crypto');
const archiver = require('archiver');
const os = require('os');
const qrcode = require('qrcode-terminal');

// ======================
// НАСТРОЙКИ
// ======================
const PORT = 8443;
const TRASH_PREFIX = '.trash_';
const MAX_FILE_SIZE = 30 * 1024 * 1024 * 1024; // 30 GB
const MAX_FILENAME_LENGTH = 255;
const MAX_SESSIONS = 10;
const MAX_UPLOADS_PER_SESSION = 5;
const MAX_DELETE_ATTEMPTS = 15; // Вместо 60
const MAX_FOLDER_DELETE_ATTEMPTS = 20; // Вместо 120

// ======================
// ОТСЛЕЖИВАНИЕ ОТКРЫТЫХ ФАЙЛОВ
// ======================
const activeStreams = new Map(); // token -> { stream, res, filePath }

// ======================
// АВТОРИЗАЦИЯ
// ======================
// Задай здесь свой пароль!
const ACCESS_PASSWORD = 'SuperLocalStorage'; 

// Функция теперь просто проверяет пароль, не меняя его
function checkPassword(inputCode) {
  return inputCode === ACCESS_PASSWORD;
}

// ======================
// EXPRESS + HTTPS
// ======================
const app = express();
app.use(express.static(path.join(__dirname, '..', 'public')));

const SHARED_ROOT = path.join(__dirname, '..', 'shared');

if (!fs.existsSync(SHARED_ROOT)) {
  fs.mkdirSync(SHARED_ROOT, { recursive: true });
}

function resolveSafePath(virtualPath) {
  const sanitized = virtualPath
    .replace(/\.\./g, '')
    .replace(/\/+/g, '/');
  
  const fullPath = path.normalize(path.join(SHARED_ROOT, sanitized));
  
  if (!fullPath.startsWith(SHARED_ROOT)) {
    throw new Error('Path escape attempt');
  }
  return fullPath;
}

function sanitizeFilename(name) {
  if (!name || typeof name !== 'string') {
    throw new Error('Invalid filename');
  }
  
  let sanitized = name
    .replace(/\.\./g, '_')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .trim();
  
  if (sanitized.length === 0 || sanitized.length > MAX_FILENAME_LENGTH) {
    throw new Error('Invalid filename length');
  }
  
  const forbidden = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;
  if (forbidden.test(sanitized.split('.')[0])) {
    sanitized = '_' + sanitized;
  }
  
  return sanitized;
}

function listDirectory(virtualPath) {
  const realPath = resolveSafePath(virtualPath);

  if (!fs.existsSync(realPath)) {
    fs.mkdirSync(realPath, { recursive: true });
  }

  return fs.readdirSync(realPath, { withFileTypes: true })
    .filter(e => !e.name.startsWith(TRASH_PREFIX))
    .map(e => {
      const fullPath = path.join(realPath, e.name);
      let stat = null;
      
      try {
        stat = fs.statSync(fullPath);
      } catch (err) {}
      
      return {
        name: e.name,
        type: e.isDirectory() ? 'dir' : 'file',
        size: stat && e.isFile() ? stat.size : null,
        modified: stat ? stat.mtimeMs : null
      };
    })
    .filter(e => e !== null);
}

// ======================
// УМНОЕ УДАЛЕНИЕ
// ======================
const pendingDeletes = new Set();

// Закрыть все стримы для файла
function closeStreamsForFile(filePath) {
  const normalizedPath = path.normalize(filePath);
  
  for (const [token, data] of activeStreams) {
    if (path.normalize(data.filePath) === normalizedPath) {
      console.log(`🔌 Closing stream for: ${path.basename(filePath)}`);
      try {
        if (data.stream) {
          data.stream.destroy();
        }
        if (data.res && !data.res.writableEnded) {
          data.res.end();
        }
      } catch (e) {}
      activeStreams.delete(token);
    }
  }
}

// Закрыть все стримы в папке
function closeStreamsInFolder(folderPath) {
  const normalizedFolder = path.normalize(folderPath);
  
  for (const [token, data] of activeStreams) {
    if (path.normalize(data.filePath).startsWith(normalizedFolder)) {
      console.log(`🔌 Closing stream in folder: ${path.basename(data.filePath)}`);
      try {
        if (data.stream) {
          data.stream.destroy();
        }
        if (data.res && !data.res.writableEnded) {
          data.res.end();
        }
      } catch (e) {}
      activeStreams.delete(token);
    }
  }
}

async function smartDelete(filePath) {
  const fileName = path.basename(filePath);
  const dirName = path.dirname(filePath);
  const trashName = `${TRASH_PREFIX}${Date.now()}_${fileName}`;
  const trashPath = path.join(dirName, trashName);
  
  // Шаг 1: Закрываем все стримы для этого файла
  closeStreamsForFile(filePath);
  
  // Пауза для освобождения
  await new Promise(resolve => setTimeout(resolve, 200));
  
  // Шаг 2: Несколько попыток переименования
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      fs.renameSync(filePath, trashPath);
      console.log(`🔄 Renamed to trash: ${fileName}`);
      pendingDeletes.add(trashPath);
      scheduleRealDelete(trashPath);
      return { ok: true };
    } catch (err) {
      console.log(`⚠️ Rename attempt ${attempt + 1} failed: ${err.code}`);
      await new Promise(resolve => setTimeout(resolve, 300 * (attempt + 1)));
    }
  }
  
  // Шаг 3: Если переименование не сработало, планируем отложенное удаление
  console.log(`⏳ Scheduling delayed delete for: ${fileName}`);
  pendingDeletes.add(filePath);
  scheduleRealDelete(filePath, 1, filePath); // Передаём оригинальный путь
  
  return { ok: true, delayed: true };
}

function scheduleRealDelete(filePath, attempt = 1, originalPath = null) {
  const maxAttempts = MAX_DELETE_ATTEMPTS; // 15 попыток
  // Интервалы: 1с, 2с, 3с, 5с, 8с, 10с, 10с... (примерно 2 минуты суммарно)
  const delay = Math.min(1000 * Math.ceil(attempt * 0.7), 10000);
  const targetPath = originalPath || filePath;
  
  setTimeout(async () => {
    try {
      const pathExists = fs.existsSync(filePath);
      const originalExists = originalPath && fs.existsSync(originalPath);
      
      if (!pathExists && !originalExists) {
        pendingDeletes.delete(filePath);
        if (originalPath) pendingDeletes.delete(originalPath);
        console.log(`✅ Already gone: ${path.basename(targetPath)}`);
        return;
      }
      
      const actualPath = pathExists ? filePath : originalPath;
      
      closeStreamsForFile(actualPath);
      await new Promise(resolve => setTimeout(resolve, 100));
      
      fs.unlinkSync(actualPath);
      pendingDeletes.delete(filePath);
      if (originalPath) pendingDeletes.delete(originalPath);
      console.log(`🗑️ Deleted: ${path.basename(actualPath)}`);
    } catch (err) {
      if (attempt < maxAttempts) {
        // Логируем только каждую 5-ю попытку
        if (attempt % 5 === 0) {
          console.log(`⏳ Retry ${attempt}/${maxAttempts}: ${path.basename(targetPath)}`);
        }
        scheduleRealDelete(filePath, attempt + 1, originalPath);
      } else {
        console.error(`❌ Gave up: ${path.basename(targetPath)}`);
        pendingDeletes.delete(filePath);
        if (originalPath) pendingDeletes.delete(originalPath);
      }
    }
  }, delay);
}

function cleanTrashInFolder(folderPath) {
  if (!fs.existsSync(folderPath)) return;
  
  try {
    const items = fs.readdirSync(folderPath, { withFileTypes: true });
    
    for (const item of items) {
      const fullPath = path.join(folderPath, item.name);
      
      if (item.isDirectory()) {
        cleanTrashInFolder(fullPath);
        if (item.name.startsWith(TRASH_PREFIX)) {
          try { 
            fs.rmSync(fullPath, { recursive: true, force: true }); 
          } catch (e) {}
        }
      } else if (item.name.startsWith(TRASH_PREFIX)) {
        try { 
          fs.unlinkSync(fullPath); 
          pendingDeletes.delete(fullPath);
        } catch (e) {}
      }
    }
  } catch (e) {}
}

function cancelPendingDeletesInFolder(folderPath) {
  for (const pendingPath of pendingDeletes) {
    if (pendingPath.startsWith(folderPath)) {
      pendingDeletes.delete(pendingPath);
    }
  }
}

async function smartDeleteFolder(folderPath) {
  const folderName = path.basename(folderPath);
  const parentDir = path.dirname(folderPath);
  const trashName = `${TRASH_PREFIX}${Date.now()}_${folderName}`;
  const trashPath = path.join(parentDir, trashName);
  
  // Закрываем все стримы в папке
  closeStreamsInFolder(folderPath);
  
  cancelPendingDeletesInFolder(folderPath);
  cleanTrashInFolder(folderPath);
  
  await new Promise(resolve => setTimeout(resolve, 300));
  
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      fs.renameSync(folderPath, trashPath);
      console.log(`🔄 Folder renamed to trash: ${folderName}`);
      scheduleRealDeleteFolder(trashPath);
      return { ok: true };
    } catch (err) {
      console.log(`⚠️ Folder rename attempt ${attempt + 1} failed`);
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
  
  // Пробуем удалить напрямую
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      fs.rmSync(folderPath, { recursive: true, force: true, maxRetries: 3, retryDelay: 500 });
      return { ok: true };
    } catch (rmErr) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
  
  // Последняя попытка переименовать
  try {
    fs.renameSync(folderPath, trashPath);
    scheduleRealDeleteFolder(trashPath);
    return { ok: true };
  } catch (finalErr) {
    // Планируем отложенное удаление
    scheduleRealDeleteFolder(folderPath);
    return { ok: true, delayed: true };
  }
}

function scheduleRealDeleteFolder(folderPath, attempt = 1) {
  const maxAttempts = MAX_FOLDER_DELETE_ATTEMPTS; // 20 попыток
  // Интервалы: 2с, 3с, 4с, 6с, 8с, 10с... (примерно 3 минуты суммарно)
  const delay = Math.min(2000 * Math.ceil(attempt * 0.6), 15000);
  
  setTimeout(() => {
    try {
      if (!fs.existsSync(folderPath)) {
        console.log(`✅ Folder gone: ${path.basename(folderPath)}`);
        return;
      }
      
      closeStreamsInFolder(folderPath);
      cleanTrashInFolder(folderPath);
      
      fs.rmSync(folderPath, { recursive: true, force: true, maxRetries: 2, retryDelay: 500 });
      console.log(`🗑️ Folder deleted: ${path.basename(folderPath)}`);
    } catch (err) {
      if (attempt < maxAttempts) {
        if (attempt % 5 === 0) {
          console.log(`⏳ Folder retry ${attempt}/${maxAttempts}: ${path.basename(folderPath)}`);
        }
        scheduleRealDeleteFolder(folderPath, attempt + 1);
      } else {
        console.error(`❌ Gave up folder: ${path.basename(folderPath)}`);
      }
    }
  }, delay);
}

function cleanupTrashOnStart() {
  console.log('🧹 Cleaning up trash from previous session...');
  
  function cleanDir(dir) {
    if (!fs.existsSync(dir)) return;
    
    try {
      const items = fs.readdirSync(dir, { withFileTypes: true });
      
      for (const item of items) {
        const fullPath = path.join(dir, item.name);
        
        if (item.name.startsWith(TRASH_PREFIX)) {
          try {
            if (item.isDirectory()) {
              fs.rmSync(fullPath, { recursive: true, force: true });
            } else {
              fs.unlinkSync(fullPath);
            }
            console.log(`🧹 Cleaned: ${item.name}`);
          } catch (e) {
            if (item.isDirectory()) {
              scheduleRealDeleteFolder(fullPath);
            } else {
              scheduleRealDelete(fullPath);
            }
          }
        } else if (item.isDirectory()) {
          cleanDir(fullPath);
        }
      }
    } catch (e) {}
  }
  
  cleanDir(SHARED_ROOT);
}

cleanupTrashOnStart();

// ======================
// ТОКЕНЫ ДЛЯ СКАЧИВАНИЯ
// ======================
const downloadTokens = new Map();

function createDownloadToken(data) { // Принимаем объект data целиком
  const token = crypto.randomBytes(16).toString('hex');
  downloadTokens.set(token, {
    ...data, // Копируем все поля (path, files, type и т.д.)
    expires: Date.now() + 300000
  });
  return token;
}

// ======================
// DOWNLOAD ENDPOINT
// ======================
app.get('/download/:token', (req, res) => {
  const token = req.params.token;
  const data = downloadTokens.get(token);
  
  if (!data || data.expires < Date.now()) {
    downloadTokens.delete(token);
    return res.status(404).send('Token expired or invalid');
  }
  
  try {
    const filePath = resolveSafePath(data.path);
    
    if (!fs.existsSync(filePath)) {
      return res.status(404).send('File not found');
    }
    
    const stat = fs.statSync(filePath);
    const ext = path.extname(filePath).toLowerCase();
    
    const mimeTypes = {
      // Видео
      '.mp4': 'video/mp4',
      '.webm': 'video/webm',
      '.mkv': 'video/x-matroska', // Важно для MKV
      '.avi': 'video/x-msvideo',
      '.mov': 'video/quicktime',
      '.flv': 'video/x-flv',
      '.wmv': 'video/x-ms-wmv',
      
      // Аудио
      '.mp3': 'audio/mpeg',
      '.wav': 'audio/wav',
      '.ogg': 'audio/ogg',
      '.m4a': 'audio/mp4',
      '.flac': 'audio/flac',
      
      // Картинки
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.svg': 'image/svg+xml',
      '.bmp': 'image/bmp',
      '.ico': 'image/x-icon',
      
      // Документы
      '.pdf': 'application/pdf',
      '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // Word
      '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // Excel
      
      // Текст и код
      '.txt': 'text/plain; charset=utf-8',
      '.html': 'text/html',
      '.css': 'text/css',
      '.js': 'text/javascript',
      '.json': 'application/json',
      '.xml': 'text/xml',
      '.md': 'text/markdown',
      '.log': 'text/plain; charset=utf-8',
      '.ini': 'text/plain; charset=utf-8',
      '.c': 'text/plain; charset=utf-8',
      '.cpp': 'text/plain; charset=utf-8',
      '.h': 'text/plain; charset=utf-8',
      '.cs': 'text/plain; charset=utf-8',
      '.py': 'text/plain; charset=utf-8',
      '.java': 'text/plain; charset=utf-8',
      '.php': 'text/plain; charset=utf-8',
      '.sh': 'text/plain; charset=utf-8',
      '.bat': 'text/plain; charset=utf-8',

            // Архивы
      '.zip': 'application/zip',
      '.rar': 'application/x-rar-compressed',
      '.7z': 'application/x-7z-compressed',
      '.tar': 'application/x-tar',
      '.gz': 'application/gzip',
      
      // Презентации
      '.ppt': 'application/vnd.ms-powerpoint',
      '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    };
    
    const mimeType = mimeTypes[ext] || 'application/octet-stream';
    res.setHeader('Content-Type', mimeType);

    // === ИСПРАВЛЕНИЕ ===
    // Смотрим, хочет ли клиент просто посмотреть файл или скачать
    const action = req.query.action; // Получаем параметр ?action=...
    const disposition = action === 'view' ? 'inline' : 'attachment';
    
    const downloadName = encodeURIComponent(path.basename(filePath));
    // Ставим inline или attachment в зависимости от запроса
    res.setHeader('Content-Disposition', `${disposition}; filename*=UTF-8''${downloadName}`);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Connection', 'close');
    
    const range = req.headers.range;
    let stream;
    
    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
      const chunksize = (end - start) + 1;
      
      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
      res.setHeader('Content-Length', chunksize);
      
      stream = fs.createReadStream(filePath, { start, end, autoClose: true });
    } else {
      res.setHeader('Content-Length', stat.size);
      stream = fs.createReadStream(filePath, { autoClose: true });
    }
    
    // Отслеживаем стрим
    const streamId = crypto.randomBytes(8).toString('hex');
    activeStreams.set(streamId, { stream, res, filePath });
    
    stream.on('close', () => {
      activeStreams.delete(streamId);
    });
    
    stream.on('error', () => {
      activeStreams.delete(streamId);
    });
    
    res.on('close', () => {
      stream.destroy();
      activeStreams.delete(streamId);
    });
    
    stream.pipe(res);
    
  } catch (err) {
    console.error('Download error:', err);
    res.status(500).send('Error reading file');
  }
});

// ======================
// ZIP DOWNLOAD ENDPOINT
// ======================
app.get('/zip/:token', (req, res) => {
  const token = req.params.token;
  const data = downloadTokens.get(token);

  if (!data || data.expires < Date.now()) {
    return res.status(404).send('Token expired');
  }

  // Настройка заголовков
  const archiveName = 'archive.zip';
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${archiveName}"`);

  // Создаем архив
  const archive = archiver('zip', {
    zlib: { level: 5 } // Уровень сжатия (0-9)
  });

  // Если вдруг ошибка архивации
  archive.on('error', (err) => {
    console.error('Archiver error:', err);
    res.status(500).end();
  });

  // Пайпим архив в ответ (отправляем клиенту на лету)
  archive.pipe(res);

  // Добавляем файлы/папки в архив
  const parentDir = resolveSafePath(data.cwd); // Текущая папка, откуда качаем

  for (const itemName of data.files) {
    const fullPath = path.join(parentDir, itemName);
    
    if (!fs.existsSync(fullPath)) continue;

    const stat = fs.statSync(fullPath);
    
    if (stat.isDirectory()) {
      // Добавляем папку рекурсивно
      archive.directory(fullPath, itemName);
    } else {
      // Добавляем файл
      archive.file(fullPath, { name: itemName });
    }
  }

  // Финализируем (закрываем) архив
  archive.finalize();
  
  // Токен удаляем сразу (или можно оставить до истечения)
  downloadTokens.delete(token);
});

// ======================
// HTTPS SERVER
// ======================
const server = http.createServer(app); 

// ======================
// WEBSOCKET
// ======================
const wss = new WebSocket.Server({ 
  server,
  perMessageDeflate: false,
  maxPayload: 10 * 1024 * 1024
});

const sessions = new Map();
const uploads = new Map();

wss.on('connection', (ws) => {
  console.log('🔌 New WebSocket connection');

  if (sessions.size >= MAX_SESSIONS) {
    ws.send(JSON.stringify({ type: 'error', message: 'Too many connections' }));
    ws.close();
    return;
  }

  ws._socket.setNoDelay(true);
  ws._socket.setKeepAlive(true, 30000);

  let sessionId = null;
  let sessionUploads = new Set();

  ws.on('message', async (data) => {
    let msg;
    
    try {
      const text = data.toString();
      msg = JSON.parse(text);
    } catch {
      if (Buffer.isBuffer(data) || data instanceof ArrayBuffer) {
        const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
        
        let activeUpload = null;
        let activeUploadId = null;
        
        for (const uploadId of sessionUploads) {
          const upload = uploads.get(uploadId);
          if (upload && upload.active) {
            activeUpload = upload;
            activeUploadId = uploadId;
            break;
          }
        }
        
        if (activeUpload) {
          try {
            activeUpload.stream.write(buffer);
            activeUpload.received += buffer.length;

            const shouldReport = 
              activeUpload.received - activeUpload.lastReport > 500 * 1024 || 
              activeUpload.received >= activeUpload.size;
            
            if (shouldReport) {
              ws.send(JSON.stringify({
                type: 'upload_progress',
                uploadId: activeUploadId,
                received: activeUpload.received,
                size: activeUpload.size
              }));
              activeUpload.lastReport = activeUpload.received;
            }
          } catch (writeErr) {
            console.error('Write error:', writeErr);
            ws.send(JSON.stringify({ 
              type: 'upload_error', 
              uploadId: activeUploadId, 
              message: 'Write failed' 
            }));
            
            activeUpload.active = false;
            uploads.delete(activeUploadId);
            sessionUploads.delete(activeUploadId);
          }
        }
      }
      return;
    }

    // ---------- AUTH ----------
    if (msg.type === 'auth') {
      if (!checkPassword(msg.code)) {
          ws.send(JSON.stringify({ type: 'auth', ok: false }));
          ws.close();
          return;
      }

      sessionId = crypto.randomUUID();
      sessions.set(sessionId, {
        id: sessionId,
        currentPath: '/',
        ws: ws
      });

      ws.send(JSON.stringify({ type: 'auth', ok: true }));
      console.log('✅ Authorized:', sessionId);
      
      return;
    }

    if (!sessionId || !sessions.has(sessionId)) {
      ws.close();
      return;
    }

    const session = sessions.get(sessionId);

    // ---------- LS ----------
    if (msg.type === 'ls') {
      try {
        ws.send(JSON.stringify({
          type: 'ls',
          path: session.currentPath,
          items: listDirectory(session.currentPath)
        }));
      } catch (err) {
        ws.send(JSON.stringify({ type: 'error', message: err.message }));
      }
      return;
    }

    // ---------- DOWNLOAD ----------
    if (msg.type === 'download') {
      try {
        const safeName = sanitizeFilename(msg.name);
        const vp = path.join(session.currentPath, safeName).replace(/\\/g, '/');
        const token = createDownloadToken({ path: vp });
        ws.send(JSON.stringify({
          type: 'download_ready',
          token,
          filename: safeName,
          action: msg.action || 'view' // Передаём действие обратно
        }));
      } catch (err) {
        ws.send(JSON.stringify({ type: 'error', message: err.message }));
      }
      return;
    }

        // ---------- RENAME ----------
    if (msg.type === 'rename') {
      try {
        const safeOldName = sanitizeFilename(msg.oldName);
        const safeNewName = sanitizeFilename(msg.newName);
        
        const oldPath = resolveSafePath(path.join(session.currentPath, safeOldName));
        const newPath = resolveSafePath(path.join(session.currentPath, safeNewName));

        if (!fs.existsSync(oldPath)) {
           throw new Error('File not found');
        }
        if (fs.existsSync(newPath)) {
           throw new Error('Name already taken');
        }

        fs.renameSync(oldPath, newPath);
        console.log(`✏️ Renamed: ${safeOldName} -> ${safeNewName}`);
        
        ws.send(JSON.stringify({ type: 'rename', ok: true }));
      } catch (err) {
        ws.send(JSON.stringify({ type: 'error', message: err.message }));
      }
      return;
    }

    // ---------- DOWNLOAD SELECTED (ZIP) ----------
    if (msg.type === 'download_zip') {
      try {
        // msg.files - массив имен файлов ['file1.txt', 'folder2']
        const token = createDownloadToken({
          cwd: session.currentPath, // Запоминаем текущую папку
          files: msg.files,
          type: 'zip'
        });
        
        ws.send(JSON.stringify({
          type: 'zip_ready',
          token: token
        }));
      } catch (err) {
        ws.send(JSON.stringify({ type: 'error', message: err.message }));
      }
      return;
    }

    // ---------- MKDIR ----------
    if (msg.type === 'mkdir') {
      try {
        const safeName = sanitizeFilename(msg.name);
        const vp = path.join(session.currentPath, safeName).replace(/\\/g, '/');
        fs.mkdirSync(resolveSafePath(vp));
        ws.send(JSON.stringify({ type: 'mkdir', ok: true }));
      } catch (err) {
        ws.send(JSON.stringify({ type: 'error', message: err.message }));
      }
      return;
    }

    // ---------- RM ----------
    if (msg.type === 'rm') {
      try {
        const safeName = sanitizeFilename(msg.name);
        const vp = path.join(session.currentPath, safeName).replace(/\\/g, '/');
        const realPath = resolveSafePath(vp);
        
        console.log(`🗑️ Deleting: ${safeName}`);
        const result = await smartDelete(realPath);
        
        if (result.delayed) {
          console.log(`⏳ Delayed delete scheduled: ${safeName}`);
        }
        
        ws.send(JSON.stringify({ type: 'rm', ok: true }));
      } catch (err) {
        ws.send(JSON.stringify({ type: 'error', message: err.message }));
      }
      return;
    }

    // ---------- RMDIR ----------
    if (msg.type === 'rmdir') {
      try {
        const safeName = sanitizeFilename(msg.name);
        const vp = path.join(session.currentPath, safeName).replace(/\\/g, '/');
        const realPath = resolveSafePath(vp);
        
        console.log(`🗑️ Deleting folder: ${safeName}`);
        const result = await smartDeleteFolder(realPath);
        
        ws.send(JSON.stringify({ type: 'rmdir', ok: true }));
      } catch (err) {
        ws.send(JSON.stringify({ type: 'error', message: err.message }));
      }
      return;
    }

    // ---------- CD ----------
    if (msg.type === 'cd') {
      try {
        let next;
        if (msg.name === '..') {
          next = path.dirname(session.currentPath);
        } else {
          const safeName = sanitizeFilename(msg.name);
          next = path.join(session.currentPath, safeName);
        }

        if (next === '.') next = '/';
        const real = resolveSafePath(next);

        if (!fs.existsSync(real) || !fs.statSync(real).isDirectory()) {
          ws.send(JSON.stringify({ type: 'error', message: 'Directory not found' }));
          return;
        }

        session.currentPath = next.replace(/\\/g, '/');

        ws.send(JSON.stringify({
          type: 'cd',
          path: session.currentPath,
          items: listDirectory(session.currentPath)
        }));
      } catch (err) {
        ws.send(JSON.stringify({ type: 'error', message: err.message }));
      }
      return;
    }

    // ---------- REFRESH ----------
    if (msg.type === 'refresh') {
      try {
        ws.send(JSON.stringify({
          type: 'ls',
          path: session.currentPath,
          items: listDirectory(session.currentPath)
        }));
      } catch (err) {
        ws.send(JSON.stringify({ type: 'error', message: err.message }));
      }
      return;
    }

    // ---------- UPLOAD START ----------
    if (msg.type === 'upload_start') {
      try {
        if (sessionUploads.size >= MAX_UPLOADS_PER_SESSION) {
          ws.send(JSON.stringify({ 
            type: 'upload_error', 
            uploadId: msg.uploadId,
            message: 'Too many parallel uploads' 
          }));
          return;
        }

        if (msg.size > MAX_FILE_SIZE) {
          ws.send(JSON.stringify({ 
            type: 'upload_error', 
            uploadId: msg.uploadId,
            message: `Файл слишком большой. Максимум: ${MAX_FILE_SIZE / (1024*1024*1024)}GB` 
          }));
          return;
        }

        const safeName = sanitizeFilename(msg.name);
        const vp = path.join(session.currentPath, safeName).replace(/\\/g, '/');
        const realPath = resolveSafePath(vp);
        
        const uploadId = msg.uploadId || crypto.randomUUID();
        
        const stream = fs.createWriteStream(realPath, {
          highWaterMark: 1024 * 1024
        });

        stream.on('error', (err) => {
          console.error('Stream error:', err);
          ws.send(JSON.stringify({ 
            type: 'upload_error', 
            uploadId, 
            message: err.message 
          }));
          uploads.delete(uploadId);
          sessionUploads.delete(uploadId);
        });

        uploads.set(uploadId, {
          stream,
          received: 0,
          size: msg.size,
          lastReport: 0,
          active: true,
          filename: safeName,
          realPath: realPath,          // Чтобы знать, какой файл обновлять
          modified: msg.modified       // Дата, пришедшая от клиента
        });
        
        sessionUploads.add(uploadId);

        ws.send(JSON.stringify({ type: 'upload_ready', uploadId }));
        console.log(`📤 Upload started: ${safeName}`);
      } catch (err) {
        ws.send(JSON.stringify({ 
          type: 'upload_error', 
          uploadId: msg.uploadId,
          message: err.message 
        }));
      }
      return;
    }

    // ---------- UPLOAD END ----------
    if (msg.type === 'upload_end') {
      const uploadId = msg.uploadId;
      const upload = uploads.get(uploadId);
      
      if (upload) {
        upload.active = false;

        // 1. Сначала подписываемся на событие ПОЛНОГО закрытия файла
        // Это гарантирует, что ОС уже отпустила файл
        upload.stream.on('close', () => {
            
            // 2. Теперь безопасно меняем дату
            if (upload.modified && upload.realPath) {
              try {
                const timestamp = new Date(upload.modified);
                fs.utimesSync(upload.realPath, timestamp, timestamp);
                console.log(`🕒 Timestamp updated: ${upload.filename}`);
              } catch (timeErr) {
                console.error('Failed to set timestamp:', timeErr);
              }
            }

            // 3. Чистим память и отправляем ответ клиенту
            uploads.delete(uploadId);
            sessionUploads.delete(uploadId);
            console.log(`✅ Upload complete: ${upload.filename}`);
            ws.send(JSON.stringify({ type: 'upload_done', uploadId }));
        });

        // 4. И только теперь даем команду на закрытие
        upload.stream.end();
      }
      return;
    }

    // ---------- UPLOAD CANCEL ----------
    if (msg.type === 'upload_cancel') {
      const uploadId = msg.uploadId;
      const upload = uploads.get(uploadId);
      
      if (upload) {
        upload.active = false;
        upload.stream.destroy();
        uploads.delete(uploadId);
        sessionUploads.delete(uploadId);
        
        try {
          const vp = path.join(session.currentPath, upload.filename).replace(/\\/g, '/');
          fs.unlinkSync(resolveSafePath(vp));
        } catch (e) {}
        
        ws.send(JSON.stringify({ type: 'upload_cancelled', uploadId }));
      }
      return;
    }
  });

  ws.on('close', () => {
    for (const uploadId of sessionUploads) {
      const upload = uploads.get(uploadId);
      if (upload) {
        upload.stream.destroy();
        uploads.delete(uploadId);
      }
    }
    sessionUploads.clear();
    
    sessions.delete(sessionId);
    console.log('❌ Session closed:', sessionId);
  });

  ws.on('error', (err) => {
    console.error('WebSocket error:', err);
  });
});

// ======================
// ПЕРИОДИЧЕСКАЯ ОЧИСТКА
// ======================
setInterval(() => {
  const now = Date.now();
  
  for (const [token, data] of downloadTokens) {
    if (data.expires < now) {
      downloadTokens.delete(token);
    }
  }
}, 60000);

// ======================
// GRACEFUL SHUTDOWN
// ======================
function shutdown() {
  console.log('\n🛑 Shutting down...');
  
  // Закрываем все активные стримы
  for (const [id, data] of activeStreams) {
    try {
      if (data.stream) data.stream.destroy();
      if (data.res && !data.res.writableEnded) data.res.end();
    } catch (e) {}
  }
  activeStreams.clear();
  
  // Закрываем все загрузки
  for (const [uploadId, upload] of uploads) {
    try {
      upload.stream.end();
    } catch (e) {}
  }
  
  wss.clients.forEach(client => {
    client.close();
  });
  
  server.close(() => {
    console.log('👋 Server closed');
    process.exit(0);
  });
  
  setTimeout(() => {
    process.exit(1);
  }, 5000);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

function printServerInfo() {
  const interfaces = os.networkInterfaces();
  const wifiLAN = [];
  const others = [];

  // 1. Сортируем IP адреса
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        if (iface.address.startsWith('192.168.') || iface.address.startsWith('10.') || iface.address.startsWith('172.')) {
          wifiLAN.push(iface.address);
        } else {
          others.push(iface.address);
        }
      }
    }
  }

  // 2. Выводим заголовок
  console.log(`🚀 Server is running!`);
  console.log('='.repeat(50));
  
  // 3. Выводим текстовые ссылки
  console.log('\n🔗 Connect using one of these:');
  console.log(`   🏠 Local:       http://localhost:${PORT}`);
  
  wifiLAN.forEach(ip => {
    console.log(`   ✅ Wi-Fi/LAN:   http://${ip}:${PORT}`);
  });

  others.forEach(ip => {
    console.log(`   🌐 Other:       http://${ip}:${PORT}`);
  });

  // 4. ГЕНЕРАЦИЯ QR-КОДА (Новая часть)
  // Мы берем первый найденный Wi-Fi адрес и делаем для него код
  if (wifiLAN.length > 0) {
    const mainIp = wifiLAN[0];
    const url = `http://${mainIp}:${PORT}`;
    
    console.log(`\n📱 Scan QR to connect (${mainIp}):\n`);
    
    // small: true делает QR код компактным, чтобы влезал в экран
    qrcode.generate(url, { small: true });
  }

  console.log('='.repeat(50));

  // 5. Выводим настройки (как ты просил)
  // (Если ты не делал конфиг файл, используй SHARED_ROOT, если делал - config.sharedRoot)
  // Я пишу вариант для старых переменных, как ты хотел в прошлом сообщении:
  console.log(`\n📁 Shared folder: ${SHARED_ROOT}`); 
  console.log(`📊 Max file size: ${(MAX_FILE_SIZE / (1024*1024*1024)).toFixed(2)} GB`);
  console.log(`🔑 Server password: ${ACCESS_PASSWORD}`);
  console.log('\nWaiting for connections...\n');
}

// ======================
// СТАРТ
// ======================
server.listen(PORT, '0.0.0.0', () => { // '0.0.0.0' важен, чтобы слушать всю сеть
  printServerInfo();
});