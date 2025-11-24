#!/bin/bash
set -e

# Production Video Processing Worker Setup - STABLE HLS FOR LARGE VIDEOS
# Keeps SQS + systemd framework. Applies safer FFmpeg profile, better logging,
# progress output, and temp-dir selection to avoid 0-byte master playlist issues.

REGION="eu-north-1"
BUCKET_NAME="cinishine"
QUEUE_URL="https://sqs.eu-north-1.amazonaws.com/107597587874/video-processing-queue"
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
echo "=== CiniShine Production Worker Setup - $(date) ==="
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
  "version": "3.0.0",
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
VISIBILITY_TIMEOUT=3600
NODE_ENV=production
LOG_LEVEL=info
EOF

mkdir -p models
cat > models/video.model.js << 'JSEOF'
import mongoose from 'mongoose';

const videoSchema = new mongoose.Schema({
  title: String,
  originalKey: String,
  userId: String,
  status: {
    type: String,
    enum: ['uploaded', 'processing', 'completed', 'failed'],
    default: 'uploaded'
  },
  hlsMasterKey: String,
  thumbnailKey: String,
  duration: Number,
  renditions: [{
    resolution: String,
    bitrate: Number,
    name: String,
    playlistKey: String,
    codecs: String
  }],
  processingStart: Date,
  processingEnd: Date,
  error: String,
  metadata: {
    originalResolution: String,
    originalCodec: String,
    hasAudio: Boolean,
    videoCodec: String,
    audioCodec: String
  },
  sizes: {
    original: Number,
    processed: Number
  }
}, {
  timestamps: true
});

export default mongoose.model('Video', videoSchema);
JSEOF

mkdir -p workers
cat > workers/worker.js << 'JSEOF'
import 'dotenv/config';
import { spawn, execSync } from 'child_process';
import Video from '../models/video.model.js';
import fs from 'fs';
import path from 'path';
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  HeadObjectCommand,
  GetBucketLocationCommand
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

console.log("🎬 CiniShine Production Worker v3.0 - STABLE HLS");
console.log("📊 Configuration:");
console.log("   MONGO_URI:", process.env.MONGO_URI ? "✓" : "✗");
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

const ALL_RENDITIONS = [
  { resolution: '256x144', bitrate: 200000, audioBitrate: '128k', name: '144p', width: 256, height: 144 },
  { resolution: '426x240', bitrate: 400000, audioBitrate: '128k', name: '240p', width: 426, height: 240 },
  { resolution: '640x360', bitrate: 800000, audioBitrate: '128k', name: '360p', width: 640, height: 360 },
  { resolution: '854x480', bitrate: 1500000, audioBitrate: '128k', name: '480p', width: 854, height: 480 },
  { resolution: '1280x720', bitrate: 2500000, audioBitrate: '128k', name: '720p', width: 1280, height: 720 },
  { resolution: '1920x1080', bitrate: 5000000, audioBitrate: '128k', name: '1080p', width: 1920, height: 1080 }
];

function getAppropriateRenditions(inputWidth, inputHeight) {
  console.log(`📏 Input: ${inputWidth}x${inputHeight}`);
  const inputPixels = inputWidth * inputHeight;
  const appropriate = ALL_RENDITIONS.filter(r => (r.width * r.height) <= (inputPixels * 1.1));
  if (appropriate.length === 0) return [ALL_RENDITIONS[0]];
  appropriate.sort((a, b) => (a.width * a.height) - (b.width * b.height));
  console.log(`✅ Selected: ${appropriate.map(r => r.name).join(', ')}`);
  return appropriate;
}

async function getFFmpegPath() {
  try {
    execSync('which ffmpeg', { stdio: 'ignore' });
    return 'ffmpeg';
  } catch {
    throw new Error('FFmpeg not found in PATH');
  }
}

// choose temp base: prefer /mnt if it exists and has >5GB free, else /tmp
function chooseTempBase() {
  return '/tmp';
}

function getTempDir(fileId) {
  const base = chooseTempBase();
  return path.join(base, `video-processor-${fileId}-${Date.now()}`);
}

function ensureDirectoryExists(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true, mode: 0o755 });
    console.log(`📁 Created: ${dirPath}`);
  }
}

async function getVideoMetadata(inputPath) {
  return new Promise((resolve, reject) => {
    console.log('📊 Analyzing video with FFprobe...');
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
          if (!videoStream) return reject(new Error('No video stream found'));
          console.log('✅ Metadata:');
          console.log(`   Duration: ${parseFloat(metadata.format.duration).toFixed(2)}s`);
          console.log(`   Video: ${videoStream.codec_name} ${videoStream.width}x${videoStream.height}`);
          console.log(`   Audio: ${audioStream ? audioStream.codec_name : 'NONE'}`);
          resolve({
            duration: parseFloat(metadata.format.duration),
            videoStream,
            audioStream,
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

  // Log first part of command to avoid huge log lines
  console.log(`🚀 FFmpeg command (first 12 args): ${args.slice(0, 12).join(' ')}...`);

  return new Promise((resolve, reject) => {
    const startTime = Date.now();

    // spawn and capture both stdout+stderr; we add progress via -progress pipe:2 in args
    const ffmpeg = spawn(ffmpegPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      ...options
    });

    let stderr = '';
    let lastProgress = '';
    let lastLogTime = 0;
    let hasError = false;

    ffmpeg.stdout.on('data', (chunk) => {
      // some builds may emit progress to stdout if pipe:1 used
      const text = chunk.toString();
      // optionally parse progress if needed
    });

    ffmpeg.stderr.on('data', (data) => {
      const text = data.toString();
      stderr += text;

      // parse classic ffmpeg progress lines (time=...) for human-readable progress
      if (text.includes('time=')) {
        const m = text.match(/time=(\d+:\d+:\d+\.\d+)/);
        if (m && m[1] !== lastProgress) {
          lastProgress = m[1];
          const now = Date.now();
          if (now - lastLogTime > 2000) { // log at most every 2s
            console.log(`   ⏱️  Progress: ${lastProgress}`);
            lastLogTime = now;
          }
        }
      }

      // catch fatal errors early
      if (text.match(/(Error|Invalid|No such file or directory|Broken pipe)/i)) {
        hasError = true;
        console.error('⚠️  FFmpeg stderr flagged an error:', text.substring(0, 300));
      }
    });

    ffmpeg.on('close', (code) => {
      const duration = ((Date.now() - startTime) / 1000).toFixed(2);
      // Always print the tail of stderr (helps debugging even on success)
      if (stderr && stderr.length > 0) {
        const tail = stderr.slice(-1500);
        console.log('--- FFmpeg STDERR (tail) ---');
        console.log(tail);
        console.log('--- end stderr ---');
      }

      if (code !== 0 || hasError) {
        console.error('❌ FFmpeg FAILED or produced fatal messages');
        return reject(new Error(`FFmpeg failed with code ${code}. See stderr above.`));
      }

      console.log(`✅ FFmpeg completed in ${duration}s`);
      resolve({ stderr, duration });
    });

    ffmpeg.on('error', (err) => {
      console.error('❌ FFmpeg spawn error:', err);
      reject(err);
    });
  });
}

// Upload with verification (small, robust version)
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

      // Verify size
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

async function validateHLSOutput(outputDir, renditionCount, hasAudio) {
  console.log('🔍 Validating HLS output...');
  const masterPath = path.join(outputDir, 'master.m3u8');
  if (!fs.existsSync(masterPath)) {
    const files = fs.existsSync(outputDir) ? fs.readdirSync(outputDir) : [];
    throw new Error(`Master playlist not created. Files: ${files.join(', ')}`);
  }
  const masterStats = fs.statSync(masterPath);
  if (masterStats.size === 0) {
    const files = fs.readdirSync(outputDir);
    const info = files.map(f => {
      const p = path.join(outputDir, f);
      const s = fs.statSync(p);
      return `${f}: ${s.isDirectory() ? 'DIR' : s.size+' bytes'}`;
    }).join(', ');
    throw new Error(`Master playlist is EMPTY; output contents: ${info}`);
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
    const playlistPath = path.join(dirPath, 'playlist.m3u8');
    if (!fs.existsSync(playlistPath)) throw new Error(`Missing playlist ${dir}/playlist.m3u8`);
    const playlistContent = fs.readFileSync(playlistPath, 'utf8');
    if (!playlistContent.includes('#EXTM3U')) throw new Error(`Invalid playlist for ${dir}`);
    const segments = fs.readdirSync(dirPath).filter(f => f.endsWith('.ts'));
    if (segments.length === 0) throw new Error(`No .ts segments for ${dir}`);
    totalSegments += segments.length;
    console.log(`   ✅ ${dir}: ${segments.length} segments`);
  }
  console.log(`✅ Validation passed: ${totalSegments} total segments`);
  return { renditionDirs, totalSegments };
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
      VisibilityTimeout: parseInt(process.env.VISIBILITY_TIMEOUT || '3600', 10)
    }));
    console.log('⏰ Extended visibility');
  } catch (err) {
    console.error('⚠️  Visibility extension failed:', err.message);
  }
}

async function processVideo(fileId, receiptHandle) {
  console.log(`\n🎬 Processing: ${fileId}`);
  console.log('═'.repeat(70));

  let tempDir;
  let visibilityExtender;
  const processStart = Date.now();

  try {
    const video = await Video.findById(fileId);
    if (!video) throw new Error(`Video ${fileId} not found`);

    await Video.findByIdAndUpdate(fileId, { status: 'processing', processingStart: new Date(), error: null });

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
      Key: video.originalKey,
    }));

    await new Promise((resolve, reject) => {
      const ws = fs.createWriteStream(inputPath);
      Body.pipe(ws).on('finish', resolve).on('error', reject);
    });

    const fileStats = fs.statSync(inputPath);
    console.log(`✅ Downloaded ${(fileStats.size/1024/1024).toFixed(2)} MB`);

    const metadata = await getVideoMetadata(inputPath);
    const { duration, videoStream, hasAudio } = metadata;

    const estMin = Math.ceil(duration / 60 * 1.5);
    console.log(`⏱️  Duration: ${Math.floor(duration/60)}m ${Math.floor(duration%60)}s`);
    console.log(`⏱️  Estimated: ~${estMin} min`);

    console.log('🖼️  Generating thumbnail...');
    await runFFmpeg([
  '-ss','5',
  '-i', inputPath,
  '-frames:v','1',
  '-vf','scale=320:-2',
  '-q:v','2',
  '-update','1',
  '-y',
  thumbnailPath
]);


    const renditions = getAppropriateRenditions(videoStream.width, videoStream.height);
    console.log(`🎥 Transcoding ${renditions.length} renditions (Audio: ${hasAudio ? 'YES' : 'NO'})...`);

    
    // Build simple filter_complex
    const filterComplex = renditions.map((r, i) => `[v${i}]scale=${r.resolution}[v${i}out]`).join('; ');
    const baseFilter = `[0:v]split=${renditions.length}${renditions.map((_, i) => `[v${i}]`).join('')}; `;

    const ffmpegArgs = [
      '-hide_banner',
      '-loglevel','info',
      '-progress','pipe:2',
      '-y',
      '-i', inputPath,
      '-filter_complex', baseFilter + filterComplex,
    ];

    // Map video & audio for each rendition, include rate control and crf
    renditions.forEach((rendition, i) => {
      ffmpegArgs.push(
        '-map', `[v${i}out]`,
        '-c:v:' + i, 'libx264',
        '-b:v:' + i, rendition.bitrate.toString(),
        '-maxrate:v:' + i, Math.round(rendition.bitrate * 1.5).toString(),
        '-bufsize:v:' + i, Math.round(rendition.bitrate * 2).toString(),
        '-preset','medium',
        '-crf','23',
        '-profile:v:' + i, 'main',
        '-g:v:' + i, '48',
        '-keyint_min:v:' + i, '48',
        '-sc_threshold:v:' + i, '0'
      );

      if (hasAudio) {
        // map audio and force stereo / sample rate
        ffmpegArgs.push(
          '-map', '0:a:0?',
          '-c:a:' + i, 'aac',
          '-b:a:' + i, rendition.audioBitrate,
          '-ar:a:' + i, '48000',
          '-ac:a:' + i, '2'
        );
      }
    });

    // HLS options
    ffmpegArgs.push(
      '-f','hls',
      '-hls_time','6',
      '-hls_list_size','0',
      '-hls_playlist_type','vod',
      '-hls_flags','independent_segments',
      '-hls_segment_type','mpegts',
      '-hls_segment_filename', path.join(outputDir, 'stream_%v', 'segment%03d.ts'),
      '-master_pl_name', 'master.m3u8'
    );

    const varStreamMap = renditions.map((r, i) => hasAudio ? `v:${i},a:${i},name:${r.name}` : `v:${i},name:${r.name}`).join(' ');
    ffmpegArgs.push('-var_stream_map', varStreamMap, path.join(outputDir, 'stream_%v', 'playlist.m3u8'));

    console.log('🎬 Starting FFmpeg transcoding...');
    await runFFmpeg(ffmpegArgs);
    console.log('✅ Transcoding complete');

    // Validate outputs BEFORE upload
    const validation = await validateHLSOutput(outputDir, renditions.length, hasAudio);

    console.log('☁️  Uploading to S3...');
    let uploadCount = 0;

    const masterKey = `hls/${video.userId}/${fileId}/master.m3u8`;
    await uploadToS3WithRetry(path.join(outputDir, 'master.m3u8'), masterKey, 'application/vnd.apple.mpegurl', 'max-age=300');
    uploadCount++;

    for (const dir of validation.renditionDirs) {
      const dirPath = path.join(outputDir, dir);
      const files = fs.readdirSync(dirPath).sort();
      console.log(`   📁 Uploading ${dir} (${files.length} files)...`);
      for (const file of files) {
        const filePath = path.join(dirPath, file);
        const fileKey = `hls/${video.userId}/${fileId}/${dir}/${file}`;
        const contentType = file.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/MP2T';
        const cacheControl = file.endsWith('.ts') ? 'max-age=31536000' : 'max-age=300';
        await uploadToS3WithRetry(filePath, fileKey, contentType, cacheControl);
        uploadCount++;
      }
    }

    const thumbnailKey = `thumbnails/${video.userId}/${fileId}.jpg`;
    await uploadToS3WithRetry(thumbnailPath, thumbnailKey, 'image/jpeg', 'max-age=31536000');
    uploadCount++;

    // Update DB
    await Video.findByIdAndUpdate(fileId, {
      status: 'completed',
      hlsMasterKey: masterKey,
      thumbnailKey,
      duration,
      renditions: renditions.map((r, i) => ({
        resolution: r.resolution,
        bitrate: r.bitrate,
        name: r.name,
        playlistKey: `hls/${video.userId}/${fileId}/stream_${i}/playlist.m3u8`,
        codecs: hasAudio ? 'avc1.640028,mp4a.40.2' : 'avc1.640028'
      })),
      processingEnd: new Date(),
      'metadata.originalResolution': `${videoStream.width}x${videoStream.height}`,
      'metadata.originalCodec': videoStream.codec_name,
      'metadata.hasAudio': hasAudio,
      'sizes.original': fileStats.size
    });

    const totalMinutes = ((Date.now() - processStart) / 1000 / 60).toFixed(2);
    console.log(`✅ COMPLETE: ${fileId} in ${totalMinutes} min`);
    console.log('═'.repeat(70));
    return { success: true, uploadCount };

  } catch (error) {
    console.error('❌ ERROR:', error.message);
    await Video.findByIdAndUpdate(fileId, {
      status: 'failed',
      error: error.message,
      processingEnd: new Date()
    }).catch(e => console.error('DB update failed:', e));
    throw error;
  } finally {
    if (visibilityExtender) clearInterval(visibilityExtender);
    if (tempDir && fs.existsSync(tempDir)) {
      try {
        console.log('🧹 Cleaning temp files...');
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch (err) {
        console.error('⚠️ Cleanup failed:', err.message);
      }
    }
  }
}

async function checkQueueEmpty() {
  try {
    const result = await sqsClient.send(new GetQueueAttributesCommand({
      QueueUrl: process.env.QUEUE_URL,
      AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible']
    }));
    const visible = parseInt(result.Attributes.ApproximateNumberOfMessages || '0');
    const notVisible = parseInt(result.Attributes.ApproximateNumberOfMessagesNotVisible || '0');
    return visible === 0 && notVisible === 0;
  } catch (err) {
    console.error('⚠️  Queue check failed:', err.message);
    return false;
  }
}

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

  let processedCount = 0;
  let failedCount = 0;
  let emptyPollCount = 0;

  while (true) {
    try {
      console.log(`\n🔭 Polling SQS [Processed: ${processedCount}, Failed: ${failedCount}]`);
      const result = await sqsClient.send(new ReceiveMessageCommand({
        QueueUrl: process.env.QUEUE_URL,
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: 20,
        VisibilityTimeout: parseInt(process.env.VISIBILITY_TIMEOUT || '3600', 10),
        AttributeNames: ['All']
      }));

      if (result.Messages && result.Messages.length > 0) {
        emptyPollCount = 0;
        const message = result.Messages[0];
        currentReceiptHandle = message.ReceiptHandle;

        let videoId, userId, s3Key;
        try {
          const body = JSON.parse(message.Body);
          s3Key = body.key || body.s3Key;
          if (!s3Key) throw new Error('No S3 key in message');
          const parts = s3Key.split('/');
          if (parts.length < 3) throw new Error('Invalid S3 key');
          userId = parts[1];
          const fileName = parts[2];
          videoId = fileName.split('_')[0];
        } catch (parseError) {
          console.error('❌ Invalid message:', parseError.message);
          await sqsClient.send(new DeleteMessageCommand({
            QueueUrl: process.env.QUEUE_URL,
            ReceiptHandle: currentReceiptHandle,
          }));
          currentReceiptHandle = null;
          continue;
        }

        processedCount++;
        console.log(`\n📥 Job #${processedCount}: ${videoId}`);
        console.log(`   User: ${userId}`);
        console.log(`   S3 Key: ${s3Key}`);

        await protectInstance(true);

        try {
          await processVideo(videoId, currentReceiptHandle);
          await sqsClient.send(new DeleteMessageCommand({
            QueueUrl: process.env.QUEUE_URL,
            ReceiptHandle: currentReceiptHandle,
          }));
          console.log(`✅ Job ${videoId} complete, message deleted`);
        } catch (err) {
          console.error(`❌ Job ${videoId} FAILED:`, err.message);
          failedCount++;
          try {
            await sqsClient.send(new ChangeMessageVisibilityCommand({
              QueueUrl: process.env.QUEUE_URL,
              ReceiptHandle: currentReceiptHandle,
              VisibilityTimeout: 0
            }));
            console.log('🔁 Message released (visibility=0)');
          } catch (releaseErr) {
            console.warn('⚠️ Release failed:', releaseErr.message);
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

let isShuttingDown = false;
async function gracefulShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`\n🛑 ${signal} - shutting down...`);
  if (currentReceiptHandle) {
    try {
      console.log('🔁 Releasing current message');
      await sqsClient.send(new ChangeMessageVisibilityCommand({
        QueueUrl: process.env.QUEUE_URL,
        ReceiptHandle: currentReceiptHandle,
        VisibilityTimeout: 0
      }));
      console.log('✅ Message released');
    } catch (e) {
      console.warn('⚠️ Release failed:', e.message);
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
Description=CiniShine Production Video Worker v3.0
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
echo "✅ CiniShine Production Worker v3.0 - STABLE HLS"
echo ""
echo "Key fixes applied:"
echo " - Per-rendition rate control: -maxrate & -bufsize + -crf 23"
echo " - FFmpeg progress: -progress pipe:2 and -loglevel info (stderr tail logged)"
echo " - Prefer /mnt for temp storage when available (>5GB)"
echo " - Pre-create stream_* directories before FFmpeg runs"
echo " - Validation checks and upload verification"
echo ""
echo "Useful commands:"
echo "  sudo journalctl -u cinishine-worker -f"
echo "  sudo systemctl restart cinishine-worker"
echo ""
