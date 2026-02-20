#!/bin/bash
set -e

# Production Media Processing Worker Setup - SUPPORTS VIDEOS, SHORTS, AUDIO
# Handles multiple content types with appropriate processing pipelines
# Version 4.2 - UNIFIED CONTENT MODEL + MASTER PLAYLIST FIX

REGION="us-east-1"
BUCKET_NAME="cini-shine"
QUEUE_URL="https://sqs.us-east-1.amazonaws.com/856507207317/video-processing-queue"
SSM_PREFIX="/cinishine"
ASG_NAME="cinishine-worker-asg"
INSTANCE_ID=""

# try ec2-metadata first
for i in {1..5}; do
  INSTANCE_ID=$(ec2-metadata --instance-id 2>/dev/null | cut -d ' ' -f 2)
  if [ -n "$INSTANCE_ID" ] && [ "$INSTANCE_ID" != "i-" ]; then
    break
  fi
  echo "⚠️  Attempt $i: Waiting for instance metadata..."
  sleep 2
done

if [ -z "$INSTANCE_ID" ]; then
  TOKEN=$(curl -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 21600" -s)
  INSTANCE_ID=$(curl -H "X-aws-ec2-metadata-token: $TOKEN" -s http://169.254.169.254/latest/meta-data/instance-id)
fi

INSTANCE_TYPE=$(ec2-metadata --instance-type 2>/dev/null | cut -d ' ' -f 2 || echo "unknown")

exec > >(tee /var/log/worker-setup.log) 2>&1
echo "=== CiniShine Media Processing Worker Setup - $(date) ==="
echo "Instance ID: $INSTANCE_ID"
echo "Instance Type: $INSTANCE_TYPE"

# System optimization
echo ">>> Optimizing system..."
if ! grep -q "nofile 131072" /etc/security/limits.conf 2>/dev/null; then
  echo "* soft nofile 131072" >> /etc/security/limits.conf
  echo "* hard nofile 131072" >> /etc/security/limits.conf
fi
if ! grep -q "vm.dirty_ratio" /etc/sysctl.conf 2>/dev/null; then
  echo 'vm.dirty_ratio = 10' >> /etc/sysctl.conf
  echo 'vm.dirty_background_ratio = 5' >> /etc/sysctl.conf
  echo 'vm.swappiness = 10' >> /etc/sysctl.conf
fi
sysctl -p || true

# Install packages
echo ">>> Installing packages..."
dnf update -y || true
curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -
dnf install -y nodejs git wget tar xz jq || true

# Install FFmpeg (static build)
echo ">>> Installing FFmpeg..."
cd /tmp
wget -q https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz
tar xf ffmpeg-release-amd64-static.tar.xz
cp ffmpeg-*-amd64-static/ffmpeg /usr/local/bin/
cp ffmpeg-*-amd64-static/ffprobe /usr/local/bin/
chmod +x /usr/local/bin/ffmpeg /usr/local/bin/ffprobe
rm -rf ffmpeg-*-amd64-static ffmpeg-release-amd64-static.tar.xz || true

echo "Node.js: $(node --version)"
echo "npm: $(npm --version)"
echo "FFmpeg: $(ffmpeg -version | head -n1)"

APP_DIR="/home/ec2-user/cinishine-worker"
mkdir -p $APP_DIR
cd $APP_DIR

cat > package.json << 'EOF'
{
  "name": "cinishine-worker",
  "version": "4.2.0",
  "type": "module",
  "scripts": {
    "worker": "node workers/worker.js"
  },
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

npm install --silent

echo ">>> Loading SSM config..."
get_ssm_param() {
  aws ssm get-parameter --region $REGION --name "${SSM_PREFIX}/$1" --with-decryption --query 'Parameter.Value' --output text 2>/dev/null || echo ""
}

MONGO_URI=$(get_ssm_param "MONGO_URI")
S3_BUCKET=$(get_ssm_param "S3_BUCKET")

cat > .env << EOF
MONGO_URI=$MONGO_URI
AWS_REGION=$REGION
S3_BUCKET=$S3_BUCKET
QUEUE_URL=$QUEUE_URL
INSTANCE_ID=$INSTANCE_ID
INSTANCE_TYPE=$INSTANCE_TYPE
ASG_NAME=$ASG_NAME
MAX_CONCURRENT_JOBS=1
VISIBILITY_TIMEOUT=600
NODE_ENV=production
LOG_LEVEL=info
EOF

mkdir -p models

# ============================================================================
# UNIFIED CONTENT MODEL - Replaces old Video + Content split
# Includes ALL fields for backward compatibility
# ============================================================================
cat > models/content.model.js << 'JSEOF'
import mongoose from 'mongoose';

const contentSchema = new mongoose.Schema({
  // Content type discriminator
  contentType: {
    type: String,
    enum: ['video', 'short', 'audio', 'post'],
    required: true,
    index: true
  },
  
  // Creator reference
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  
  // Basic metadata
  title: {
    type: String,
    trim: true,
    maxlength: 200
  },
  description: {
    type: String,
    trim: true,
    maxlength: 5000
  },
  channelName: String,
  
  // Tags and categorization
  tags: [{
    type: String,
    trim: true
  }],
  category: {
    type: String,
    trim: true
  },
  
  // Content settings
  visibility: {
    type: String,
    enum: ['public', 'unlisted', 'private'],
    default: 'public'
  },
  isAgeRestricted: {
    type: Boolean,
    default: false
  },
  commentsEnabled: {
    type: Boolean,
    default: true
  },
  selectedRoles: [{
    type: String,
    trim: true
  }],
  
  // ============================================
  // MEDIA FILES (S3 keys)
  // ============================================
  originalKey: String,
  hlsMasterKey: String,
  processedKey: String,      // For audio: processed AAC file
  thumbnailKey: String,
  thumbnailSource: {
    type: String,
    enum: ['auto', 'custom'],
    default: 'auto'
  },
  imageKey: String,
  imageKeys: [{
    type: String,
    trim: true
  }],
  
  // ============================================
  // MEDIA METADATA
  // ============================================
  duration: Number,
  fileSize: Number,
  mimeType: String,
  
  // File sizes (for backward compatibility with old Video model)
  sizes: {
    original: Number,
    processed: Number
  },
  
  // ============================================
  // PROCESSING STATUS
  // ============================================
  status: {
    type: String,
    enum: ['uploading', 'processing', 'completed', 'failed'],
    default: 'uploading'
  },
  processingStart: Date,
  processingEnd: Date,
  processingError: String,
  error: String,  // Legacy field for backward compatibility
  
  // ============================================
  // RENDITIONS (for video/shorts)
  // ============================================
  renditions: [{
    resolution: String,
    bitrate: Number,
    name: String,           // Added for backward compatibility
    playlistKey: String,
    codecs: String
  }],
  
  // ============================================
  // VIDEO METADATA (for backward compatibility)
  // ============================================
  metadata: {
    originalResolution: String,
    originalCodec: String,
    hasAudio: Boolean,
    videoCodec: String,
    audioCodec: String
  },
  
  // ============================================
  // AUDIO-SPECIFIC
  // ============================================
  audioMetadata: {
    bitrate: Number,
    sampleRate: Number,
    channels: Number,
    codec: String
  },
  audioCategory: {
    type: String,
    enum: ['music', 'podcast', 'audiobook', 'sound-effect', 'other'],
    default: 'music'
  },
  artist: String,
  album: String,
  
  // ============================================
  // ENGAGEMENT METRICS
  // ============================================
  views: { type: Number, default: 0 },
  likeCount: { type: Number, default: 0 },
  dislikeCount: { type: Number, default: 0 },
  commentCount: { type: Number, default: 0 },
  shareCount: { type: Number, default: 0 },
  
  // ============================================
  // ANALYTICS
  // ============================================
  lastViewedAt: Date,
  averageWatchTime: { type: Number, default: 0 },
  watchCount: { type: Number, default: 0 },
  totalWatchTime: { type: Number, default: 0 },
  
  // ============================================
  // POST-SPECIFIC
  // ============================================
  postContent: String,
  
  // ============================================
  // TIMESTAMPS
  // ============================================
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  },
  publishedAt: Date
}, {
  timestamps: true
});

// Indexes
contentSchema.index({ contentType: 1, status: 1, createdAt: -1 });
contentSchema.index({ userId: 1, contentType: 1 });
contentSchema.index({ tags: 1 });
contentSchema.index({ visibility: 1, status: 1 });
contentSchema.index({ contentType: 1, status: 1, views: -1 });

export default mongoose.model('Content', contentSchema);
JSEOF

mkdir -p workers
cat > workers/worker.js << 'JSEOF'
import 'dotenv/config';
import { spawn, execSync } from 'child_process';
import Content from '../models/content.model.js';
import fs from 'fs';
import path from 'path';
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  HeadObjectCommand
} from '@aws-sdk/client-s3';
import {
  SQSClient,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  ChangeMessageVisibilityCommand,
  GetQueueAttributesCommand
} from '@aws-sdk/client-sqs';
import {
  AutoScalingClient,
  SetInstanceProtectionCommand
} from '@aws-sdk/client-auto-scaling';
import mongoose from 'mongoose';
import ffprobeInstaller from '@ffprobe-installer/ffprobe';

const ffprobePath = ffprobeInstaller.path;

console.log("🎬 CiniShine Media Processing Worker v4.2 - UNIFIED CONTENT MODEL");
console.log("📊 Configuration:");
console.log("   MONGO_URI:", process.env.MONGO_URI ? "✔" : "✗");
console.log("   AWS_REGION:", process.env.AWS_REGION);
console.log("   S3_BUCKET:", process.env.S3_BUCKET);
console.log("   QUEUE_URL:", process.env.QUEUE_URL);
console.log("   INSTANCE_ID:", process.env.INSTANCE_ID || "⚠️  NOT SET");

const s3Client = new S3Client({
  region: process.env.AWS_REGION,
  maxAttempts: 5,
  requestTimeout: 60000
});

const sqsClient = new SQSClient({
  region: process.env.AWS_REGION
});

const asgClient = new AutoScalingClient({
  region: process.env.AWS_REGION
});

// ============================================================================
// RENDITION PROFILES
// ============================================================================

const VIDEO_RENDITIONS = [
  { resolution: '256x144', bitrate: 200000, audioBitrate: '128k', name: '144p', width: 256, height: 144 },
  { resolution: '426x240', bitrate: 400000, audioBitrate: '128k', name: '240p', width: 426, height: 240 },
  { resolution: '640x360', bitrate: 800000, audioBitrate: '128k', name: '360p', width: 640, height: 360 },
  { resolution: '854x480', bitrate: 1500000, audioBitrate: '128k', name: '480p', width: 854, height: 480 },
  { resolution: '1280x720', bitrate: 2500000, audioBitrate: '128k', name: '720p', width: 1280, height: 720 },
  { resolution: '1920x1080', bitrate: 5000000, audioBitrate: '128k', name: '1080p', width: 1920, height: 1080 }
];

const SHORT_RENDITIONS = [
  { resolution: '480x854', bitrate: 1500000, audioBitrate: '128k', name: '480p', width: 480, height: 854 },
  { resolution: '720x1280', bitrate: 3000000, audioBitrate: '128k', name: '720p', width: 720, height: 1280 },
  { resolution: '1080x1920', bitrate: 6000000, audioBitrate: '128k', name: '1080p', width: 1080, height: 1920 }
];

// ============================================================================
// CONTENT TYPE DETECTION
// ============================================================================

function detectContentType(s3Key) {
  const parts = s3Key.split('/');
  const folder = parts[0].toLowerCase();
  
  if (folder === 'uploads') return 'video';
  if (folder === 'shorts') return 'short';
  if (folder === 'audio') return 'audio';
  
  const ext = path.extname(s3Key).toLowerCase();
  if (['.mp3', '.wav', '.flac', '.aac', '.m4a', '.ogg'].includes(ext)) {
    return 'audio';
  }
  
  return 'video';
}

function getAppropriateRenditions(inputWidth, inputHeight, contentType) {
  const isVertical = inputHeight > inputWidth;
  const renditions = contentType === 'short' ? SHORT_RENDITIONS : VIDEO_RENDITIONS;
  
  console.log(`📐 Input: ${inputWidth}x${inputHeight} (${contentType}, ${isVertical ? 'vertical' : 'horizontal'})`);
  
  const inputPixels = inputWidth * inputHeight;
  const appropriate = renditions.filter(r => {
    const targetPixels = r.width * r.height;
    return targetPixels <= (inputPixels * 1.1);
  });
  
  if (appropriate.length === 0) return [renditions[0]];
  appropriate.sort((a, b) => (a.width * a.height) - (b.width * b.height));
  console.log(`✅ Selected: ${appropriate.map(r => r.name).join(', ')}`);
  return appropriate;
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

async function getFFmpegPath() {
  try {
    execSync('which ffmpeg', { stdio: 'ignore' });
    return 'ffmpeg';
  } catch {
    throw new Error('FFmpeg not found in PATH');
  }
}

function getTempDir(fileId) {
  return path.join('/tmp', `media-processor-${fileId}-${Date.now()}`);
}

function ensureDirectoryExists(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true, mode: 0o755 });
    console.log(`📁 Created: ${dirPath}`);
  }
}

async function getMediaMetadata(inputPath) {
  return new Promise((resolve, reject) => {
    console.log('📊 Analyzing media with FFprobe...');
    const proc = spawn(ffprobePath, [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      inputPath
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

    proc.on('close', (code) => {
      if (code === 0) {
        try {
          const metadata = JSON.parse(stdout);
          const videoStream = metadata.streams.find(s => s.codec_type === 'video');
          const audioStream = metadata.streams.find(s => s.codec_type === 'audio');
          
          console.log('✅ Metadata:');
          console.log(`   Duration: ${parseFloat(metadata.format.duration).toFixed(2)}s`);
          if (videoStream) {
            console.log(`   Video: ${videoStream.codec_name} ${videoStream.width}x${videoStream.height}`);
          }
          if (audioStream) {
            console.log(`   Audio: ${audioStream.codec_name} ${audioStream.sample_rate}Hz ${audioStream.channels}ch`);
          }
          
          resolve({
            duration: parseFloat(metadata.format.duration),
            bitrate: parseInt(metadata.format.bit_rate) || 0,
            videoStream,
            audioStream,
            hasVideo: !!videoStream,
            hasAudio: !!audioStream
          });
        } catch (parseError) {
          reject(new Error('Failed to parse ffprobe output: ' + parseError.message));
        }
      } else {
        reject(new Error(`ffprobe failed (${code}): ${stderr}`));
      }
    });

    proc.on('error', (err) => reject(err));
  });
}

async function runFFmpeg(args, options = {}) {
  const ffmpegPath = await getFFmpegPath();
  console.log(`🚀 FFmpeg command (first 12 args): ${args.slice(0, 12).join(' ')}...`);

  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    const ffmpeg = spawn(ffmpegPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      ...options
    });

    // Cap stderr to prevent unbounded memory growth on long encodes (2h+ videos)
    const MAX_STDERR = 5 * 1024 * 1024; // 5MB cap
    let stderrChunks = [];
    let stderrLen = 0;
    let lastProgress = '';
    let lastLogTime = 0;

    // Drain stdout to prevent pipe blocking (FFmpeg rarely writes here but safety first)
    ffmpeg.stdout.on('data', () => {});

    ffmpeg.stderr.on('data', (data) => {
      const text = data.toString();

      // Only keep recent stderr to avoid OOM on multi-hour encodes
      if (stderrLen < MAX_STDERR) {
        stderrChunks.push(text);
        stderrLen += text.length;
      }

      if (text.includes('time=')) {
        const m = text.match(/time=(\d+:\d+:\d+\.\d+)/);
        if (m && m[1] !== lastProgress) {
          lastProgress = m[1];
          const now = Date.now();
          if (now - lastLogTime > 10000) {
            console.log(`   ⏱️  Progress: ${lastProgress}`);
            lastLogTime = now;
          }
        }
      }
    });

    ffmpeg.on('close', (code) => {
      const duration = ((Date.now() - startTime) / 1000).toFixed(2);
      const stderr = stderrChunks.join('');
      stderrChunks = []; // Free memory immediately

      if (stderr.length > 0) {
        const tail = stderr.slice(-3000);
        console.log('--- FFmpeg STDERR (tail) ---');
        console.log(tail);
        console.log('--- end stderr ---');
      }

      if (code !== 0) {
        console.error(`❌ FFmpeg FAILED with exit code ${code}`);
        return reject(new Error(`FFmpeg failed with code ${code}. See stderr above.`));
      }

      console.log(`✅ FFmpeg completed in ${duration}s (exit code 0)`);
      resolve({ stderr, duration });
    });

    ffmpeg.on('error', (err) => {
      console.error('❌ FFmpeg spawn error:', err);
      reject(err);
    });
  });
}

async function uploadToS3WithRetry(filePath, s3Key, contentType, cacheControl, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const stats = fs.statSync(filePath);
      if (stats.size === 0) throw new Error('File empty (0 bytes)');

      console.log(`   📤 Uploading: ${s3Key} (${(stats.size/1024/1024).toFixed(2)} MB)`);
      const body = fs.createReadStream(filePath);
      await s3Client.send(new PutObjectCommand({
        Bucket: process.env.S3_BUCKET,
        Key: s3Key,
        Body: body,
        ContentType: contentType,
        CacheControl: cacheControl
      }));

      const head = await s3Client.send(new HeadObjectCommand({
        Bucket: process.env.S3_BUCKET,
        Key: s3Key
      }));
      if (head.ContentLength !== stats.size) {
        throw new Error(`Upload size mismatch local=${stats.size} remote=${head.ContentLength}`);
      }
      console.log(`   ✅ Uploaded: ${s3Key}`);
      return true;
    } catch (err) {
      console.error(`   ❌ Upload attempt ${attempt} failed: ${err.message}`);
      if (attempt === maxRetries) throw err;
      const wait = Math.min(1000 * Math.pow(2, attempt), 10000);
      console.log(`   ⏳ Retrying upload in ${wait}ms`);
      await new Promise(r => setTimeout(r, wait));
    }
  }
}

async function validateHLSOutput(outputDir, renditionCount) {
  console.log('🔍 Validating HLS output...');
  const masterPath = path.join(outputDir, 'master.m3u8');
  if (!fs.existsSync(masterPath)) {
    const files = fs.existsSync(outputDir) ? fs.readdirSync(outputDir) : [];
    throw new Error(`Master playlist not created. Files: ${files.join(', ')}`);
  }
  const masterStats = fs.statSync(masterPath);
  if (masterStats.size === 0) {
    throw new Error('Master playlist is EMPTY');
  }
  const masterContent = fs.readFileSync(masterPath, 'utf8');
  if (!masterContent.includes('#EXTM3U')) {
    throw new Error('Master playlist invalid content');
  }
  console.log(`   ✅ Master: ${masterStats.size} bytes`);

  const renditionDirs = fs.readdirSync(outputDir)
    .filter(f => f.startsWith("stream_") && fs.statSync(path.join(outputDir, f)).isDirectory())
    .sort();
  if (renditionDirs.length !== renditionCount) {
    throw new Error(`Expected ${renditionCount} renditions, found ${renditionDirs.length}`);
  }

  let totalSegments = 0;
  for (const dir of renditionDirs) {
    const dirPath = path.join(outputDir, dir);
    const segments = fs.readdirSync(dirPath).filter(f => f.endsWith('.ts'));
    if (segments.length === 0) throw new Error(`No .ts segments for ${dir}`);
    totalSegments += segments.length;
    console.log(`   ✅ ${dir}: ${segments.length} segments`);
  }
  console.log(`✅ Validation passed: ${totalSegments} total segments`);
  return { renditionDirs, totalSegments };
}

// ============================================================================
// MASTER PLAYLIST GENERATOR
// Manually generates master.m3u8 instead of relying on FFmpeg's -master_pl_name
// which silently produces 0-byte files for long videos (2h+) due to an FFmpeg
// HLS muxer bug where the master playlist write during hls_write_trailer()
// fails when the output path uses %v subdirectory expansion.
// ============================================================================
function generateMasterPlaylist(outputDir, renditions, hasAudio) {
  console.log('📝 Generating master playlist manually...');
  const masterPath = path.join(outputDir, 'master.m3u8');

  // Check if FFmpeg left a 0-byte or misplaced master.m3u8
  if (fs.existsSync(masterPath)) {
    const existing = fs.statSync(masterPath).size;
    if (existing > 0) {
      console.log(`   ℹ️  Existing master.m3u8 (${existing} bytes) — overwriting with reliable version`);
    } else {
      console.log('   ⚠️  Found 0-byte master.m3u8 from FFmpeg — replacing');
    }
  }

  // Check for misplaced master.m3u8 in stream_* subdirectories (FFmpeg bug)
  const streamDirs = fs.readdirSync(outputDir)
    .filter(f => f.startsWith('stream_') && fs.statSync(path.join(outputDir, f)).isDirectory());
  for (const dir of streamDirs) {
    const misplaced = path.join(outputDir, dir, 'master.m3u8');
    if (fs.existsSync(misplaced)) {
      console.log(`   ℹ️  Found misplaced master.m3u8 in ${dir}/ — cleaning up`);
      fs.unlinkSync(misplaced);
    }
  }

  // Build master playlist content
  let content = '#EXTM3U\n#EXT-X-VERSION:3\n';

  for (const r of renditions) {
    const streamDir = `stream_${r.name}`;
    const variantPath = path.join(outputDir, streamDir, 'playlist.m3u8');

    if (!fs.existsSync(variantPath)) {
      throw new Error(`Variant playlist missing: ${streamDir}/playlist.m3u8`);
    }
    const variantSize = fs.statSync(variantPath).size;
    if (variantSize === 0) {
      throw new Error(`Variant playlist empty: ${streamDir}/playlist.m3u8`);
    }

    const codecs = hasAudio ? 'avc1.640028,mp4a.40.2' : 'avc1.640028';
    const bandwidth = r.bitrate + (hasAudio ? 128000 : 0);

    content += `#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},RESOLUTION=${r.resolution},CODECS="${codecs}",NAME="${r.name}"\n`;
    content += `${streamDir}/playlist.m3u8\n`;
  }

  fs.writeFileSync(masterPath, content, 'utf8');

  const written = fs.statSync(masterPath);
  if (written.size === 0) {
    throw new Error('Failed to write master playlist — filesystem may be full');
  }

  console.log(`✅ Master playlist generated: ${written.size} bytes, ${renditions.length} variants`);
  return masterPath;
}

async function protectInstance(protect) {
  if (!process.env.INSTANCE_ID || !process.env.ASG_NAME) return;
  try {
    await asgClient.send(new SetInstanceProtectionCommand({
      InstanceIds: [process.env.INSTANCE_ID],
      AutoScalingGroupName: process.env.ASG_NAME,
      ProtectedFromScaleIn: protect
    }));
    console.log(`🛡️  Protection: ${protect ? 'ON' : 'OFF'}`);
  } catch (err) {
    console.warn('⚠️  Protection failed:', err.message);
  }
}

async function extendVisibility(receiptHandle) {
  try {
    await sqsClient.send(new ChangeMessageVisibilityCommand({
      QueueUrl: process.env.QUEUE_URL,
      ReceiptHandle: receiptHandle,
      VisibilityTimeout: parseInt(process.env.VISIBILITY_TIMEOUT || '600', 10)
    }));
    console.log('⏰ Extended visibility');
  } catch (err) {
    console.error('⚠️  Visibility extension failed:', err.message);
  }
}

// ============================================================================
// VIDEO PROCESSING - Uses Content model with contentType='video'
// ============================================================================

async function processVideo(fileId, userId, s3Key, receiptHandle) {
  console.log(`\n🎬 Processing VIDEO: ${fileId}`);
  console.log('═'.repeat(70));

  let tempDir;
  let visibilityExtender;
  const processStart = Date.now();

  try {
    // ✅ Use Content model instead of Video
    const video = await Content.findById(fileId);
    if (!video) {
      console.error(`❌ Content ${fileId} NOT FOUND in database`);
      console.error(`   S3 Key: ${s3Key}`);
      console.error(`   userId: ${userId}`);
      throw new Error(`Content ${fileId} not found`);
    }

    // Verify it's actually a video
    if (video.contentType && video.contentType !== 'video') {
      console.warn(`⚠️  Content ${fileId} is type '${video.contentType}', expected 'video'`);
    }

    // Idempotency check
    if (video.status === 'completed') {
      console.log(`⚠️  Video ${fileId} already completed - skipping`);
      return { success: true, skipped: true };
    }

    await Content.findByIdAndUpdate(fileId, { 
      status: 'processing', 
      processingStart: new Date(), 
      error: null,
      processingError: null
    });
    
    visibilityExtender = setInterval(() => extendVisibility(receiptHandle), 300000);

    tempDir = getTempDir(fileId);
    const inputPath = path.join(tempDir, 'input.mp4');
    const outputDir = path.join(tempDir, 'hls');
    const thumbnailPath = path.join(tempDir, 'thumbnail.jpg');

    ensureDirectoryExists(tempDir);
    ensureDirectoryExists(outputDir);

    // Download
    console.log('📥 Downloading from S3...');
    const { Body } = await s3Client.send(new GetObjectCommand({
      Bucket: process.env.S3_BUCKET,
      Key: video.originalKey,
    }));

    await new Promise((resolve, reject) => {
      const ws = fs.createWriteStream(inputPath);
      Body.pipe(ws).on('finish', resolve).on('error', reject);
    });

    const fileStats = fs.statSync(inputPath);
    console.log(`✅ Downloaded ${(fileStats.size/1024/1024).toFixed(2)} MB`);

    const metadata = await getMediaMetadata(inputPath);
    const { duration, videoStream, hasAudio } = metadata;

    // Thumbnail logic
    let shouldGenerateThumbnail = true;
    let existingThumbnailKey = video.thumbnailKey;
    
    if (video.thumbnailSource === 'custom' && video.thumbnailKey) {
      console.log('🖼️  Custom thumbnail exists - skipping auto-generation');
      shouldGenerateThumbnail = false;
    }

    if (shouldGenerateThumbnail) {
      console.log('🖼️  Generating auto thumbnail...');
      const thumbTime = Math.min(5, duration / 2);
      await runFFmpeg([
        '-ss', thumbTime.toString(),
        '-i', inputPath,
        '-frames:v', '1',
        '-vf', 'scale=320:-2',
        '-q:v', '2',
        '-update', '1',
        '-y',
        thumbnailPath
      ]);
    }

    // Get renditions
    const renditions = getAppropriateRenditions(videoStream.width, videoStream.height, 'video');
    console.log(`🎥 Transcoding ${renditions.length} renditions...`);

    // Build FFmpeg command
    const filterComplex = renditions.map((r, i) => `[v${i}]scale=${r.resolution}[v${i}out]`).join('; ');
    const baseFilter = `[0:v]split=${renditions.length}${renditions.map((_, i) => `[v${i}]`).join('')}; `;

    const ffmpegArgs = [
      '-hide_banner', '-loglevel', 'info', '-y',
      '-i', inputPath,
      '-filter_complex', baseFilter + filterComplex,
    ];

    renditions.forEach((rendition, i) => {
      ffmpegArgs.push(
        '-map', `[v${i}out]`,
        '-c:v:' + i, 'libx264',
        '-b:v:' + i, rendition.bitrate.toString(),
        '-maxrate:v:' + i, Math.round(rendition.bitrate * 1.5).toString(),
        '-bufsize:v:' + i, Math.round(rendition.bitrate * 2).toString(),
        '-preset', 'medium', '-crf', '23',
        '-profile:v:' + i, 'main',
        '-g:v:' + i, '48', '-keyint_min:v:' + i, '48', '-sc_threshold:v:' + i, '0'
      );
      if (hasAudio) {
        ffmpegArgs.push(
          '-map', '0:a:0?',
          '-c:a:' + i, 'aac',
          '-b:a:' + i, rendition.audioBitrate,
          '-ar:a:' + i, '48000', '-ac:a:' + i, '2'
        );
      }
    });

    ffmpegArgs.push(
      '-f', 'hls', '-hls_time', '6', '-hls_list_size', '0',
      '-hls_playlist_type', 'vod', '-hls_flags', 'independent_segments',
      '-hls_segment_type', 'mpegts',
      '-hls_segment_filename', path.join(outputDir, 'stream_%v', 'segment%03d.ts')
    );

    const varStreamMap = renditions.map((r, i) => hasAudio ? `v:${i},a:${i},name:${r.name}` : `v:${i},name:${r.name}`).join(' ');
    ffmpegArgs.push('-var_stream_map', varStreamMap, path.join(outputDir, 'stream_%v', 'playlist.m3u8'));

    // Pre-create stream directories to avoid FFmpeg mkdir race conditions
    for (const r of renditions) {
      ensureDirectoryExists(path.join(outputDir, `stream_${r.name}`));
    }

    await runFFmpeg(ffmpegArgs);

    // Generate master playlist manually — FFmpeg's -master_pl_name produces
    // 0-byte files for long videos due to HLS muxer finalization bug
    generateMasterPlaylist(outputDir, renditions, hasAudio);

    // Validate and upload
    const validation = await validateHLSOutput(outputDir, renditions.length);

    console.log('☁️  Uploading to S3...');
    const masterKey = `hls/videos/${userId}/${fileId}/master.m3u8`;
    await uploadToS3WithRetry(path.join(outputDir, 'master.m3u8'), masterKey, 'application/vnd.apple.mpegurl', 'max-age=300');

    for (const dir of validation.renditionDirs) {
      const dirPath = path.join(outputDir, dir);
      const files = fs.readdirSync(dirPath).sort();
      for (const file of files) {
        const filePath = path.join(dirPath, file);
        const fileKey = `hls/videos/${userId}/${fileId}/${dir}/${file}`;
        const contentType = file.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/MP2T';
        const cacheControl = file.endsWith('.ts') ? 'max-age=31536000' : 'max-age=300';
        await uploadToS3WithRetry(filePath, fileKey, contentType, cacheControl);
      }
    }

    // Upload thumbnail if generated
    let thumbnailKey = existingThumbnailKey;
    if (shouldGenerateThumbnail) {
      thumbnailKey = `thumbnails/videos/${userId}/${fileId}.jpg`;
      await uploadToS3WithRetry(thumbnailPath, thumbnailKey, 'image/jpeg', 'max-age=31536000');
    }

    // ✅ Update Content model with all fields
    const updateData = {
      status: 'completed',
      hlsMasterKey: masterKey,
      thumbnailKey,
      duration,
      renditions: renditions.map((r, i) => ({
        resolution: r.resolution,
        bitrate: r.bitrate,
        name: r.name,
        playlistKey: `hls/videos/${userId}/${fileId}/stream_${r.name}/playlist.m3u8`,
        codecs: hasAudio ? 'avc1.640028,mp4a.40.2' : 'avc1.640028'
      })),
      processingEnd: new Date(),
      'metadata.originalResolution': `${videoStream.width}x${videoStream.height}`,
      'metadata.originalCodec': videoStream.codec_name,
      'metadata.hasAudio': hasAudio,
      'sizes.original': fileStats.size,
      error: null,
      processingError: null
    };
    
    if (shouldGenerateThumbnail) {
      updateData.thumbnailSource = 'auto';
    }

    await Content.findByIdAndUpdate(fileId, updateData);

    const totalMinutes = ((Date.now() - processStart) / 1000 / 60).toFixed(2);
    console.log(`✅ VIDEO COMPLETE: ${fileId} in ${totalMinutes} min`);
    return { success: true };

  } catch (error) {
    console.error('❌ ERROR:', error.message);
    await Content.findByIdAndUpdate(fileId, {
      status: 'failed', 
      error: error.message,
      processingError: error.message, 
      processingEnd: new Date()
    }).catch(e => console.error('DB update failed:', e));
    throw error;
  } finally {
    if (visibilityExtender) clearInterval(visibilityExtender);
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }
}

// ============================================================================
// SHORT PROCESSING
// ============================================================================

async function processShort(fileId, userId, s3Key, receiptHandle) {
  console.log(`\n📱 Processing SHORT: ${fileId}`);
  console.log('═'.repeat(70));

  let tempDir;
  let visibilityExtender;
  const processStart = Date.now();

  try {
    const content = await Content.findById(fileId);
    if (!content) throw new Error(`Short ${fileId} not found`);

    if (content.status === 'completed') {
      console.log(`⚠️  Short ${fileId} already completed - skipping`);
      return { success: true, skipped: true };
    }

    await Content.findByIdAndUpdate(fileId, { 
      status: 'processing', 
      processingStart: new Date(), 
      processingError: null 
    });
    visibilityExtender = setInterval(() => extendVisibility(receiptHandle), 300000);

    tempDir = getTempDir(fileId);
    const inputPath = path.join(tempDir, 'input.mp4');
    const outputDir = path.join(tempDir, 'hls');
    const thumbnailPath = path.join(tempDir, 'thumbnail.jpg');

    ensureDirectoryExists(tempDir);
    ensureDirectoryExists(outputDir);

    console.log('📥 Downloading from S3...');
    const { Body } = await s3Client.send(new GetObjectCommand({
      Bucket: process.env.S3_BUCKET,
      Key: content.originalKey,
    }));

    await new Promise((resolve, reject) => {
      const ws = fs.createWriteStream(inputPath);
      Body.pipe(ws).on('finish', resolve).on('error', reject);
    });

    const fileStats = fs.statSync(inputPath);
    console.log(`✅ Downloaded ${(fileStats.size/1024/1024).toFixed(2)} MB`);

    const metadata = await getMediaMetadata(inputPath);
    const { duration, videoStream, hasAudio } = metadata;

    if (duration > 65) {
      console.warn(`⚠️  Short duration ${duration}s exceeds 60s limit`);
    }

    let shouldGenerateThumbnail = true;
    let existingThumbnailKey = content.thumbnailKey;
    
    if (content.thumbnailSource === 'custom' && content.thumbnailKey) {
      console.log('🖼️  Custom thumbnail exists - skipping auto-generation');
      shouldGenerateThumbnail = false;
    }

    if (shouldGenerateThumbnail) {
      console.log('🖼️  Generating auto thumbnail...');
      await runFFmpeg([
        '-ss', '0.5',
        '-i', inputPath,
        '-frames:v', '1',
        '-vf', 'scale=360:-2',
        '-q:v', '2',
        '-update', '1',
        '-y',
        thumbnailPath
      ]);
    }

    const isVertical = videoStream.height > videoStream.width;
    const renditions = getAppropriateRenditions(videoStream.width, videoStream.height, 'short');
    
    console.log(`📱 Transcoding ${renditions.length} renditions (vertical: ${isVertical})...`);

    const scaleFilter = renditions.map((r, i) => {
      const scale = isVertical 
        ? `scale=${r.height}:${r.width}` 
        : `scale=${r.resolution}`;
      return `[v${i}]${scale}[v${i}out]`;
    }).join('; ');
    const baseFilter = `[0:v]split=${renditions.length}${renditions.map((_, i) => `[v${i}]`).join('')}; `;

    const ffmpegArgs = [
      '-hide_banner', '-loglevel', 'info', '-y',
      '-i', inputPath,
      '-filter_complex', baseFilter + scaleFilter,
    ];

    renditions.forEach((rendition, i) => {
      ffmpegArgs.push(
        '-map', `[v${i}out]`,
        '-c:v:' + i, 'libx264',
        '-b:v:' + i, rendition.bitrate.toString(),
        '-maxrate:v:' + i, Math.round(rendition.bitrate * 1.5).toString(),
        '-bufsize:v:' + i, Math.round(rendition.bitrate * 2).toString(),
        '-preset', 'fast', '-crf', '21',
        '-profile:v:' + i, 'high',
        '-g:v:' + i, '30', '-keyint_min:v:' + i, '30', '-sc_threshold:v:' + i, '0'
      );
      if (hasAudio) {
        ffmpegArgs.push(
          '-map', '0:a:0?',
          '-c:a:' + i, 'aac',
          '-b:a:' + i, rendition.audioBitrate,
          '-ar:a:' + i, '48000', '-ac:a:' + i, '2'
        );
      }
    });

    ffmpegArgs.push(
      '-f', 'hls', '-hls_time', '2', '-hls_list_size', '0',
      '-hls_playlist_type', 'vod', '-hls_flags', 'independent_segments',
      '-hls_segment_type', 'mpegts',
      '-hls_segment_filename', path.join(outputDir, 'stream_%v', 'segment%03d.ts')
    );

    const varStreamMap = renditions.map((r, i) => hasAudio ? `v:${i},a:${i},name:${r.name}` : `v:${i},name:${r.name}`).join(' ');
    ffmpegArgs.push('-var_stream_map', varStreamMap, path.join(outputDir, 'stream_%v', 'playlist.m3u8'));

    // Pre-create stream directories
    for (const r of renditions) {
      ensureDirectoryExists(path.join(outputDir, `stream_${r.name}`));
    }

    await runFFmpeg(ffmpegArgs);

    // Generate master playlist manually
    generateMasterPlaylist(outputDir, renditions, hasAudio);

    const validation = await validateHLSOutput(outputDir, renditions.length);

    console.log('☁️  Uploading to S3...');
    const masterKey = `hls/shorts/${userId}/${fileId}/master.m3u8`;
    await uploadToS3WithRetry(path.join(outputDir, 'master.m3u8'), masterKey, 'application/vnd.apple.mpegurl', 'max-age=300');

    for (const dir of validation.renditionDirs) {
      const dirPath = path.join(outputDir, dir);
      const files = fs.readdirSync(dirPath).sort();
      for (const file of files) {
        const filePath = path.join(dirPath, file);
        const fileKey = `hls/shorts/${userId}/${fileId}/${dir}/${file}`;
        const contentType = file.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/MP2T';
        const cacheControl = file.endsWith('.ts') ? 'max-age=31536000' : 'max-age=300';
        await uploadToS3WithRetry(filePath, fileKey, contentType, cacheControl);
      }
    }

    let thumbnailKey = existingThumbnailKey;
    if (shouldGenerateThumbnail) {
      thumbnailKey = `thumbnails/shorts/${userId}/${fileId}.jpg`;
      await uploadToS3WithRetry(thumbnailPath, thumbnailKey, 'image/jpeg', 'max-age=31536000');
    }

    const updateData = {
      status: 'completed',
      hlsMasterKey: masterKey,
      thumbnailKey,
      duration,
      fileSize: fileStats.size,
      renditions: renditions.map((r, i) => ({
        resolution: r.resolution,
        bitrate: r.bitrate,
        name: r.name,
        playlistKey: `hls/shorts/${userId}/${fileId}/stream_${r.name}/playlist.m3u8`,
        codecs: hasAudio ? 'avc1.640028,mp4a.40.2' : 'avc1.640028'
      })),
      processingEnd: new Date()
    };
    
    if (shouldGenerateThumbnail) {
      updateData.thumbnailSource = 'auto';
    }

    await Content.findByIdAndUpdate(fileId, updateData);

    const totalSeconds = ((Date.now() - processStart) / 1000).toFixed(2);
    console.log(`✅ SHORT COMPLETE: ${fileId} in ${totalSeconds}s`);
    return { success: true };

  } catch (error) {
    console.error('❌ ERROR:', error.message);
    await Content.findByIdAndUpdate(fileId, {
      status: 'failed', processingError: error.message, processingEnd: new Date()
    }).catch(e => console.error('DB update failed:', e));
    throw error;
  } finally {
    if (visibilityExtender) clearInterval(visibilityExtender);
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }
}

// ============================================================================
// AUDIO PROCESSING
// ============================================================================

async function processAudio(fileId, userId, s3Key, receiptHandle) {
  console.log(`\n🎵 Processing AUDIO: ${fileId}`);
  console.log('═'.repeat(70));

  let tempDir;
  let visibilityExtender;
  const processStart = Date.now();

  try {
    const content = await Content.findById(fileId);
    if (!content) throw new Error(`Audio ${fileId} not found`);

    if (content.status === 'completed') {
      console.log(`⚠️  Audio ${fileId} already completed - skipping`);
      return { success: true, skipped: true };
    }

    await Content.findByIdAndUpdate(fileId, { 
      status: 'processing', 
      processingStart: new Date(), 
      processingError: null 
    });
    visibilityExtender = setInterval(() => extendVisibility(receiptHandle), 300000);

    tempDir = getTempDir(fileId);
    const ext = path.extname(s3Key).toLowerCase() || '.mp3';
    const inputPath = path.join(tempDir, `input${ext}`);
    const outputPath = path.join(tempDir, 'output.m4a');
    const hlsDir = path.join(tempDir, 'hls');

    ensureDirectoryExists(tempDir);
    ensureDirectoryExists(hlsDir);

    console.log('📥 Downloading from S3...');
    const { Body } = await s3Client.send(new GetObjectCommand({
      Bucket: process.env.S3_BUCKET,
      Key: content.originalKey,
    }));

    await new Promise((resolve, reject) => {
      const ws = fs.createWriteStream(inputPath);
      Body.pipe(ws).on('finish', resolve).on('error', reject);
    });

    const fileStats = fs.statSync(inputPath);
    console.log(`✅ Downloaded ${(fileStats.size/1024/1024).toFixed(2)} MB`);

    const metadata = await getMediaMetadata(inputPath);
    const { duration, audioStream } = metadata;

    if (!audioStream) {
      throw new Error('No audio stream found in file');
    }

    console.log('🎵 Converting to AAC...');
    await runFFmpeg([
      '-i', inputPath,
      '-vn',
      '-c:a', 'aac',
      '-b:a', '256k',
      '-ar', '48000',
      '-ac', '2',
      '-y',
      outputPath
    ]);

    console.log('🎵 Creating HLS audio stream...');
    await runFFmpeg([
      '-i', inputPath,
      '-vn',
      '-c:a', 'aac',
      '-b:a', '256k',
      '-ar', '48000',
      '-ac', '2',
      '-f', 'hls',
      '-hls_time', '10',
      '-hls_list_size', '0',
      '-hls_playlist_type', 'vod',
      '-hls_segment_filename', path.join(hlsDir, 'segment%03d.ts'),
      '-y',
      path.join(hlsDir, 'playlist.m3u8')
    ]);

    console.log('☁️  Uploading to S3...');
    
    const processedKey = `audio/processed/${userId}/${fileId}.m4a`;
    await uploadToS3WithRetry(outputPath, processedKey, 'audio/mp4', 'max-age=31536000');

    const hlsFiles = fs.readdirSync(hlsDir);
    const hlsMasterKey = `hls/audio/${userId}/${fileId}/playlist.m3u8`;
    
    for (const file of hlsFiles) {
      const filePath = path.join(hlsDir, file);
      const fileKey = `hls/audio/${userId}/${fileId}/${file}`;
      const contentType = file.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'audio/aac';
      const cacheControl = file.endsWith('.ts') ? 'max-age=31536000' : 'max-age=300';
      await uploadToS3WithRetry(filePath, fileKey, contentType, cacheControl);
    }

    await Content.findByIdAndUpdate(fileId, {
      status: 'completed',
      processedKey,
      hlsMasterKey,
      duration,
      fileSize: fileStats.size,
      audioMetadata: {
        bitrate: 256000,
        sampleRate: 48000,
        channels: 2,
        codec: 'aac'
      },
      processingEnd: new Date()
    });

    const totalSeconds = ((Date.now() - processStart) / 1000).toFixed(2);
    console.log(`✅ AUDIO COMPLETE: ${fileId} in ${totalSeconds}s`);
    return { success: true };

  } catch (error) {
    console.error('❌ ERROR:', error.message);
    await Content.findByIdAndUpdate(fileId, {
      status: 'failed', processingError: error.message, processingEnd: new Date()
    }).catch(e => console.error('DB update failed:', e));
    throw error;
  } finally {
    if (visibilityExtender) clearInterval(visibilityExtender);
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }
}

// ============================================================================
// MAIN WORKER LOOP
// ============================================================================

let currentReceiptHandle = null;

async function startWorker() {
  console.log('\n🚀 Connecting to MongoDB...');
  await mongoose.connect(process.env.MONGO_URI, {
    maxPoolSize: 10,
    serverSelectionTimeoutMS: 15000,
    socketTimeoutMS: 60000,
  });
  console.log('✅ MongoDB connected');

  await getFFmpegPath();
  console.log('✅ FFmpeg available');

  console.log('\n📡 Starting SQS polling...');
  console.log('═'.repeat(70));

  let stats = { video: 0, short: 0, audio: 0, failed: 0 };
  let emptyPollCount = 0;

  while (true) {
    try {
      console.log(`\n📭 Polling SQS [V:${stats.video} S:${stats.short} A:${stats.audio} F:${stats.failed}]`);
      
      const result = await sqsClient.send(new ReceiveMessageCommand({
        QueueUrl: process.env.QUEUE_URL,
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: 20,
        VisibilityTimeout: parseInt(process.env.VISIBILITY_TIMEOUT || '600', 10),
        AttributeNames: ['All']
      }));

      if (result.Messages && result.Messages.length > 0) {
        emptyPollCount = 0;
        const message = result.Messages[0];
        currentReceiptHandle = message.ReceiptHandle;

        let contentId, userId, s3Key, contentType;
        
        try {
          const body = JSON.parse(message.Body);
          s3Key = body.key || body.s3Key;
          if (!s3Key) throw new Error('No S3 key in message');
          
          // Filter out output artifacts
          if (
            s3Key.startsWith('audio/processed/') ||
            s3Key.startsWith('hls/') ||
            s3Key.startsWith('thumbnails/')
          ) {
            console.log(`🚫 Ignoring output artifact: ${s3Key}`);
            await sqsClient.send(new DeleteMessageCommand({
              QueueUrl: process.env.QUEUE_URL,
              ReceiptHandle: currentReceiptHandle,
            }));
            currentReceiptHandle = null;
            continue;
          }
          
          contentType = detectContentType(s3Key);
          
          const parts = s3Key.split('/');
          if (parts.length < 3) throw new Error('Invalid S3 key format');
          
          userId = parts[1];
          const fileName = parts[2];
          const baseName = fileName.replace(path.extname(fileName), '');
          contentId = baseName.includes('_') ? baseName.split('_')[0] : baseName;
          
        } catch (parseError) {
          console.error('❌ Invalid message:', parseError.message);
          await sqsClient.send(new DeleteMessageCommand({
            QueueUrl: process.env.QUEUE_URL,
            ReceiptHandle: currentReceiptHandle,
          }));
          currentReceiptHandle = null;
          continue;
        }

        console.log(`\n📥 Job: ${contentType.toUpperCase()} - ${contentId}`);
        console.log(`   User: ${userId}`);
        console.log(`   S3 Key: ${s3Key}`);

        await protectInstance(true);

        try {
          switch (contentType) {
            case 'video':
              await processVideo(contentId, userId, s3Key, currentReceiptHandle);
              stats.video++;
              break;
            case 'short':
              await processShort(contentId, userId, s3Key, currentReceiptHandle);
              stats.short++;
              break;
            case 'audio':
              await processAudio(contentId, userId, s3Key, currentReceiptHandle);
              stats.audio++;
              break;
            default:
              throw new Error(`Unknown content type: ${contentType}`);
          }

          await sqsClient.send(new DeleteMessageCommand({
            QueueUrl: process.env.QUEUE_URL,
            ReceiptHandle: currentReceiptHandle,
          }));
          console.log(`✅ Job ${contentId} complete, message deleted`);

        } catch (err) {
          console.error(`❌ Job ${contentId} FAILED:`, err.message);
          stats.failed++;
          
          const receiveCount = parseInt(message.Attributes?.ApproximateReceiveCount || '1');
          console.log(`📊 Receive count: ${receiveCount}/3`);
          
          if (receiveCount >= 3) {
            console.log('⚠️  Max retries exceeded - message will go to DLQ');
            await sqsClient.send(new DeleteMessageCommand({
              QueueUrl: process.env.QUEUE_URL,
              ReceiptHandle: currentReceiptHandle,
            }));
          } else {
            const backoff = Math.min(60 * Math.pow(2, receiveCount - 1), 300);
            console.log(`🔄 Retry in ${backoff}s (attempt ${receiveCount}/3)`);
            
            try {
              await sqsClient.send(new ChangeMessageVisibilityCommand({
                QueueUrl: process.env.QUEUE_URL,
                ReceiptHandle: currentReceiptHandle,
                VisibilityTimeout: backoff
              }));
            } catch (releaseErr) {
              console.warn('⚠️  Visibility change failed:', releaseErr.message);
            }
          }
        } finally {
          currentReceiptHandle = null;
          await protectInstance(false);
        }

      } else {
        emptyPollCount++;
        console.log(`⏰ No messages (${emptyPollCount}/3)`);
        if (emptyPollCount >= 3) {
          await protectInstance(false);
        }
      }

    } catch (error) {
      console.error('❌ Worker loop error:', error);
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }
}

// Graceful shutdown
let isShuttingDown = false;
async function gracefulShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`\n🛑 ${signal} - shutting down...`);
  
  if (currentReceiptHandle) {
    try {
      await sqsClient.send(new ChangeMessageVisibilityCommand({
        QueueUrl: process.env.QUEUE_URL,
        ReceiptHandle: currentReceiptHandle,
        VisibilityTimeout: 0
      }));
      console.log('✅ Message released');
    } catch (e) {
      console.warn('⚠️  Release failed:', e.message);
    }
  }
  
  await new Promise(resolve => setTimeout(resolve, 10000));
  try { await mongoose.connection.close(); console.log('✅ MongoDB closed'); } catch (e) {}
  try { await protectInstance(false); } catch (_) {}
  console.log('👋 Shutdown complete');
  process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('uncaughtException', (error) => {
  console.error('💥 Uncaught Exception:', error);
  gracefulShutdown('UNCAUGHT_EXCEPTION');
});
process.on('unhandledRejection', (reason) => {
  console.error('💥 Unhandled Rejection:', reason);
});

startWorker().catch(err => {
  console.error('❌ Fatal error:', err);
  process.exit(1);
});
JSEOF

chown -R ec2-user:ec2-user $APP_DIR

cat > /etc/systemd/system/cinishine-worker.service << EOF
[Unit]
Description=CiniShine Media Processing Worker v4.2 (Unified Content Model)
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
TimeoutStopSec=60

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable cinishine-worker
systemctl restart cinishine-worker
sleep 5

if systemctl is-active --quiet cinishine-worker; then
  echo "✅ Worker service started successfully"
  systemctl status cinishine-worker --no-pager
else
  echo "❌ Worker service failed to start"
  journalctl -u cinishine-worker -n 100 --no-pager
  exit 1
fi

echo ""
echo "=== Setup completed at $(date) ==="
echo "✅ CiniShine Media Processing Worker v4.2 - UNIFIED CONTENT MODEL"
echo ""
echo "🔄 KEY CHANGES FROM v4.0:"
echo " ❌ Removed separate Video model"
echo " ✅ Uses unified Content model for ALL content types"
echo " ✅ Videos: Content.find({ contentType: 'video' })"
echo " ✅ Shorts: Content.find({ contentType: 'short' })"
echo " ✅ Audio: Content.find({ contentType: 'audio' })"
echo " ✅ Full backward compatibility with existing data"
echo " ✅ Reduced visibility timeout to 600s (10 min)"
echo " ✅ Added exponential backoff retry logic"
echo " ✅ Better error logging and debugging"
echo ""
echo "Supported content types:"
echo " - uploads/  → Long-form videos → Full HLS renditions (144p-1080p)"
echo " - shorts/   → Short videos ≤60s → Optimized vertical HLS (480p-1080p)"
echo " - audio/    → Audio files → AAC 256k + HLS audio stream"
echo ""
echo "S3 Input Structure:"
echo " - uploads/{userId}/{fileId}_*.mp4  → Videos"
echo " - shorts/{userId}/{fileId}_*.mp4   → Shorts"
echo " - audio/{userId}/{fileId}_*.*      → Audio"
echo ""
echo "S3 Output Structure:"
echo " - hls/videos/{userId}/{id}/        → Video HLS"
echo " - hls/shorts/{userId}/{id}/        → Short HLS"
echo " - hls/audio/{userId}/{id}/         → Audio HLS"
echo " - audio/processed/{userId}/        → Processed AAC files"
echo " - thumbnails/videos/{userId}/      → Video thumbnails"
echo " - thumbnails/shorts/{userId}/      → Short thumbnails"
echo ""
echo "Useful commands:"
echo "  sudo journalctl -u cinishine-worker -f          # Watch logs"
echo "  sudo systemctl restart cinishine-worker         # Restart worker"
echo "  sudo systemctl status cinishine-worker          # Check status"
echo ""