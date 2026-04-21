'use strict';

const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;

const MAX_DURATION_SECONDS = 60;
const FRAME_WIDTH = 240;
const FRAME_HEIGHT = 320;
const FRAMES_PER_SECOND = 8;

const DATA_DIR = path.join(__dirname, 'data');
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const PUBLIC_DIR = path.join(__dirname, 'public');
const VIDEOS_JSON = path.join(DATA_DIR, 'videos.json');

[DATA_DIR, UPLOADS_DIR, PUBLIC_DIR].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

let videos = [];
if (fs.existsSync(VIDEOS_JSON)) {
  try { videos = JSON.parse(fs.readFileSync(VIDEOS_JSON, 'utf8')); }
  catch { videos = []; }
}

function saveVideos() {
  try { fs.writeFileSync(VIDEOS_JSON, JSON.stringify(videos, null, 2)); }
  catch (e) { console.error('Failed to save videos.json:', e.message); }
}

let ffmpegAvailable = false;
exec('ffmpeg -version', (err) => {
  if (err) {
    console.warn('WARNING: ffmpeg not found. Uploads will fail.');
    console.warn('Fix: set Build Command in Render to: apt-get install -y ffmpeg && npm install');
  } else {
    ffmpegAvailable = true;
    console.log('ffmpeg is available');
  }
});

let ephone_session = { videoIdx: 0, frameIdx: 0 };

function advanceFrame() {
  if (videos.length === 0) return;
  if (ephone_session.videoIdx >= videos.length) ephone_session.videoIdx = 0;
  const vid = videos[ephone_session.videoIdx];
  if (!vid) return;
  ephone_session.frameIdx++;
  if (ephone_session.frameIdx >= vid.frameCount) ephone_session.frameIdx = 0;
}

app.use(cors());
app.use(express.json());

// ── API routes FIRST ─────────────────────────────────────────────────────────

app.get('/api/videos', (req, res) => {
  const enriched = videos.map(v => ({
    ...v,
    thumbnailUrl: `/api/thumb/${v.id}`,
    frameUrl: `/api/frame/${v.id}/0`,
  }));
  res.json(enriched);
});

app.get('/api/thumb/:id', (req, res) => {
  const framePath = path.join(UPLOADS_DIR, req.params.id, 'frame_0001.jpg');
  if (!fs.existsSync(framePath)) return res.status(404).json({ error: 'Not found' });
  res.set('Cache-Control', 'public, max-age=86400');
  res.sendFile(framePath);
});

// /api/frame/current MUST be before /api/frame/:id/:frameIdx
app.get('/api/frame/current', (req, res) => {
  if (videos.length === 0) return res.status(404).json({ error: 'No videos' });
  if (ephone_session.videoIdx >= videos.length) ephone_session.videoIdx = 0;
  const vid = videos[ephone_session.videoIdx];
  if (!vid) return res.status(404).json({ error: 'No video' });
  if (ephone_session.frameIdx >= vid.frameCount) ephone_session.frameIdx = 0;
  const idx = ephone_session.frameIdx + 1;
  const frameFile = `frame_${String(idx).padStart(4, '0')}.jpg`;
  const framePath = path.join(UPLOADS_DIR, vid.id, frameFile);
  advanceFrame();
  if (ephone_session.frameIdx === 0) {
    vid.views = (vid.views || 0) + 1;
    saveVideos();
  }
  if (!fs.existsSync(framePath)) return res.status(404).json({ error: 'Frame not found' });
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(framePath);
});

app.get('/api/frame/:id/:frameIdx', (req, res) => {
  const frameNum = parseInt(req.params.frameIdx, 10);
  if (isNaN(frameNum) || frameNum < 0) return res.status(400).json({ error: 'Invalid frame index' });
  const idx = frameNum + 1;
  const frameFile = `frame_${String(idx).padStart(4, '0')}.jpg`;
  const framePath = path.join(UPLOADS_DIR, req.params.id, frameFile);
  if (!fs.existsSync(framePath)) return res.status(404).json({ error: 'Not found' });
  res.set('Cache-Control', 'public, max-age=3600');
  res.sendFile(framePath);
});

app.post('/api/next', (req, res) => {
  if (videos.length === 0) return res.json({ ok: true });
  ephone_session.videoIdx = (ephone_session.videoIdx + 1) % videos.length;
  ephone_session.frameIdx = 0;
  res.json({ ok: true, videoIdx: ephone_session.videoIdx, title: videos[ephone_session.videoIdx]?.title });
});

app.post('/api/like/:id', (req, res) => {
  const vid = videos.find(v => v.id === req.params.id);
  if (!vid) return res.status(404).json({ error: 'Not found' });
  vid.likes = (vid.likes || 0) + 1;
  saveVideos();
  res.json({ likes: vid.likes });
});

app.get('/api/video/:id', (req, res) => {
  const vid = videos.find(v => v.id === req.params.id);
  if (!vid) return res.status(404).json({ error: 'Not found' });
  const videoPath = path.join(UPLOADS_DIR, vid.id, vid.videoFile);
  if (!fs.existsSync(videoPath)) return res.status(404).json({ error: 'Video file not found' });
  res.sendFile(videoPath);
});

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => cb(null, `${uuidv4()}_raw${path.extname(file.originalname)}`),
});

const upload = multer({
  storage,
  limits: { fileSize: 500 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['.mp4', '.mov', '.avi', '.webm', '.mkv'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) return cb(null, true);
    cb(new Error('Only video files are allowed'));
  },
});

function getVideoDuration(filePath) {
  return new Promise((resolve, reject) => {
    exec(
      `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`,
      { timeout: 30000 },
      (err, stdout) => {
        if (err) return reject(new Error('ffprobe failed: ' + err.message));
        const dur = parseFloat(stdout.trim());
        if (isNaN(dur)) return reject(new Error('Could not parse video duration'));
        resolve(dur);
      }
    );
  });
}

function extractFrames(inputPath, outputDir, fps, width, height) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
    const cmd = [
      'ffmpeg',
      `-i "${inputPath}"`,
      `-vf "fps=${fps},scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black"`,
      '-q:v 5',
      '-threads 2',
      `"${outputDir}/frame_%04d.jpg"`,
      '-y'
    ].join(' ');
    exec(cmd, { timeout: 120000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error('ffmpeg failed: ' + (stderr || err.message)));
      const frames = fs.readdirSync(outputDir).filter(f => f.endsWith('.jpg'));
      resolve(frames.length);
    });
  });
}

app.post('/api/upload', (req, res, next) => {
  if (!ffmpegAvailable) {
    return res.status(503).json({
      error: 'ffmpeg not installed on server. In Render dashboard: Settings → Build Command → set to: apt-get install -y ffmpeg && npm install'
    });
  }
  next();
}, upload.single('video'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No video file provided' });

  const rawPath = req.file.path;
  const id = uuidv4();
  const videoDir = path.join(UPLOADS_DIR, id);

  try {
    const duration = await getVideoDuration(rawPath);
    if (duration > MAX_DURATION_SECONDS) {
      fs.unlinkSync(rawPath);
      return res.status(400).json({ error: `Video too long: ${Math.round(duration)}s. Max is ${MAX_DURATION_SECONDS}s.` });
    }

    fs.mkdirSync(videoDir, { recursive: true });
    const frameCount = await extractFrames(rawPath, videoDir, FRAMES_PER_SECOND, FRAME_WIDTH, FRAME_HEIGHT);

    if (frameCount === 0) {
      fs.unlinkSync(rawPath);
      fs.rmSync(videoDir, { recursive: true, force: true });
      return res.status(500).json({ error: 'Failed to extract frames.' });
    }

    const ext = path.extname(req.file.originalname) || '.mp4';
    const finalVideoPath = path.join(videoDir, 'video' + ext);
    fs.renameSync(rawPath, finalVideoPath);

    const meta = {
      id,
      title: (req.body.title || 'Untitled Clip').slice(0, 80),
      author: (req.body.author || 'Anonymous').slice(0, 40),
      duration: Math.round(duration),
      frameCount,
      fps: FRAMES_PER_SECOND,
      likes: 0,
      views: 0,
      uploadedAt: new Date().toISOString(),
      videoFile: path.basename(finalVideoPath),
    };

    videos.unshift(meta);
    saveVideos();
    res.json({ success: true, id, frameCount, duration: meta.duration });

  } catch (err) {
    console.error('Upload error:', err);
    try { fs.unlinkSync(rawPath); } catch {}
    try { fs.rmSync(videoDir, { recursive: true, force: true }); } catch {}
    res.status(500).json({ error: 'Upload failed: ' + err.message });
  }
});

// ── Static files AFTER all API routes ────────────────────────────────────────
app.use(express.static(PUBLIC_DIR));

// ── SPA fallback, but never for /api/ paths ───────────────────────────────────
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'API route not found: ' + req.path });
  }
  const indexPath = path.join(PUBLIC_DIR, 'index.html');
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.status(500).send(
      '<h2>Missing public/index.html</h2>' +
      '<p>Ensure your repo has a <code>public/</code> folder with index.html, style.css, app.js.</p>' +
      '<p>PUBLIC_DIR = ' + PUBLIC_DIR + '</p>'
    );
  }
});

app.listen(PORT, () => {
  console.log(`ePhone Clips running on port ${PORT}`);
  console.log(`PUBLIC_DIR: ${PUBLIC_DIR} | exists: ${fs.existsSync(PUBLIC_DIR)}`);
  console.log(`index.html: ${fs.existsSync(path.join(PUBLIC_DIR, 'index.html'))}`);
  console.log(`Videos loaded: ${videos.length}`);
});
