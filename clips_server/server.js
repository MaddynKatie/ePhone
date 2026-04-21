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

// ─── Constants ────────────────────────────────────────────────────────────────
const MAX_DURATION_SECONDS = 60;
const FRAME_WIDTH = 240;
const FRAME_HEIGHT = 320;
const FRAMES_PER_SECOND = 8;

// ─── Directory Setup ──────────────────────────────────────────────────────────
const DATA_DIR = path.join(__dirname, 'data');
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const PUBLIC_DIR = path.join(__dirname, 'public');
const VIDEOS_JSON = path.join(DATA_DIR, 'videos.json');

[DATA_DIR, UPLOADS_DIR, PUBLIC_DIR].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

// ─── In-Memory Video DB ───────────────────────────────────────────────────────
let videos = [];
if (fs.existsSync(VIDEOS_JSON)) {
  try { videos = JSON.parse(fs.readFileSync(VIDEOS_JSON, 'utf8')); }
  catch { videos = []; }
}

function saveVideos() {
  fs.writeFileSync(VIDEOS_JSON, JSON.stringify(videos, null, 2));
}

// ─── ePhone Session State ─────────────────────────────────────────────────────
let ephone_session = {
  videoIdx: 0,
  frameIdx: 0,
};

function advanceFrame() {
  if (videos.length === 0) return;
  // Clamp index first
  if (ephone_session.videoIdx >= videos.length) ephone_session.videoIdx = 0;
  const vid = videos[ephone_session.videoIdx];
  ephone_session.frameIdx++;
  if (ephone_session.frameIdx >= vid.frameCount) {
    ephone_session.frameIdx = 0;
  }
}

// ─── Middleware ────────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());

// Serve static files from public/ directory
app.use(express.static(PUBLIC_DIR));

// ─── Multer Config ─────────────────────────────────────────────────────────────
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
    cb(new Error('Only video files are allowed (mp4, mov, avi, webm, mkv)'));
  },
});

// ─── Helper: get video duration ────────────────────────────────────────────────
function getVideoDuration(filePath) {
  return new Promise((resolve, reject) => {
    exec(
      `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`,
      (err, stdout) => {
        if (err) return reject(err);
        const dur = parseFloat(stdout.trim());
        if (isNaN(dur)) return reject(new Error('Could not read video duration'));
        resolve(dur);
      }
    );
  });
}

// ─── Helper: extract frames ───────────────────────────────────────────────────
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
      if (err) return reject(new Error('ffmpeg error: ' + stderr));
      const frames = fs.readdirSync(outputDir).filter(f => f.endsWith('.jpg'));
      resolve(frames.length);
    });
  });
}

// ─── POST /api/upload ─────────────────────────────────────────────────────────
app.post('/api/upload', upload.single('video'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No video file provided' });

  const rawPath = req.file.path;
  const id = uuidv4();
  const videoDir = path.join(UPLOADS_DIR, id);

  try {
    const duration = await getVideoDuration(rawPath);
    if (duration > MAX_DURATION_SECONDS) {
      fs.unlinkSync(rawPath);
      return res.status(400).json({
        error: `Video too long. Maximum is ${MAX_DURATION_SECONDS} seconds (yours is ${Math.round(duration)}s).`
      });
    }

    fs.mkdirSync(videoDir, { recursive: true });
    const frameCount = await extractFrames(rawPath, videoDir, FRAMES_PER_SECOND, FRAME_WIDTH, FRAME_HEIGHT);

    if (frameCount === 0) {
      fs.unlinkSync(rawPath);
      fs.rmSync(videoDir, { recursive: true, force: true });
      return res.status(500).json({ error: 'Failed to extract frames from video.' });
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
    res.status(500).json({ error: 'Upload processing failed: ' + err.message });
  }
});

// ─── GET /api/videos ──────────────────────────────────────────────────────────
app.get('/api/videos', (req, res) => {
  const enriched = videos.map(v => ({
    ...v,
    thumbnailUrl: `/api/thumb/${v.id}`,
    frameUrl: `/api/frame/${v.id}/0`,
  }));
  res.json(enriched);
});

// ─── GET /api/thumb/:id ───────────────────────────────────────────────────────
app.get('/api/thumb/:id', (req, res) => {
  const framePath = path.join(UPLOADS_DIR, req.params.id, 'frame_0001.jpg');
  if (!fs.existsSync(framePath)) return res.status(404).send('Not found');
  res.set('Cache-Control', 'public, max-age=86400');
  res.sendFile(framePath);
});

// ─── GET /api/frame/current ───────────────────────────────────────────────────
// IMPORTANT: This must be defined BEFORE /api/frame/:id/:frameIdx
// to prevent Express matching "current" as the :id param
app.get('/api/frame/current', (req, res) => {
  if (videos.length === 0) return res.status(404).send('No videos');

  if (ephone_session.videoIdx >= videos.length) ephone_session.videoIdx = 0;

  const vid = videos[ephone_session.videoIdx];
  if (ephone_session.frameIdx >= vid.frameCount) ephone_session.frameIdx = 0;

  const idx = ephone_session.frameIdx + 1; // ffmpeg frames are 1-indexed
  const frameFile = `frame_${String(idx).padStart(4, '0')}.jpg`;
  const framePath = path.join(UPLOADS_DIR, vid.id, frameFile);

  // Auto-advance frame for next poll
  advanceFrame();

  // Increment view count on first frame
  if (ephone_session.frameIdx === 0) {
    vid.views = (vid.views || 0) + 1;
    saveVideos();
  }

  if (!fs.existsSync(framePath)) return res.status(404).send('Frame not found');
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(framePath);
});

// ─── GET /api/frame/:id/:frameIdx ────────────────────────────────────────────
app.get('/api/frame/:id/:frameIdx', (req, res) => {
  const frameNum = parseInt(req.params.frameIdx, 10);
  if (isNaN(frameNum) || frameNum < 0) return res.status(400).send('Invalid frame index');

  const idx = frameNum + 1; // ffmpeg frames are 1-indexed
  const frameFile = `frame_${String(idx).padStart(4, '0')}.jpg`;
  const framePath = path.join(UPLOADS_DIR, req.params.id, frameFile);
  if (!fs.existsSync(framePath)) return res.status(404).send('Not found');
  res.set('Cache-Control', 'public, max-age=3600');
  res.sendFile(framePath);
});

// ─── POST /api/next ───────────────────────────────────────────────────────────
app.post('/api/next', (req, res) => {
  if (videos.length === 0) return res.json({ ok: true });
  ephone_session.videoIdx = (ephone_session.videoIdx + 1) % videos.length;
  ephone_session.frameIdx = 0;
  const vid = videos[ephone_session.videoIdx];
  res.json({ ok: true, videoIdx: ephone_session.videoIdx, title: vid?.title });
});

// ─── POST /api/like/:id ───────────────────────────────────────────────────────
app.post('/api/like/:id', (req, res) => {
  const vid = videos.find(v => v.id === req.params.id);
  if (!vid) return res.status(404).json({ error: 'Not found' });
  vid.likes = (vid.likes || 0) + 1;
  saveVideos();
  res.json({ likes: vid.likes });
});

// ─── GET /api/video/:id ───────────────────────────────────────────────────────
app.get('/api/video/:id', (req, res) => {
  const vid = videos.find(v => v.id === req.params.id);
  if (!vid) return res.status(404).send('Not found');
  const videoPath = path.join(UPLOADS_DIR, vid.id, vid.videoFile);
  if (!fs.existsSync(videoPath)) return res.status(404).send('Video file not found');
  res.sendFile(videoPath);
});

// ─── Catch-all: serve index.html for any unmatched GET ───────────────────────
app.get('*', (req, res) => {
  const indexPath = path.join(PUBLIC_DIR, 'index.html');
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.status(404).send('index.html not found. Make sure frontend files are in the public/ directory.');
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🎬 ePhone Clips Server running on port ${PORT}`);
  console.log(`   Max video length: ${MAX_DURATION_SECONDS}s`);
  console.log(`   Frame resolution: ${FRAME_WIDTH}x${FRAME_HEIGHT} @ ${FRAMES_PER_SECOND}fps`);
  console.log(`   Videos loaded: ${videos.length}`);
  console.log(`   Public dir: ${PUBLIC_DIR}`);
});
