'use strict';

// ─── API Base URL ─────────────────────────────────────────────────────────────
// Points to the Render backend. The frontend is hosted on GitHub Pages,
// so relative /api/* URLs would 404 — we need the absolute Render URL.
const API = 'https://ephone-clot.onrender.com';

// ─── State ────────────────────────────────────────────────────────────────────
let videos = [];
let selectedFile = null;

// Safe localStorage access
function getLikedSet() {
  try {
    return new Set(JSON.parse(localStorage.getItem('clips_liked') || '[]'));
  } catch {
    return new Set();
  }
}

function saveLikedSet(set) {
  try {
    localStorage.setItem('clips_liked', JSON.stringify([...set]));
  } catch {}
}

const likedSet = getLikedSet();

// ─── DOM Refs ─────────────────────────────────────────────────────────────────
const feed           = document.getElementById('feed');
const feedEmpty      = document.getElementById('feed-empty');
const uploadBtn      = document.getElementById('upload-btn');
const modal          = document.getElementById('upload-modal');
const backdrop       = document.getElementById('modal-backdrop');
const modalClose     = document.getElementById('modal-close');
const dropZone       = document.getElementById('drop-zone');
const browseBtn      = document.getElementById('browse-btn');
const fileInput      = document.getElementById('file-input');
const previewWrap    = document.getElementById('video-preview-wrap');
const videoPreview   = document.getElementById('video-preview');
const changeVideoBtn = document.getElementById('change-video-btn');
const titleInput     = document.getElementById('input-title');
const authorInput    = document.getElementById('input-author');
const postBtn        = document.getElementById('post-btn');
const uploadError    = document.getElementById('upload-error');
const uploadProgress = document.getElementById('upload-progress');
const progressFill   = document.getElementById('progress-fill');
const progressLabel  = document.getElementById('progress-label');

// ─── Load Feed ────────────────────────────────────────────────────────────────
async function loadFeed() {
  try {
    const res = await fetch(`${API}/api/videos`);
    if (!res.ok) throw new Error(`Server error: ${res.status}`);
    videos = await res.json();

    // Remove existing cards (but keep feed-empty)
    document.querySelectorAll('.clip-card').forEach(c => c.remove());

    if (videos.length === 0) {
      feedEmpty.hidden = false;
      return;
    }

    feedEmpty.hidden = true;
    videos.forEach(v => feed.appendChild(buildCard(v)));
  } catch (e) {
    console.error('Failed to load videos:', e);
    feedEmpty.hidden = false;
  }
}

// ─── Build Video Card ─────────────────────────────────────────────────────────
function buildCard(video) {
  const card = document.createElement('div');
  card.className = 'clip-card';
  card.dataset.id = video.id;

  const videoEl = document.createElement('video');
  videoEl.className = 'clip-video';
  videoEl.src = `${API}/api/video/${video.id}`;
  videoEl.setAttribute('playsinline', '');
  videoEl.setAttribute('loop', '');
  videoEl.setAttribute('muted', '');
  videoEl.setAttribute('preload', 'metadata');
  videoEl.muted = true; // Ensure muted for autoplay policy

  const overlay = document.createElement('div');
  overlay.className = 'clip-overlay';

  // Right sidebar actions
  const actions = document.createElement('div');
  actions.className = 'clip-actions';

  const isLiked = likedSet.has(video.id);
  const likeBtn = makeActionBtn(isLiked ? '❤️' : '🤍', video.likes || 0, 'like-btn');
  if (isLiked) likeBtn.classList.add('liked');

  likeBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (likedSet.has(video.id)) return;
    try {
      const r = await fetch(`${API}/api/like/${video.id}`, { method: 'POST' });
      if (!r.ok) throw new Error('Like failed');
      const data = await r.json();
      likedSet.add(video.id);
      saveLikedSet(likedSet);
      likeBtn.querySelector('.action-icon').textContent = '❤️';
      likeBtn.querySelector('.action-count').textContent = fmtNum(data.likes);
      likeBtn.classList.add('liked');
    } catch (err) {
      console.error('Like error:', err);
    }
  });

  const shareBtn = makeActionBtn('🔗', null, 'share-btn');
  shareBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    const url = `${API}/api/video/${video.id}`;
    try {
      if (navigator.share) {
        await navigator.share({ title: video.title, url });
      } else {
        await navigator.clipboard.writeText(url);
        alert('Link copied to clipboard!');
      }
    } catch {}
  });

  actions.appendChild(likeBtn);
  actions.appendChild(shareBtn);

  // Meta bottom
  const meta = document.createElement('div');
  meta.className = 'clip-meta';
  meta.innerHTML = `
    <div class="clip-author">${escHtml(video.author || 'Anonymous')}</div>
    <div class="clip-title">${escHtml(video.title || 'Untitled')}</div>
    <span class="clip-duration">${video.duration}s</span>
  `;

  overlay.appendChild(actions);
  overlay.appendChild(meta);
  card.appendChild(videoEl);
  card.appendChild(overlay);

  // IntersectionObserver: auto-play when card is fully in view
  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        // Try unmuted first; fall back to muted if browser blocks it
        videoEl.muted = false;
        const playPromise = videoEl.play();
        if (playPromise !== undefined) {
          playPromise.catch(() => {
            videoEl.muted = true;
            videoEl.play().catch(() => {});
          });
        }
      } else {
        videoEl.pause();
        videoEl.muted = true;
      }
    });
  }, { threshold: 0.6 });

  observer.observe(card);

  // Tap to pause/play
  card.addEventListener('click', () => {
    if (videoEl.paused) {
      videoEl.play().catch(() => {});
    } else {
      videoEl.pause();
    }
  });

  return card;
}

function makeActionBtn(icon, count, cls) {
  const btn = document.createElement('button');
  btn.className = `action-btn ${cls}`;
  btn.setAttribute('type', 'button');
  btn.innerHTML = `
    <div class="action-icon">${icon}</div>
    ${count !== null ? `<span class="action-count">${fmtNum(count)}</span>` : ''}
  `;
  return btn;
}

function fmtNum(n) {
  if (!n || isNaN(n)) return '0';
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return String(n);
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── Upload Modal ─────────────────────────────────────────────────────────────
function openModal() {
  modal.hidden = false;
  backdrop.hidden = false;
  document.body.style.overflow = 'hidden';
}

function closeModal() {
  modal.hidden = true;
  backdrop.hidden = true;
  document.body.style.overflow = '';
  resetUploadForm();
}

function resetUploadForm() {
  selectedFile = null;
  fileInput.value = '';
  videoPreview.src = '';
  previewWrap.hidden = true;
  dropZone.hidden = false;
  titleInput.value = '';
  authorInput.value = '';
  postBtn.disabled = true;
  uploadError.hidden = true;
  uploadProgress.hidden = true;
  progressFill.style.width = '0%';
  progressLabel.textContent = 'Uploading…';
}

uploadBtn.addEventListener('click', openModal);
modalClose.addEventListener('click', closeModal);
backdrop.addEventListener('click', closeModal);

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !modal.hidden) closeModal();
});

// ─── File Selection ───────────────────────────────────────────────────────────
function handleFileSelect(file) {
  if (!file) return;

  // Check MIME type loosely — browser file picker may give video/* or specific types
  if (!file.type.startsWith('video/') && file.type !== '') {
    showError('Please select a valid video file.');
    return;
  }

  // Check extension as fallback
  const ext = file.name.split('.').pop().toLowerCase();
  const allowedExts = ['mp4', 'mov', 'avi', 'webm', 'mkv'];
  if (file.type === '' && !allowedExts.includes(ext)) {
    showError('Unsupported file type. Use MP4, MOV, WEBM, AVI, or MKV.');
    return;
  }

  selectedFile = file;
  const url = URL.createObjectURL(file);
  videoPreview.src = url;
  videoPreview.load();

  videoPreview.onloadedmetadata = () => {
    if (videoPreview.duration > 60) {
      showError(`Video is ${Math.round(videoPreview.duration)}s long. Maximum is 60 seconds.`);
      selectedFile = null;
      URL.revokeObjectURL(url);
      videoPreview.src = '';
      previewWrap.hidden = true;
      dropZone.hidden = false;
      return;
    }
    previewWrap.hidden = false;
    dropZone.hidden = true;
    uploadError.hidden = true;
    postBtn.disabled = false;
  };

  videoPreview.onerror = () => {
    showError('Could not read video file. Please try a different file.');
    selectedFile = null;
    previewWrap.hidden = true;
    dropZone.hidden = false;
  };
}

browseBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  fileInput.click();
});

changeVideoBtn.addEventListener('click', () => {
  selectedFile = null;
  fileInput.value = '';
  if (videoPreview.src) URL.revokeObjectURL(videoPreview.src);
  videoPreview.src = '';
  previewWrap.hidden = true;
  dropZone.hidden = false;
  postBtn.disabled = true;
  uploadError.hidden = true;
});

fileInput.addEventListener('change', () => {
  if (fileInput.files[0]) handleFileSelect(fileInput.files[0]);
});

// ─── Drag & Drop ──────────────────────────────────────────────────────────────
dropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  e.stopPropagation();
  dropZone.classList.add('drag-over');
});

dropZone.addEventListener('dragleave', (e) => {
  e.stopPropagation();
  dropZone.classList.remove('drag-over');
});

dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  e.stopPropagation();
  dropZone.classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file) handleFileSelect(file);
});

dropZone.addEventListener('click', (e) => {
  // Don't double-trigger if browseBtn was clicked
  if (e.target === browseBtn || e.target.closest('#browse-btn')) return;
  fileInput.click();
});

// ─── Post Upload ──────────────────────────────────────────────────────────────
postBtn.addEventListener('click', async () => {
  if (!selectedFile) return;

  postBtn.disabled = true;
  uploadProgress.hidden = false;
  uploadError.hidden = true;
  progressFill.style.width = '0%';
  progressLabel.textContent = 'Uploading… 0%';

  const formData = new FormData();
  formData.append('video', selectedFile);
  formData.append('title', titleInput.value.trim() || 'Untitled Clip');
  formData.append('author', authorInput.value.trim() || 'Anonymous');

  const xhr = new XMLHttpRequest();
  xhr.open('POST', `${API}/api/upload`);

  xhr.upload.addEventListener('progress', (e) => {
    if (e.lengthComputable) {
      const pct = Math.round((e.loaded / e.total) * 80);
      progressFill.style.width = `${pct}%`;
      progressLabel.textContent = `Uploading… ${pct}%`;
    }
  });

  xhr.onload = async () => {
    if (xhr.status === 200) {
      progressFill.style.width = '90%';
      progressLabel.textContent = 'Processing frames…';
      await new Promise(r => setTimeout(r, 1000));
      progressFill.style.width = '100%';
      progressLabel.textContent = 'Done!';
      await new Promise(r => setTimeout(r, 400));
      closeModal();
      await loadFeed();
      feed.scrollTo({ top: 0, behavior: 'smooth' });
    } else {
      let errMsg = 'Upload failed. Please try again.';
      try {
        const data = JSON.parse(xhr.responseText);
        errMsg = data.error || errMsg;
      } catch {}
      showError(errMsg);
      postBtn.disabled = false;
      uploadProgress.hidden = true;
    }
  };

  xhr.onerror = () => {
    showError('Network error. Check your connection and try again.');
    postBtn.disabled = false;
    uploadProgress.hidden = true;
  };

  xhr.ontimeout = () => {
    showError('Upload timed out. Your video may be too large.');
    postBtn.disabled = false;
    uploadProgress.hidden = true;
  };

  xhr.timeout = 5 * 60 * 1000; // 5 minute timeout for large files
  xhr.send(formData);
});

function showError(msg) {
  uploadError.textContent = msg;
  uploadError.hidden = false;
}

// ─── Init ─────────────────────────────────────────────────────────────────────
// Show empty state initially while loading
feedEmpty.hidden = false;
loadFeed();
