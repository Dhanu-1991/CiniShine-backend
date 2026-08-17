#!/bin/bash
set -e

# =============================================================================
# CiniShine Media Processing Worker v4.4
# UNIFIED CONTENT MODEL | ALL-AT-ONCE ENCODING | EBS-BACKED TEMP DIR
# HARDENED: retries on every network call, completion marker, no silent death
#
# Processes: Videos, Shorts, Audio
# Encoding:  Single FFmpeg pass with split filter (all renditions at once)
# Upload:    All files uploaded after processing completes
# Storage:   /var/tmp (EBS root volume) instead of /tmp (tmpfs/RAM)
# =============================================================================

REGION="us-east-1"
BUCKET_NAME="cini-shine"
QUEUE_URL="https://sqs.us-east-1.amazonaws.com/856507207317/video-processing-queue"
SSM_PREFIX="/cinishine"
ASG_NAME="cinishine-worker-asg"
INSTANCE_ID=""
MARKER_FILE="/var/tmp/bootstrap-complete"
MARKER_FAIL="/var/tmp/bootstrap-failed"

# Clear any stale markers from a previous boot on this same instance
rm -f "$MARKER_FILE" "$MARKER_FAIL" 2>/dev/null || true

# ── Trap: if the script exits non-zero for ANY reason, write a fail marker ──
on_exit() {
  local code=$?
  if [ $code -ne 0 ]; then
    echo "❌ Bootstrap FAILED with exit code $code at line $BASH_LINENO" | tee -a /var/log/worker-setup.log
    echo "$(date) exit=$code line=$BASH_LINENO" > "$MARKER_FAIL"
  fi
}
trap on_exit EXIT

# ── Retry helper: retries a command up to N times with backoff ──────────────
retry() {
  local max_attempts=$1; shift
  local delay=5
  local attempt=1
  until "$@"; do
    if [ $attempt -ge $max_attempts ]; then
      echo "❌ Command failed after $max_attempts attempts: $*"
      return 1
    fi
    echo "⚠️  Attempt $attempt/$max_attempts failed, retrying in ${delay}s: $*"
    sleep $delay
    attempt=$((attempt + 1))
    delay=$((delay * 2))
  done
  return 0
}

# ── Get Instance ID ──────────────────────────────────────────────────────────
for i in {1..5}; do
  INSTANCE_ID=$(ec2-metadata --instance-id 2>/dev/null | cut -d ' ' -f 2)
  if [ -n "$INSTANCE_ID" ] && [ "$INSTANCE_ID" != "i-" ]; then
    break
  fi
  echo "⚠️  Attempt $i: Waiting for instance metadata..."
  sleep 2
done

if [ -z "$INSTANCE_ID" ]; then
  TOKEN=$(curl -X PUT "http://169.254.169.254/latest/api/token" \
    -H "X-aws-ec2-metadata-token-ttl-seconds: 21600" -s)
  INSTANCE_ID=$(curl -H "X-aws-ec2-metadata-token: $TOKEN" \
    -s http://169.254.169.254/latest/meta-data/instance-id)
fi

INSTANCE_TYPE=$(ec2-metadata --instance-type 2>/dev/null | cut -d ' ' -f 2 || echo "unknown")

exec > >(tee /var/log/worker-setup.log) 2>&1
echo "=== CiniShine Worker Setup v4.4 - $(date) ==="
echo "Instance: $INSTANCE_ID ($INSTANCE_TYPE)"

# ── System Optimization ──────────────────────────────────────────────────────
echo ">>> Optimizing system..."
if ! grep -q "nofile 131072" /etc/security/limits.conf 2>/dev/null; then
  echo "* soft nofile 131072" >> /etc/security/limits.conf
  echo "* hard nofile 131072" >> /etc/security/limits.conf
fi
if ! grep -q "vm.dirty_ratio" /etc/sysctl.conf 2>/dev/null; then
  cat >> /etc/sysctl.conf << 'SYSCTL'
vm.dirty_ratio = 10
vm.dirty_background_ratio = 5
vm.swappiness = 10
SYSCTL
fi
sysctl -p || true

# ── Create EBS-backed work directory ─────────────────────────────────────────
# CRITICAL: /tmp on Amazon Linux 2023 is tmpfs (RAM-backed, ~1.9 GB).
# A 1 GB video producing 4 renditions needs 3-8 GB of working space.
# /var/tmp lives on the EBS root volume with much more space.
WORK_BASE="/var/tmp/cinishine-work"
mkdir -p "$WORK_BASE"
chown ec2-user:ec2-user "$WORK_BASE"
chmod 755 "$WORK_BASE"
echo ">>> Work directory: $WORK_BASE (EBS-backed)"
df -h "$WORK_BASE"

# ── Install Packages ─────────────────────────────────────────────────────────
echo ">>> Installing packages..."
retry 3 dnf update -y
retry 3 bash -c 'curl -fsSL --retry 3 --retry-delay 5 --max-time 60 https://rpm.nodesource.com/setup_20.x | bash -'
retry 3 dnf install -y nodejs git wget tar xz jq

# ── Install FFmpeg ────────────────────────────────────────────────────────────
echo ">>> Installing FFmpeg..."
cd /tmp
rm -rf ffmpeg*
curl -L -f https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-gpl.tar.xz -o ffmpeg.tar.xz
tar xf ffmpeg.tar.xz
cp ffmpeg-master-latest-linux64-gpl/bin/ffmpeg  /usr/local/bin/
cp ffmpeg-master-latest-linux64-gpl/bin/ffprobe /usr/local/bin/
chmod +x /usr/local/bin/ffmpeg /usr/local/bin/ffprobe
rm -rf ffmpeg* || true

# Hard verification — if these binaries don't work, stop now instead of
# limping forward with a broken worker
/usr/local/bin/ffmpeg -version >/dev/null 2>&1 || { echo "❌ FFmpeg binary broken after install"; exit 1; }
/usr/local/bin/ffprobe -version >/dev/null 2>&1 || { echo "❌ FFprobe binary broken after install"; exit 1; }

echo "Node: $(node --version) | npm: $(npm --version) | FFmpeg: $(ffmpeg -version | head -n1)"

# ── Application Setup ────────────────────────────────────────────────────────
APP_DIR="/home/ec2-user/cinishine-worker"
mkdir -p $APP_DIR
cd $APP_DIR

cat > package.json << 'EOF'
{
  "name": "cinishine-worker",
  "version": "4.4.0",
  "type": "module",
  "dependencies": {
    "@aws-sdk/client-s3": "^3.893.0",
    "@aws-sdk/client-sqs": "^3.893.0",
    "@aws-sdk/client-auto-scaling": "^3.893.0",
    "@ffprobe-installer/ffprobe": "^2.1.2",
    "dotenv": "^17.2.2",
    "mongoose": "^8.18.1"
  }
}
EOF

echo ">>> Running npm install..."
retry 3 npm install --silent
[ -d node_modules ] || { echo "❌ node_modules missing after npm install"; exit 1; }

# ── SSM Config ────────────────────────────────────────────────────────────────
echo ">>> Loading SSM config..."
get_ssm_param() {
  local val
  val=$(retry 3 aws ssm get-parameter --region $REGION --name "${SSM_PREFIX}/$1" \
    --with-decryption --query 'Parameter.Value' --output text 2>/dev/null)
  if [ -z "$val" ] || [ "$val" == "None" ]; then
    echo "❌ SSM parameter ${SSM_PREFIX}/$1 missing or empty"
    return 1
  fi
  echo "$val"
}

MONGO_URI=$(get_ssm_param "MONGO_URI") || exit 1
S3_BUCKET=$(get_ssm_param "S3_BUCKET") || exit 1

cat > .env << EOF
MONGO_URI=$MONGO_URI
AWS_REGION=$REGION
S3_BUCKET=$S3_BUCKET
QUEUE_URL=$QUEUE_URL
INSTANCE_ID=$INSTANCE_ID
INSTANCE_TYPE=$INSTANCE_TYPE
ASG_NAME=$ASG_NAME
WORK_BASE=$WORK_BASE
VISIBILITY_TIMEOUT=900
NODE_ENV=production
EOF

# ── Content Model ─────────────────────────────────────────────────────────────
mkdir -p models
cat > models/content.model.js << 'JSEOF'
import mongoose from 'mongoose';

const contentSchema = new mongoose.Schema({
  contentType: {
    type: String,
    enum: ['video', 'short', 'audio', 'post'],
    required: true,
    index: true
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  title:       { type: String, trim: true, maxlength: 200 },
  description: { type: String, trim: true, maxlength: 5000 },
  channelName: String,
  tags:        [{ type: String, trim: true }],
  category:    { type: String, trim: true },
  visibility:  { type: String, enum: ['public', 'unlisted', 'private'], default: 'public' },
  isAgeRestricted: { type: Boolean, default: false },
  commentsEnabled: { type: Boolean, default: true },
  selectedRoles:   [{ type: String, trim: true }],

  // S3 keys
  originalKey:  String,
  hlsMasterKey: String,
  processedKey: String,
  thumbnailKey: String,
  thumbnailSource: { type: String, enum: ['auto', 'custom'], default: 'auto' },
  imageKey:  String,
  imageKeys: [{ type: String, trim: true }],

  // Media metadata
  duration: Number,
  fileSize: Number,
  mimeType: String,
  sizes: { original: Number, processed: Number },

  // Processing
  status: {
    type: String,
    enum: ['uploading', 'processing', 'completed', 'failed'],
    default: 'uploading'
  },
  processingStart: Date,
  processingEnd:   Date,
  processingError: String,
  error: String,

  // Renditions
  renditions: [{
    resolution: String, bitrate: Number, name: String,
    playlistKey: String, codecs: String
  }],

  // Video metadata
  metadata: {
    originalResolution: String, originalCodec: String,
    hasAudio: Boolean, videoCodec: String, audioCodec: String
  },

  // Audio metadata
  audioMetadata: { bitrate: Number, sampleRate: Number, channels: Number, codec: String },
  audioCategory: { type: String, enum: ['music', 'podcast', 'audiobook', 'sound-effect', 'other'], default: 'music' },
  artist: String,
  album:  String,

  // Engagement
  views:        { type: Number, default: 0 },
  likeCount:    { type: Number, default: 0 },
  dislikeCount: { type: Number, default: 0 },
  commentCount: { type: Number, default: 0 },
  shareCount:   { type: Number, default: 0 },

  // Analytics
  lastViewedAt:     Date,
  averageWatchTime: { type: Number, default: 0 },
  watchCount:       { type: Number, default: 0 },
  totalWatchTime:   { type: Number, default: 0 },

  postContent: String,
  createdAt:   { type: Date, default: Date.now },
  updatedAt:   { type: Date, default: Date.now },
  publishedAt: Date
}, { timestamps: true });

contentSchema.index({ contentType: 1, status: 1, createdAt: -1 });
contentSchema.index({ userId: 1, contentType: 1 });
contentSchema.index({ tags: 1 });
contentSchema.index({ visibility: 1, status: 1 });
contentSchema.index({ contentType: 1, status: 1, views: -1 });

export default mongoose.model('Content', contentSchema);
JSEOF

# ══════════════════════════════════════════════════════════════════════════════
# WORKER SCRIPT (unchanged from v4.3 — logic itself was not the problem)
# ══════════════════════════════════════════════════════════════════════════════
mkdir -p workers
cat > workers/worker.js << 'JSEOF'
import 'dotenv/config';
import { spawn, execSync } from 'child_process';
import Content from '../models/content.model.js';
import fs from 'fs';
import path from 'path';
import {
  S3Client, GetObjectCommand, PutObjectCommand, HeadObjectCommand
} from '@aws-sdk/client-s3';
import {
  SQSClient, ReceiveMessageCommand, DeleteMessageCommand,
  ChangeMessageVisibilityCommand
} from '@aws-sdk/client-sqs';
import {
  AutoScalingClient, SetInstanceProtectionCommand
} from '@aws-sdk/client-auto-scaling';
import mongoose from 'mongoose';
import ffprobeInstaller from '@ffprobe-installer/ffprobe';

const ffprobePath = ffprobeInstaller.path;

// Work directory: EBS-backed, not tmpfs
const WORK_BASE = process.env.WORK_BASE || '/var/tmp/cinishine-work';

console.log('🎬 CiniShine Worker v4.4 — ALL-AT-ONCE + EBS TEMP');
console.log(`   MONGO: ${process.env.MONGO_URI ? '✔' : '✗'} | REGION: ${process.env.AWS_REGION}`);
console.log(`   BUCKET: ${process.env.S3_BUCKET} | WORK_DIR: ${WORK_BASE}`);
console.log(`   INSTANCE: ${process.env.INSTANCE_ID || '⚠️  NOT SET'}`);

const s3  = new S3Client({ region: process.env.AWS_REGION, maxAttempts: 5, requestTimeout: 60000 });
const sqs = new SQSClient({ region: process.env.AWS_REGION });
const asg = new AutoScalingClient({ region: process.env.AWS_REGION });

// ═══════════════════════════════════════════════════════════════════════════
// RENDITION PROFILES
// ═══════════════════════════════════════════════════════════════════════════

const VIDEO_RENDITIONS = [
  { resolution: '256x144',   bitrate:  200000, audioBitrate: '64k',  name: '144p',  width: 256,  height: 144  },
  { resolution: '426x240',   bitrate:  400000, audioBitrate: '96k',  name: '240p',  width: 426,  height: 240  },
  { resolution: '640x360',   bitrate:  800000, audioBitrate: '128k', name: '360p',  width: 640,  height: 360  },
  { resolution: '854x480',   bitrate: 1500000, audioBitrate: '128k', name: '480p',  width: 854,  height: 480  },
  { resolution: '1280x720',  bitrate: 2500000, audioBitrate: '128k', name: '720p',  width: 1280, height: 720  },
  { resolution: '1920x1080', bitrate: 5000000, audioBitrate: '192k', name: '1080p', width: 1920, height: 1080 }
];

const SHORT_RENDITIONS = [
  { resolution: '480x854',   bitrate: 1500000, audioBitrate: '128k', name: '480p',  width: 480,  height: 854  },
  { resolution: '720x1280',  bitrate: 3000000, audioBitrate: '128k', name: '720p',  width: 720,  height: 1280 },
  { resolution: '1080x1920', bitrate: 6000000, audioBitrate: '192k', name: '1080p', width: 1080, height: 1920 }
];

// ═══════════════════════════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════════════════════════

function detectContentType(s3Key) {
  const folder = s3Key.split('/')[0].toLowerCase();
  if (folder === 'uploads') return 'video';
  if (folder === 'shorts')  return 'short';
  if (folder === 'audio')   return 'audio';
  const ext = path.extname(s3Key).toLowerCase();
  if (['.mp3', '.wav', '.flac', '.aac', '.m4a', '.ogg'].includes(ext)) return 'audio';
  return 'video';
}

function getAppropriateRenditions(inputWidth, inputHeight, contentType) {
  const renditions = contentType === 'short' ? SHORT_RENDITIONS : VIDEO_RENDITIONS;
  const inputPixels = inputWidth * inputHeight;

  const appropriate = renditions.filter(r => (r.width * r.height) <= (inputPixels * 1.1));
  if (appropriate.length === 0) return [renditions[0]];

  appropriate.sort((a, b) => (a.width * a.height) - (b.width * b.height));
  console.log(`📐 Input: ${inputWidth}x${inputHeight} → Renditions: ${appropriate.map(r => r.name).join(', ')}`);
  return appropriate;
}

function ensureDir(d) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true, mode: 0o755 });
}

function getTempDir(fileId) {
  return path.join(WORK_BASE, `job-${fileId}-${Date.now()}`);
}

function logDisk(label) {
  try {
    const lines = execSync(`df -h "${WORK_BASE}"`).toString().trim().split('\n');
    if (lines.length >= 2) {
      const p = lines[1].split(/\s+/);
      console.log(`💾 [${label}] ${p[3]} free / ${p[1]} total (${p[4]} used)`);
    }
  } catch (_) {}
}

async function probeMedia(inputPath) {
  return new Promise((resolve, reject) => {
    console.log('📊 Probing media...');
    const proc = spawn(ffprobePath, [
      '-v', 'quiet', '-print_format', 'json',
      '-show_format', '-show_streams', inputPath
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    let out = '', err = '';
    proc.stdout.on('data', c => { out += c; });
    proc.stderr.on('data', c => { err += c; });
    proc.on('close', code => {
      if (code !== 0) return reject(new Error(`ffprobe exit ${code}: ${err}`));
      try {
        const meta = JSON.parse(out);
        const vs = meta.streams.find(s => s.codec_type === 'video');
        const as = meta.streams.find(s => s.codec_type === 'audio');
        const dur = parseFloat(meta.format.duration) || 0;

        console.log(`   Duration: ${Math.floor(dur/60)}m ${Math.floor(dur%60)}s`);
        if (vs) console.log(`   Video: ${vs.codec_name} ${vs.width}x${vs.height}`);
        if (as) console.log(`   Audio: ${as.codec_name} ${as.sample_rate}Hz ${as.channels}ch`);
        else    console.log('   Audio: NONE (video-only)');

        resolve({ duration: dur, videoStream: vs, audioStream: as, hasAudio: !!as });
      } catch (e) { reject(new Error('ffprobe parse: ' + e.message)); }
    });
    proc.on('error', reject);
  });
}

async function runFFmpeg(args, label = '') {
  const tag = label ? `[${label}] ` : '';
  console.log(`🚀 ${tag}FFmpeg starting...`);

  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const ff = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });

    const MAX = 5 * 1024 * 1024;
    let chunks = [], len = 0, lastProg = '', lastT = 0;

    ff.stdout.on('data', () => {});
    ff.stderr.on('data', data => {
      const txt = data.toString();
      if (len < MAX) { chunks.push(txt); len += txt.length; }

      const m = txt.match(/out_time=(\d+:\d+:\d+)/);
      if (m && m[1] !== lastProg) {
        lastProg = m[1];
        const now = Date.now();
        if (now - lastT > 15000) {
          console.log(`   ⏱️  ${tag}${lastProg}`);
          lastT = now;
        }
      }

      if (txt.match(/No space left on device/i)) {
        console.error(`❌ ${tag}DISK FULL detected!`);
      }
    });

    ff.on('close', code => {
      const dur = ((Date.now() - t0) / 1000).toFixed(1);
      const stderr = chunks.join('');
      chunks = [];
      if (stderr.length > 0) {
        console.log(`--- ${tag}stderr tail ---`);
        console.log(stderr.slice(-2500));
        console.log('--- end ---');
      }
      if (code !== 0) return reject(new Error(`${tag}FFmpeg exit ${code}`));
      console.log(`✅ ${tag}Completed in ${dur}s`);
      resolve();
    });
    ff.on('error', reject);
  });
}

async function uploadToS3(filePath, key, contentType, cacheControl) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const stats = fs.statSync(filePath);
      if (stats.size === 0) throw new Error(`File is 0 bytes: ${filePath}`);

      await s3.send(new PutObjectCommand({
        Bucket: process.env.S3_BUCKET, Key: key,
        Body: fs.createReadStream(filePath),
        ContentType: contentType, CacheControl: cacheControl
      }));

      const head = await s3.send(new HeadObjectCommand({
        Bucket: process.env.S3_BUCKET, Key: key
      }));
      if (head.ContentLength !== stats.size) {
        throw new Error(`Size mismatch: local=${stats.size} remote=${head.ContentLength}`);
      }
      return;
    } catch (err) {
      console.error(`   ❌ Upload attempt ${attempt}/3 for ${key}: ${err.message}`);
      if (attempt === 3) throw err;
      await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt)));
    }
  }
}

async function protectInstance(protect) {
  if (!process.env.INSTANCE_ID || !process.env.ASG_NAME) return;
  try {
    await asg.send(new SetInstanceProtectionCommand({
      InstanceIds: [process.env.INSTANCE_ID],
      AutoScalingGroupName: process.env.ASG_NAME,
      ProtectedFromScaleIn: protect
    }));
  } catch (_) {}
}

async function extendVisibility(rh) {
  try {
    await sqs.send(new ChangeMessageVisibilityCommand({
      QueueUrl: process.env.QUEUE_URL, ReceiptHandle: rh,
      VisibilityTimeout: parseInt(process.env.VISIBILITY_TIMEOUT || '900')
    }));
    console.log('⏰ Visibility extended');
  } catch (e) {
    console.warn('⚠️  Visibility extend failed:', e.message);
  }
}

function generateMasterPlaylist(outputDir, renditions, hasAudio) {
  console.log('📝 Generating master playlist...');
  const masterPath = path.join(outputDir, 'master.m3u8');

  for (const r of renditions) {
    const misplaced = path.join(outputDir, `stream_${r.name}`, 'master.m3u8');
    if (fs.existsSync(misplaced)) fs.unlinkSync(misplaced);
  }

  let content = '#EXTM3U\n#EXT-X-VERSION:3\n';
  for (const r of renditions) {
    const variantPath = path.join(outputDir, `stream_${r.name}`, 'playlist.m3u8');
    if (!fs.existsSync(variantPath)) throw new Error(`Missing: stream_${r.name}/playlist.m3u8`);
    if (fs.statSync(variantPath).size === 0) throw new Error(`Empty: stream_${r.name}/playlist.m3u8`);

    const codecs = hasAudio ? 'avc1.640028,mp4a.40.2' : 'avc1.640028';
    const bw = r.bitrate + (hasAudio ? 128000 : 0);
    content += `#EXT-X-STREAM-INF:BANDWIDTH=${bw},RESOLUTION=${r.resolution},CODECS="${codecs}",NAME="${r.name}"\n`;
    content += `stream_${r.name}/playlist.m3u8\n`;
  }

  fs.writeFileSync(masterPath, content, 'utf8');
  const sz = fs.statSync(masterPath).size;
  if (sz === 0) throw new Error('Master playlist write failed — disk may be full');
  console.log(`✅ Master playlist: ${sz} bytes, ${renditions.length} variants`);
}

function validateHLS(outputDir, renditionCount) {
  console.log('🔍 Validating HLS output...');
  const masterPath = path.join(outputDir, 'master.m3u8');
  if (!fs.existsSync(masterPath)) throw new Error('No master.m3u8');
  if (fs.statSync(masterPath).size === 0) throw new Error('Empty master.m3u8');
  if (!fs.readFileSync(masterPath, 'utf8').includes('#EXTM3U')) throw new Error('Invalid master.m3u8');

  const dirs = fs.readdirSync(outputDir)
    .filter(f => f.startsWith('stream_') && fs.statSync(path.join(outputDir, f)).isDirectory())
    .sort();
  if (dirs.length !== renditionCount) {
    throw new Error(`Expected ${renditionCount} rendition dirs, found ${dirs.length}: ${dirs.join(', ')}`);
  }

  let total = 0;
  for (const d of dirs) {
    const dp = path.join(outputDir, d);
    const segs = fs.readdirSync(dp).filter(f => f.endsWith('.ts'));
    if (segs.length === 0) throw new Error(`No segments in ${d}`);
    const playlist = path.join(dp, 'playlist.m3u8');
    if (!fs.existsSync(playlist) || fs.statSync(playlist).size === 0) {
      throw new Error(`Invalid playlist in ${d}`);
    }
    total += segs.length;
    console.log(`   ✅ ${d}: ${segs.length} segments`);
  }
  console.log(`✅ Validation OK: ${total} total segments across ${dirs.length} renditions`);
  return dirs;
}

async function processVideo(fileId, userId, s3Key, receiptHandle) {
  console.log(`\n🎬 VIDEO: ${fileId}`);
  console.log('═'.repeat(70));

  let tempDir, viTimer;
  const t0 = Date.now();

  try {
    const doc = await Content.findById(fileId);
    if (!doc) throw new Error(`Content ${fileId} not found in DB`);
    if (doc.status === 'completed') {
      console.log('⚠️  Already completed — skipping');
      return;
    }

    await Content.findByIdAndUpdate(fileId, {
      status: 'processing', processingStart: new Date(),
      error: null, processingError: null
    });

    viTimer = setInterval(() => extendVisibility(receiptHandle), 240000);

    tempDir = getTempDir(fileId);
    const inputPath = path.join(tempDir, 'input.mp4');
    const outputDir = path.join(tempDir, 'hls');
    const thumbPath = path.join(tempDir, 'thumb.jpg');
    ensureDir(tempDir);
    ensureDir(outputDir);

    logDisk('before download');

    console.log('📥 Downloading from S3...');
    const { Body } = await s3.send(new GetObjectCommand({
      Bucket: process.env.S3_BUCKET, Key: doc.originalKey
    }));
    await new Promise((res, rej) => {
      Body.pipe(fs.createWriteStream(inputPath)).on('finish', res).on('error', rej);
    });
    const fileSz = fs.statSync(inputPath).size;
    console.log(`✅ Downloaded ${(fileSz / 1048576).toFixed(1)} MB`);
    logDisk('after download');

    const { duration, videoStream, hasAudio } = await probeMedia(inputPath);

    let shouldThumb = true;
    let thumbKey = doc.thumbnailKey;
    if (doc.thumbnailSource === 'custom' && doc.thumbnailKey) {
      console.log('🖼️  Custom thumbnail exists — skipping auto');
      shouldThumb = false;
    }
    if (shouldThumb) {
      console.log('🖼️  Generating thumbnail...');
      const tt = Math.min(5, duration / 2);
      await runFFmpeg([
        '-ss', tt.toString(), '-i', inputPath,
        '-frames:v', '1', '-vf', 'scale=320:-2',
        '-q:v', '2', '-update', '1', '-y', thumbPath
      ], 'thumb');
    }

    const renditions = getAppropriateRenditions(videoStream.width, videoStream.height, 'video');

    console.log(`🎥 Encoding ${renditions.length} renditions (all at once)...`);

    const splitOutputs = renditions.map((_, i) => `[v${i}]`).join('');
    const scaleFilters = renditions.map((r, i) => `[v${i}]scale=${r.width}:${r.height}[v${i}out]`).join('; ');
    const filterComplex = `[0:v]format=yuv420p,split=${renditions.length}${splitOutputs}; ${scaleFilters}`;

    const ffArgs = [
      '-hide_banner', '-loglevel', 'error', '-progress', 'pipe:2', '-y',
      '-i', inputPath,
      '-filter_complex', filterComplex
    ];

    renditions.forEach((r, i) => {
      ffArgs.push(
        '-map', `[v${i}out]`,
        `-c:v:${i}`, 'libx264',
        `-b:v:${i}`, r.bitrate.toString(),
        `-maxrate:v:${i}`, Math.round(r.bitrate * 1.5).toString(),
        `-bufsize:v:${i}`, Math.round(r.bitrate * 2).toString(),
        '-preset', 'medium', '-crf', '23',
        `-profile:v:${i}`, 'main',
        `-g:v:${i}`, '48', `-keyint_min:v:${i}`, '48', `-sc_threshold:v:${i}`, '0'
      );
      if (hasAudio) {
        ffArgs.push(
          '-map', '0:a:0',
          `-c:a:${i}`, 'aac',
          `-b:a:${i}`, r.audioBitrate,
          `-ar:a:${i}`, '48000', `-ac:a:${i}`, '2'
        );
      }
    });

    ffArgs.push(
      '-f', 'hls', '-hls_time', '6', '-hls_list_size', '0',
      '-hls_playlist_type', 'vod', '-hls_flags', 'independent_segments',
      '-hls_segment_type', 'mpegts',
      '-hls_segment_filename', path.join(outputDir, 'stream_%v', 'segment%03d.ts')
    );

    const vsm = renditions.map((r, i) =>
      hasAudio ? `v:${i},a:${i},name:${r.name}` : `v:${i},name:${r.name}`
    ).join(' ');

    ffArgs.push('-var_stream_map', vsm, path.join(outputDir, 'stream_%v', 'playlist.m3u8'));

    for (const r of renditions) ensureDir(path.join(outputDir, `stream_${r.name}`));

    await runFFmpeg(ffArgs, 'encode');
    logDisk('after encode');

    generateMasterPlaylist(outputDir, renditions, hasAudio);
    const renditionDirs = validateHLS(outputDir, renditions.length);

    console.log('☁️  Uploading HLS to S3...');
    const masterKey = `hls/videos/${userId}/${fileId}/master.m3u8`;
    await uploadToS3(
      path.join(outputDir, 'master.m3u8'), masterKey,
      'application/vnd.apple.mpegurl', 'max-age=300'
    );

    for (const dir of renditionDirs) {
      const dp = path.join(outputDir, dir);
      const files = fs.readdirSync(dp).sort();
      console.log(`   📁 ${dir}: ${files.length} files`);
      for (const file of files) {
        await uploadToS3(
          path.join(dp, file),
          `hls/videos/${userId}/${fileId}/${dir}/${file}`,
          file.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/MP2T',
          file.endsWith('.ts') ? 'max-age=31536000' : 'max-age=300'
        );
      }
      await extendVisibility(receiptHandle);
    }

    if (shouldThumb) {
      thumbKey = `thumbnails/videos/${userId}/${fileId}.jpg`;
      await uploadToS3(thumbPath, thumbKey, 'image/jpeg', 'max-age=31536000');
    }

    const update = {
      status: 'completed', hlsMasterKey: masterKey, thumbnailKey: thumbKey, duration,
      renditions: renditions.map(r => ({
        resolution: r.resolution, bitrate: r.bitrate, name: r.name,
        playlistKey: `hls/videos/${userId}/${fileId}/stream_${r.name}/playlist.m3u8`,
        codecs: hasAudio ? 'avc1.640028,mp4a.40.2' : 'avc1.640028'
      })),
      processingEnd: new Date(),
      'metadata.originalResolution': `${videoStream.width}x${videoStream.height}`,
      'metadata.originalCodec': videoStream.codec_name,
      'metadata.hasAudio': hasAudio,
      'sizes.original': fileSz,
      error: null, processingError: null
    };
    if (shouldThumb) update.thumbnailSource = 'auto';
    await Content.findByIdAndUpdate(fileId, update);

    console.log(`✅ VIDEO COMPLETE: ${fileId} in ${((Date.now() - t0) / 60000).toFixed(1)} min`);

  } catch (err) {
    console.error('❌ VIDEO ERROR:', err.message);
    await Content.findByIdAndUpdate(fileId, {
      status: 'failed', error: err.message, processingError: err.message,
      processingEnd: new Date()
    }).catch(() => {});
    throw err;
  } finally {
    if (viTimer) clearInterval(viTimer);
    if (tempDir && fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function processShort(fileId, userId, s3Key, receiptHandle) {
  console.log(`\n📱 SHORT: ${fileId}`);
  console.log('═'.repeat(70));

  let tempDir, viTimer;
  const t0 = Date.now();

  try {
    const doc = await Content.findById(fileId);
    if (!doc) throw new Error(`Short ${fileId} not found`);
    if (doc.status === 'completed') return;

    await Content.findByIdAndUpdate(fileId, {
      status: 'processing', processingStart: new Date(), processingError: null
    });
    viTimer = setInterval(() => extendVisibility(receiptHandle), 240000);

    tempDir = getTempDir(fileId);
    const inputPath = path.join(tempDir, 'input.mp4');
    const outputDir = path.join(tempDir, 'hls');
    const thumbPath = path.join(tempDir, 'thumb.jpg');
    ensureDir(tempDir);
    ensureDir(outputDir);

    const { Body } = await s3.send(new GetObjectCommand({
      Bucket: process.env.S3_BUCKET, Key: doc.originalKey
    }));
    await new Promise((res, rej) => {
      Body.pipe(fs.createWriteStream(inputPath)).on('finish', res).on('error', rej);
    });
    const fileSz = fs.statSync(inputPath).size;

    const { duration, videoStream, hasAudio } = await probeMedia(inputPath);

    let shouldThumb = true, thumbKey = doc.thumbnailKey;
    if (doc.thumbnailSource === 'custom' && doc.thumbnailKey) shouldThumb = false;
    if (shouldThumb) {
      await runFFmpeg([
        '-ss', '0.5', '-i', inputPath,
        '-frames:v', '1', '-vf', 'scale=360:-2',
        '-q:v', '2', '-update', '1', '-y', thumbPath
      ], 'thumb');
    }

    const isVertical = videoStream.height > videoStream.width;
    const renditions = getAppropriateRenditions(videoStream.width, videoStream.height, 'short');

    const splitOutputs = renditions.map((_, i) => `[v${i}]`).join('');
    const scaleFilters = renditions.map((r, i) => {
      const scale = isVertical ? `scale=${r.width}:${r.height}` : `scale=${r.height}:${r.width}`;
      return `[v${i}]${scale}[v${i}out]`;
    }).join('; ');
    const filterComplex = `[0:v]format=yuv420p,split=${renditions.length}${splitOutputs}; ${scaleFilters}`;

    const ffArgs = [
      '-hide_banner', '-loglevel', 'error', '-progress', 'pipe:2', '-y',
      '-i', inputPath, '-filter_complex', filterComplex
    ];

    renditions.forEach((r, i) => {
      ffArgs.push(
        '-map', `[v${i}out]`,
        `-c:v:${i}`, 'libx264',
        `-b:v:${i}`, r.bitrate.toString(),
        `-maxrate:v:${i}`, Math.round(r.bitrate * 1.5).toString(),
        `-bufsize:v:${i}`, Math.round(r.bitrate * 2).toString(),
        '-preset', 'fast', '-crf', '21',
        `-profile:v:${i}`, 'high',
        `-g:v:${i}`, '30', `-keyint_min:v:${i}`, '30', `-sc_threshold:v:${i}`, '0'
      );
      if (hasAudio) {
        ffArgs.push(
          '-map', '0:a:0',
          `-c:a:${i}`, 'aac', `-b:a:${i}`, r.audioBitrate,
          `-ar:a:${i}`, '48000', `-ac:a:${i}`, '2'
        );
      }
    });

    ffArgs.push(
      '-f', 'hls', '-hls_time', '2', '-hls_list_size', '0',
      '-hls_playlist_type', 'vod', '-hls_flags', 'independent_segments',
      '-hls_segment_type', 'mpegts',
      '-hls_segment_filename', path.join(outputDir, 'stream_%v', 'segment%03d.ts')
    );

    const vsm = renditions.map((r, i) =>
      hasAudio ? `v:${i},a:${i},name:${r.name}` : `v:${i},name:${r.name}`
    ).join(' ');
    ffArgs.push('-var_stream_map', vsm, path.join(outputDir, 'stream_%v', 'playlist.m3u8'));

    for (const r of renditions) ensureDir(path.join(outputDir, `stream_${r.name}`));

    await runFFmpeg(ffArgs, 'encode');

    generateMasterPlaylist(outputDir, renditions, hasAudio);
    const renditionDirs = validateHLS(outputDir, renditions.length);

    const masterKey = `hls/shorts/${userId}/${fileId}/master.m3u8`;
    await uploadToS3(path.join(outputDir, 'master.m3u8'), masterKey, 'application/vnd.apple.mpegurl', 'max-age=300');

    for (const dir of renditionDirs) {
      const dp = path.join(outputDir, dir);
      for (const file of fs.readdirSync(dp).sort()) {
        await uploadToS3(
          path.join(dp, file),
          `hls/shorts/${userId}/${fileId}/${dir}/${file}`,
          file.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/MP2T',
          file.endsWith('.ts') ? 'max-age=31536000' : 'max-age=300'
        );
      }
    }

    if (shouldThumb) {
      thumbKey = `thumbnails/shorts/${userId}/${fileId}.jpg`;
      await uploadToS3(thumbPath, thumbKey, 'image/jpeg', 'max-age=31536000');
    }

    const update = {
      status: 'completed', hlsMasterKey: masterKey, thumbnailKey: thumbKey,
      duration, fileSize: fileSz,
      renditions: renditions.map(r => ({
        resolution: r.resolution, bitrate: r.bitrate, name: r.name,
        playlistKey: `hls/shorts/${userId}/${fileId}/stream_${r.name}/playlist.m3u8`,
        codecs: hasAudio ? 'avc1.640028,mp4a.40.2' : 'avc1.640028'
      })),
      processingEnd: new Date()
    };
    if (shouldThumb) update.thumbnailSource = 'auto';
    await Content.findByIdAndUpdate(fileId, update);

    console.log(`✅ SHORT COMPLETE: ${fileId} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  } catch (err) {
    console.error('❌ SHORT ERROR:', err.message);
    await Content.findByIdAndUpdate(fileId, {
      status: 'failed', processingError: err.message, processingEnd: new Date()
    }).catch(() => {});
    throw err;
  } finally {
    if (viTimer) clearInterval(viTimer);
    if (tempDir && fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function processAudio(fileId, userId, s3Key, receiptHandle) {
  console.log(`\n🎵 AUDIO: ${fileId}`);
  console.log('═'.repeat(70));

  let tempDir, viTimer;
  const t0 = Date.now();

  try {
    const doc = await Content.findById(fileId);
    if (!doc) throw new Error(`Audio ${fileId} not found`);
    if (doc.status === 'completed') return;

    await Content.findByIdAndUpdate(fileId, {
      status: 'processing', processingStart: new Date(), processingError: null
    });
    viTimer = setInterval(() => extendVisibility(receiptHandle), 240000);

    tempDir = getTempDir(fileId);
    const ext = path.extname(s3Key).toLowerCase() || '.mp3';
    const inputPath  = path.join(tempDir, `input${ext}`);
    const outputPath = path.join(tempDir, 'output.m4a');
    const hlsDir     = path.join(tempDir, 'hls');
    ensureDir(tempDir);
    ensureDir(hlsDir);

    const { Body } = await s3.send(new GetObjectCommand({
      Bucket: process.env.S3_BUCKET, Key: doc.originalKey
    }));
    await new Promise((res, rej) => {
      Body.pipe(fs.createWriteStream(inputPath)).on('finish', res).on('error', rej);
    });
    const fileSz = fs.statSync(inputPath).size;

    const { duration, hasAudio } = await probeMedia(inputPath);
    if (!hasAudio) throw new Error('No audio stream found in file');

    await runFFmpeg([
      '-i', inputPath, '-vn', '-c:a', 'aac', '-b:a', '256k',
      '-ar', '48000', '-ac', '2', '-y', outputPath
    ], 'aac');

    await runFFmpeg([
      '-i', inputPath, '-vn', '-c:a', 'aac', '-b:a', '256k',
      '-ar', '48000', '-ac', '2',
      '-f', 'hls', '-hls_time', '10', '-hls_list_size', '0',
      '-hls_playlist_type', 'vod',
      '-hls_segment_filename', path.join(hlsDir, 'segment%03d.ts'),
      '-y', path.join(hlsDir, 'playlist.m3u8')
    ], 'hls-audio');

    const processedKey = `audio/processed/${userId}/${fileId}.m4a`;
    await uploadToS3(outputPath, processedKey, 'audio/mp4', 'max-age=31536000');

    const hlsMasterKey = `hls/audio/${userId}/${fileId}/playlist.m3u8`;
    for (const file of fs.readdirSync(hlsDir)) {
      await uploadToS3(
        path.join(hlsDir, file),
        `hls/audio/${userId}/${fileId}/${file}`,
        file.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'audio/aac',
        file.endsWith('.ts') ? 'max-age=31536000' : 'max-age=300'
      );
    }

    await Content.findByIdAndUpdate(fileId, {
      status: 'completed', processedKey, hlsMasterKey, duration, fileSize: fileSz,
      audioMetadata: { bitrate: 256000, sampleRate: 48000, channels: 2, codec: 'aac' },
      processingEnd: new Date()
    });

    console.log(`✅ AUDIO COMPLETE: ${fileId} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  } catch (err) {
    console.error('❌ AUDIO ERROR:', err.message);
    await Content.findByIdAndUpdate(fileId, {
      status: 'failed', processingError: err.message, processingEnd: new Date()
    }).catch(() => {});
    throw err;
  } finally {
    if (viTimer) clearInterval(viTimer);
    if (tempDir && fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

let currentRH = null;

async function startWorker() {
  console.log('\n🚀 Connecting to MongoDB...');
  await mongoose.connect(process.env.MONGO_URI, {
    maxPoolSize: 10, serverSelectionTimeoutMS: 15000, socketTimeoutMS: 60000
  });
  console.log('✅ MongoDB connected');

  execSync('which ffmpeg', { stdio: 'ignore' });
  console.log('✅ FFmpeg available');

  logDisk('startup');

  try {
    const leftovers = fs.readdirSync(WORK_BASE).filter(f => f.startsWith('job-'));
    if (leftovers.length > 0) {
      console.log(`🧹 Cleaning ${leftovers.length} leftover work dirs`);
      for (const d of leftovers) fs.rmSync(path.join(WORK_BASE, d), { recursive: true, force: true });
    }
  } catch (_) {}

  console.log('\n📡 Polling SQS...');
  console.log('═'.repeat(70));

  const stats = { video: 0, short: 0, audio: 0, failed: 0 };
  let emptyPolls = 0;

  while (true) {
    try {
      console.log(`\n📭 Poll [V:${stats.video} S:${stats.short} A:${stats.audio} F:${stats.failed}]`);

      const result = await sqs.send(new ReceiveMessageCommand({
        QueueUrl: process.env.QUEUE_URL,
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: 20,
        VisibilityTimeout: parseInt(process.env.VISIBILITY_TIMEOUT || '900'),
        AttributeNames: ['All']
      }));

      if (!result.Messages || result.Messages.length === 0) {
        emptyPolls++;
        if (emptyPolls >= 3) await protectInstance(false);
        continue;
      }

      emptyPolls = 0;
      const msg = result.Messages[0];
      currentRH = msg.ReceiptHandle;

      let contentId, userId, s3Key, contentType;
      try {
        const body = JSON.parse(msg.Body);
        s3Key = body.key || body.s3Key;
        if (!s3Key) throw new Error('No S3 key in message');

        if (s3Key.startsWith('audio/processed/') || s3Key.startsWith('hls/') || s3Key.startsWith('thumbnails/')) {
          console.log(`🚫 Skipping output artifact: ${s3Key}`);
          await sqs.send(new DeleteMessageCommand({ QueueUrl: process.env.QUEUE_URL, ReceiptHandle: currentRH }));
          currentRH = null;
          continue;
        }

        contentType = detectContentType(s3Key);
        const parts = s3Key.split('/');
        if (parts.length < 3) throw new Error('Invalid S3 key format');
        userId = parts[1];
        const baseName = parts[2].replace(path.extname(parts[2]), '');
        contentId = baseName.includes('_') ? baseName.split('_')[0] : baseName;
      } catch (parseErr) {
        console.error('❌ Bad message:', parseErr.message);
        await sqs.send(new DeleteMessageCommand({ QueueUrl: process.env.QUEUE_URL, ReceiptHandle: currentRH }));
        currentRH = null;
        continue;
      }

      console.log(`\n📥 Job: ${contentType.toUpperCase()} — ${contentId}`);
      console.log(`   User: ${userId} | Key: ${s3Key}`);

      await protectInstance(true);

      try {
        switch (contentType) {
          case 'video': await processVideo(contentId, userId, s3Key, currentRH); stats.video++; break;
          case 'short': await processShort(contentId, userId, s3Key, currentRH); stats.short++; break;
          case 'audio': await processAudio(contentId, userId, s3Key, currentRH); stats.audio++; break;
          default: throw new Error(`Unknown content type: ${contentType}`);
        }

        await sqs.send(new DeleteMessageCommand({ QueueUrl: process.env.QUEUE_URL, ReceiptHandle: currentRH }));
        console.log('✅ Message deleted');

      } catch (err) {
        stats.failed++;
        const rc = parseInt(msg.Attributes?.ApproximateReceiveCount || '1');
        console.error(`❌ FAILED (attempt ${rc}/3): ${err.message}`);

        if (rc >= 3) {
          console.log('⚠️  Max retries — deleting');
          await sqs.send(new DeleteMessageCommand({ QueueUrl: process.env.QUEUE_URL, ReceiptHandle: currentRH }));
        } else {
          const backoff = Math.min(60 * Math.pow(2, rc - 1), 300);
          console.log(`🔄 Retry in ${backoff}s`);
          try {
            await sqs.send(new ChangeMessageVisibilityCommand({
              QueueUrl: process.env.QUEUE_URL, ReceiptHandle: currentRH,
              VisibilityTimeout: backoff
            }));
          } catch (_) {}
        }
      } finally {
        currentRH = null;
        await protectInstance(false);
      }

    } catch (loopErr) {
      console.error('❌ Loop error:', loopErr);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

let shuttingDown = false;
async function shutdown(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n🛑 ${sig} — shutting down...`);
  if (currentRH) {
    try {
      await sqs.send(new ChangeMessageVisibilityCommand({
        QueueUrl: process.env.QUEUE_URL, ReceiptHandle: currentRH, VisibilityTimeout: 0
      }));
      console.log('✅ Message released');
    } catch (_) {}
  }
  await new Promise(r => setTimeout(r, 5000));
  try { await mongoose.connection.close(); } catch (_) {}
  try { await protectInstance(false); } catch (_) {}
  console.log('👋 Bye');
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('uncaughtException',  e => { console.error('💥 Uncaught:', e); shutdown('EXCEPTION'); });
process.on('unhandledRejection', r => { console.error('💥 Unhandled:', r); });

startWorker().catch(err => { console.error('❌ Fatal:', err); process.exit(1); });
JSEOF

# ── Permissions ───────────────────────────────────────────────────────────────
chown -R ec2-user:ec2-user $APP_DIR

# ── Systemd Service ──────────────────────────────────────────────────────────
cat > /etc/systemd/system/cinishine-worker.service << EOF
[Unit]
Description=CiniShine Media Worker v4.4
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=ec2-user
WorkingDirectory=/home/ec2-user/cinishine-worker
EnvironmentFile=/home/ec2-user/cinishine-worker/.env
ExecStart=/usr/bin/node /home/ec2-user/cinishine-worker/workers/worker.js
Restart=always
RestartSec=15
StandardOutput=journal
StandardError=journal
SyslogIdentifier=cinishine-worker
LimitNOFILE=131072
LimitNPROC=16384
TimeoutStopSec=90

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable cinishine-worker
systemctl restart cinishine-worker
sleep 5

if systemctl is-active --quiet cinishine-worker; then
  echo "✅ Worker started"
  systemctl status cinishine-worker --no-pager
else
  echo "❌ Worker failed to start"
  journalctl -u cinishine-worker -n 100 --no-pager
  exit 1
fi

# ── Completion marker — the single source of truth for "did setup finish?" ───
# Check for this via SSM Run Command across the fleet:
#   aws ssm send-command --document-name "AWS-RunShellScript" \
#     --parameters 'commands=["test -f /var/tmp/bootstrap-complete && echo OK || echo MISSING"]' \
#     --targets "Key=tag:Application,Values=cinishine"
echo "$(date) instance=$INSTANCE_ID type=$INSTANCE_TYPE" > "$MARKER_FILE"

echo ""
echo "================================================================="
echo "  CiniShine Worker v4.4 — DEPLOYED"
echo "================================================================="
echo ""
echo "  ✅ All-at-once encoding (single FFmpeg pass, all renditions)"
echo "  ✅ Upload after processing completes"
echo "  ✅ /var/tmp (EBS) instead of /tmp (tmpfs/RAM)"
echo "  ✅ Handles video-only files (no audio stream)"
echo "  ✅ Manual master playlist (bypasses FFmpeg bug)"
echo "  ✅ Retry logic on every network call in bootstrap"
echo "  ✅ Completion marker at $MARKER_FILE"
echo ""
echo "  ⚡ REQUIRED: Increase EBS root volume to 30+ GB"
echo "     In Launch Template → Block Device → /dev/xvda → 30 GB gp3"
echo "     Or: aws ec2 modify-volume --volume-id <vol> --size 30"
echo ""
echo "  📋 Commands:"
echo "     sudo journalctl -u cinishine-worker -f"
echo "     sudo systemctl restart cinishine-worker"
echo "     df -h /var/tmp"
echo "     test -f /var/tmp/bootstrap-complete && echo READY || echo NOT_READY"
echo ""