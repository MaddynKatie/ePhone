'use strict';

// ─── State ────────────────────────────────────────────────────────────────────
let videos = [];
let selectedFile = null;
const likedSet = new Set(JSON.parse(localStorage.getItem('clips_liked') || '[]'));

// ─── DOM Refs ─────────────────────────────────────────────────────────────────
const feed          = document.getElementById('feed');
const feedEmpty     = document.getElementById('feed-empty');
const uploadBtn     = document.getElementById('upload-btn');
const modal         = document.getElementById('upload-modal');
const backdrop      = document.getElementById('modal-backdrop');
const modalClose    = document.getElementById('modal-close');
const dropZone      = document.getElementById('drop-zone');
const browseBtn     = document.getElementById('browse-btn');
const fileInput     = document.getElementById('file-input');
const previewWrap   = document.getElementById('video-preview-wrap');
const videoPreview  = document.getElementById('video-preview');
const changeVideoBtn= document.getElementById('change-video-btn');
const titleInput    = document.getElementById('input-title');
const authorInput   = document.getElementById('input-author');
const postBtn       = document.getElementById('post-btn');
const uploadError   = document.getElementById('upload-error');
const uploadProgress= document.getElementById('upload-progress');
const progressFill  = document.getElementById('progress-fill');
const progressLabel = document.getElementById('progress-label');

// ─── Load Feed ────────────────────────────────────────────────────────────────
async function loadFeed() {
  try {
    const res = await fetch('/api/videos');
    videos = await res.json();

    if (videos.length === 0) {
      feedEmpty.hidden = false;
      return;
    }

    feedEmpty.hidden = true;
    // Remove existing cards
    document.querySelectorAll('.clip-card').forEach(c => c.remove());

    videos.forEach(v => feed.appendChild(buildCard(v)));
  } catch (e) {
    console.error('Failed to load videos:', e);
  }
}

// ─── Build Video Card ─────────────────────────────────────────────────────────
function buildCard(video) {
  const card = document.createElement('div');
  card.className = 'clip-card';
  card.dataset.id = video.id;

  const videoEl = document.createElement('video');
  videoEl.className = 'clip-video';
  videoEl.src = `/api/video/${video.id}`;
  videoEl.setAttribute('playsinline', '');
  videoEl.setAttribute('loop', '');
  videoEl.setAttribute('muted', '');
  videoEl.setAttribute('preload', 'metadata');

  const overlay = document.createElement('div');
  overlay.className = 'clip-overlay';

  // Right sidebar
  const actions = document.createElement('div');
  actions.className = 'clip-actions';

  const isLiked = likedSet.has(video.id);
  const likeBtn = makeActionBtn(isLiked ? '❤️' : '🤍', video.likes || 0, 'like-btn');
  if (isLiked) likeBtn.classList.add('liked');

  likeBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (likedSet.has(video.id)) return; // Already liked
    try {
      const r = await fetch(`/api/like/${video.id}`, { method: 'POST' });
      const data = await r.json();
      likedSet.add(video.id);
      localStorage.setItem('clips_liked', JSON.stringify([...likedSet]));
      likeBtn.querySelector('.action-icon').textContent = '❤️';
      likeBtn.querySelector('.action-count').textContent = fmtNum(data.likes);
      likeBtn.classList.add('liked');
    } catch {}
  });

  const shareBtn = makeActionBtn('🔗', null, 'share-btn');
  shareBtn.addEventListener('click', async () => {
    const url = `${location.origin}/api/video/${video.id}`;
    try {
      if (navigator.share) {
        await navigator.share({ title: video.title, url });
      } else {
        await navigator.clipboard.writeText(url);
        alert('Link copied!');
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

  // Auto-play on scroll into view
  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        videoEl.play().catch(() => {});
        videoEl.muted = false;
      } else {
        videoEl.pause();
        videoEl.muted = true;
      }
    });
  }, { threshold: 0.7 });

  observer.observe(card);

  // Tap to pause/play
  card.addEventListener('click', () => {
    if (videoEl.paused) videoEl.play();
    else videoEl.pause();
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
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return String(n);
}

function escHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
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
}

uploadBtn.addEventListener('click', openModal);
modalClose.addEventListener('click', closeModal);
backdrop.addEventListener('click', closeModal);

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !modal.hidden) closeModal();
});

// ─── File Selection ───────────────────────────────────────────────────────────
function handleFileSelect(file) {
  if (!file || !file.type.startsWith('video/')) {
    showError('Please select a valid video file.');
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
}

browseBtn.addEventListener('click', () => fileInput.click());
changeVideoBtn.addEventListener('click', () => {
  selectedFile = null;
  fileInput.value = '';
  videoPreview.src = '';
  previewWrap.hidden = true;
  dropZone.hidden = false;
  postBtn.disabled = true;
});

fileInput.addEventListener('change', () => {
  if (fileInput.files[0]) handleFileSelect(fileInput.files[0]);
});

// ─── Drag & Drop ──────────────────────────────────────────────────────────────
dropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropZone.classList.add('drag-over');
});

dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));

dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file) handleFileSelect(file);
});

dropZone.addEventListener('click', (e) => {
  if (e.target !== browseBtn) fileInput.click();
});

// ─── Post Upload ──────────────────────────────────────────────────────────────
postBtn.addEventListener('click', async () => {
  if (!selectedFile) return;

  postBtn.disabled = true;
  uploadProgress.hidden = false;
  uploadError.hidden = true;

  const formData = new FormData();
  formData.append('video', selectedFile);
  formData.append('title', titleInput.value.trim() || 'Untitled Clip');
  formData.append('author', authorInput.value.trim() || 'Anonymous');

  try {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/upload');

    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable) {
        const pct = Math.round((e.loaded / e.total) * 80); // 0-80% for upload
        progressFill.style.width = `${pct}%`;
        progressLabel.textContent = `Uploading… ${pct}%`;
      }
    });

    xhr.onload = async () => {
      if (xhr.status === 200) {
        progressFill.style.width = '100%';
        progressLabel.textContent = 'Done! Processing frames…';
        await new Promise(r => setTimeout(r, 800));
        closeModal();
        await loadFeed();
        // Scroll to top of feed to see new clip
        feed.scrollTo({ top: 0, behavior: 'smooth' });
      } else {
        let errMsg = 'Upload failed.';
        try { errMsg = JSON.parse(xhr.responseText).error || errMsg; } catch {}
        showError(errMsg);
        postBtn.disabled = false;
        uploadProgress.hidden = true;
      }
    };

    xhr.onerror = () => {
      showError('Network error. Check your connection.');
      postBtn.disabled = false;
      uploadProgress.hidden = true;
    };

    xhr.send(formData);
  } catch (e) {
    showError('Upload error: ' + e.message);
    postBtn.disabled = false;
    uploadProgress.hidden = true;
  }
});

function showError(msg) {
  uploadError.textContent = msg;
  uploadError.hidden = false;
}

// ─── Init ─────────────────────────────────────────────────────────────────────
loadFeed();
