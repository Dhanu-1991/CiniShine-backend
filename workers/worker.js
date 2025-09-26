// worker.js (Multi-Rendition HLS Transcoding)
import 'dotenv/config';
import { spawn } from 'child_process';
import Video from '../models/video.model.js';
import fs from 'fs';
import path from 'path';
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand
} from '@aws-sdk/client-s3';
import mongoose from 'mongoose';
import Redis from 'ioredis';
import ffprobeInstaller from '@ffprobe-installer/ffprobe';

const ffprobePath = ffprobeInstaller.path;

console.log("🎬 Video Processing Worker Starting...");
console.log("📊 Environment Configuration:");
console.log("   REDIS_URL:", process.env.REDIS_URL ? "✓ Configured" : "✗ Missing");
console.log("   MONGO_URI:", process.env.MONGO_URI ? "✓ Configured" : "✗ Missing");
console.log("   AWS_REGION:", process.env.AWS_REGION ? "✓ Configured" : "✗ Missing");
console.log("   S3_BUCKET:", process.env.S3_BUCKET ? "✓ Configured" : "✗ Missing");
console.log("🌍 Platform:", process.platform);
console.log("🔍 FFprobe path:", ffprobePath);
console.log("🔍 FFprobe exists:", fs.existsSync(ffprobePath));

// Configure S3 client with enhanced error handling
const s3Client = new S3Client({
  region: process.env.AWS_REGION,
  maxAttempts: 5,
  requestTimeout: 30000,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

// Configure Redis with robust connection handling
const redisClient = new Redis(process.env.REDIS_URL, {
  retryStrategy: (times) => {
    const delay = Math.min(times * 100, 5000);
    console.log(`🔁 Redis reconnecting attempt ${times}, delay: ${delay}ms`);
    return delay;
  },
  maxRetriesPerRequest: 3,
});

redisClient.on('connect', () => console.log('✅ Redis connected successfully'));
redisClient.on('error', (err) => console.error('❌ Redis error:', err));
redisClient.on('close', () => console.log('🔌 Redis connection closed'));

// Connect to MongoDB with enhanced error handling
mongoose.connect(process.env.MONGO_URI, {
  maxPoolSize: 15,
  serverSelectionTimeoutMS: 10000,
  socketTimeoutMS: 45000,
  bufferCommands: false,
}).then(() => {
  console.log('✅ MongoDB connected successfully');
}).catch(err => {
  console.error('❌ MongoDB connection error:', err);
  process.exit(1);
});

// Define all possible renditions (from lowest to highest)
const ALL_RENDITIONS = [
  { resolution: '256x144', bitrate: 200000, audioBitrate: '64k', name: '144p', width: 256, height: 144 },
  { resolution: '426x240', bitrate: 400000, audioBitrate: '64k', name: '240p', width: 426, height: 240 },
  { resolution: '640x360', bitrate: 800000, audioBitrate: '96k', name: '360p', width: 640, height: 360 },
  { resolution: '854x480', bitrate: 1500000, audioBitrate: '128k', name: '480p', width: 854, height: 480 },
  { resolution: '1280x720', bitrate: 2500000, audioBitrate: '128k', name: '720p', width: 1280, height: 720 },
  { resolution: '1920x1080', bitrate: 5000000, audioBitrate: '192k', name: '1080p', width: 1920, height: 1080 }
];

// Select renditions appropriate for input resolution
function getAppropriateRenditions(inputWidth, inputHeight) {
  console.log(`📏 Input video resolution: ${inputWidth}x${inputHeight}`);
  const inputPixels = inputWidth * inputHeight;
  const appropriate = ALL_RENDITIONS.filter(r => (r.width * r.height) <= (inputPixels * 1.1));

  if (appropriate.length === 0) return [ALL_RENDITIONS[0]]; // fallback to smallest
  appropriate.sort((a, b) => (a.width * a.height) - (b.width * b.height));
  console.log(`✅ Selected ${appropriate.length} renditions: ${appropriate.map(r => r.name).join(', ')}`);
  return appropriate;
}

// Get FFmpeg path with comprehensive fallback strategy
async function getFFmpegPath() {
  try {
    console.log('🔍 Searching for FFmpeg installation...');

    if (process.platform === 'win32') {
      // Windows paths
      const possiblePaths = [
        'ffmpeg.exe',
        'C:\\ffmpeg\\bin\\ffmpeg.exe',
        'C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe',
        'C:\\tools\\ffmpeg\\bin\\ffmpeg.exe',
        process.env.FFMPEG_PATH
      ].filter(Boolean);

      for (const possiblePath of possiblePaths) {
        if (fs.existsSync(possiblePath)) {
          console.log(`✅ Found system FFmpeg at: ${possiblePath}`);
          return possiblePath;
        }
      }

      // Fallback to ffmpeg-static
      try {
        const { default: ffmpegStatic } = await import('ffmpeg-static');
        if (fs.existsSync(ffmpegStatic)) {
          console.log(`✅ Using ffmpeg-static at: ${ffmpegStatic}`);
          return ffmpegStatic;
        }
      } catch (error) {
        console.log('⚠️ ffmpeg-static not available');
      }
    } else {
      // Linux/Mac - try system FFmpeg
      try {
        const { execSync } = await import('child_process');
        execSync('which ffmpeg', { stdio: 'ignore' });
        console.log('✅ Using system FFmpeg from PATH');
        return 'ffmpeg';
      } catch (e) {
        console.log('⚠️ System FFmpeg not found in PATH');
      }
    }

    throw new Error(`
❌ FFmpeg not found. Please install FFmpeg:

Windows:
  1. Download from: https://www.gyan.dev/ffmpeg/builds/
  2. Extract to: C:\\ffmpeg
  3. Add C:\\ffmpeg\\bin to your System PATH
  4. Restart terminal and test: ffmpeg -version

Linux (Ubuntu/Debian):
  sudo apt update && sudo apt install ffmpeg

Mac:
  brew install ffmpeg

Or set environment variable:
  export FFMPEG_PATH=/path/to/ffmpeg
    `);
  } catch (error) {
    console.error('❌ Error finding FFmpeg:', error.message);
    throw error;
  }
}

// Windows-compatible temp directory
function getTempDir(fileId) {
  if (process.platform === 'win32') {
    return path.join(process.env.TEMP || 'C:\\Temp', `video-processor-${fileId}`);
  }
  return path.join('/tmp', `video-processor-${fileId}`);
}

// Ensure directory exists with error handling
function ensureDirectoryExists(dirPath) {
  try {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true, mode: 0o755 });
      console.log(`📁 Created directory: ${dirPath}`);
    }
    return true;
  } catch (error) {
    console.error(`❌ Error creating directory ${dirPath}:`, error);
    throw error;
  }
}

// Get video duration and metadata using ffprobe
async function getVideoMetadata(inputPath) {
  return new Promise((resolve, reject) => {
    console.log('📊 Getting video metadata with ffprobe...');

    const args = [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      inputPath
    ];

    const proc = spawn(ffprobePath, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    proc.on('close', (code) => {
      if (code === 0) {
        try {
          const metadata = JSON.parse(stdout);
          const duration = parseFloat(metadata.format.duration);
          const videoStream = metadata.streams.find(s => s.codec_type === 'video');
          const audioStream = metadata.streams.find(s => s.codec_type === 'audio');

          console.log('✅ Video metadata retrieved:');
          console.log(`   Duration: ${duration} seconds`);
          console.log(`   Video codec: ${videoStream?.codec_name || 'unknown'}`);
          console.log(`   Resolution: ${videoStream?.width}x${videoStream?.height || 'unknown'}`);
          console.log(`   Audio codec: ${audioStream?.codec_name || 'unknown'}`);

          resolve({
            duration,
            videoStream,
            audioStream,
            format: metadata.format
          });
        } catch (parseError) {
          console.error('❌ Error parsing ffprobe output:', parseError);
          reject(parseError);
        }
      } else {
        console.error('❌ FFprobe failed with code:', code);
        console.error('FFprobe stderr:', stderr);
        reject(new Error(`FFprobe exited with code ${code}: ${stderr}`));
      }
    });

    proc.on('error', (err) => {
      console.error('❌ FFprobe spawn error:', err);
      reject(err);
    });
  });
}

// Run FFmpeg with comprehensive logging and error handling
async function runFFmpeg(args, options = {}) {
  const ffmpegPath = await getFFmpegPath();

  console.log('🚀 Starting FFmpeg process...');
  console.log(`   Command: ffmpeg ${args.join(' ')}`);

  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    const ffmpeg = spawn(ffmpegPath, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...options
    });

    let stdout = '';
    let stderr = '';
    let progressData = '';

    ffmpeg.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    ffmpeg.stderr.on('data', (data) => {
      const text = data.toString();
      stderr += text;
      progressData += text;

      // Extract and log progress information
      if (text.includes('time=')) {
        const timeMatch = text.match(/time=(\d+:\d+:\d+\.\d+)/);
        if (timeMatch) {
          console.log(`   ⏱️  Processing time: ${timeMatch[1]}`);
        }
      }
    });

    ffmpeg.on('close', (code) => {
      const endTime = Date.now();
      const duration = ((endTime - startTime) / 1000).toFixed(2);

      if (code === 0) {
        console.log(`✅ FFmpeg completed successfully in ${duration}s`);
        resolve({ stdout, stderr });
      } else {
        console.error(`❌ FFmpeg failed after ${duration}s with code: ${code}`);
        console.error('FFmpeg stderr:', stderr);
        reject(new Error(`FFmpeg exited with code ${code}: ${stderr}`));
      }
    });

    ffmpeg.on('error', (err) => {
      console.error('❌ FFmpeg spawn error:', err);
      reject(err);
    });
  });
}

// Delete S3 prefix with comprehensive error handling
async function deleteS3Prefix(prefix) {
  try {
    console.log(`🗑️  Cleaning up S3 prefix: ${prefix}`);

    const list = await s3Client.send(new ListObjectsV2Command({
      Bucket: process.env.S3_BUCKET,
      Prefix: prefix
    }));

    if (!list.Contents || list.Contents.length === 0) {
      console.log('   No files found to delete');
      return;
    }

    console.log(`   Found ${list.Contents.length} files to delete`);

    // Delete in batches of 1000 (S3 limit)
    for (let i = 0; i < list.Contents.length; i += 1000) {
      const batch = list.Contents.slice(i, i + 1000);
      const toDelete = {
        Objects: batch.map(o => ({ Key: o.Key }))
      };

      await s3Client.send(new DeleteObjectsCommand({
        Bucket: process.env.S3_BUCKET,
        Delete: toDelete
      }));

      console.log(`   Deleted batch ${Math.floor(i / 1000) + 1}`);
    }

    console.log('✅ S3 cleanup completed');
  } catch (error) {
    console.error('❌ Error deleting S3 prefix:', error);
    // Don't throw error for cleanup failures
  }
}

// Upload file to S3 with retry logic
async function uploadToS3(filePath, s3Key, contentType, cacheControl) {
  try {
    console.log(`   Uploading: ${s3Key}`);

    const fileStream = fs.createReadStream(filePath);
    await s3Client.send(new PutObjectCommand({
      Bucket: process.env.S3_BUCKET,
      Key: s3Key,
      Body: fileStream,
      ContentType: contentType,
      CacheControl: cacheControl,
    }));

    console.log(`   ✅ Uploaded: ${s3Key}`);
  } catch (error) {
    console.error(`   ❌ Failed to upload ${s3Key}:`, error);
    throw error;
  }
}

// Process video with multi-rendition HLS transcoding
async function processVideo(fileId) {
  console.log(`\n🎬 Starting video processing for: ${fileId}`);
  console.log('═'.repeat(60));

  let video;
  let tempDir;

  try {
    // 1. Fetch video document from database
    console.log('📊 Fetching video document from database...');
    video = await Video.findById(fileId);
    if (!video) {
      throw new Error(`Video ${fileId} not found in database`);
    }
    console.log('✅ Video document fetched');

    // 2. Update video status to processing
    await Video.findByIdAndUpdate(fileId, {
      status: 'processing',
      processingStart: new Date(),
      error: null
    });
    console.log('✅ Video status updated to "processing"');

    // 3. Create temporary directories
    tempDir = getTempDir(fileId);
    const inputPath = path.join(tempDir, 'input');
    const outputDir = path.join(tempDir, 'hls');
    const thumbnailPath = path.join(tempDir, 'thumbnail.jpg');

    ensureDirectoryExists(tempDir);
    ensureDirectoryExists(outputDir);
    console.log(`✅ Temporary directories created at: ${tempDir}`);

    // 4. Download video from S3
    console.log('📥 Downloading video from S3...');
    const downloadCommand = new GetObjectCommand({
      Bucket: process.env.S3_BUCKET,
      Key: video.originalKey,
    });

    const { Body } = await s3Client.send(downloadCommand);
    const writeStream = fs.createWriteStream(inputPath);

    await new Promise((resolve, reject) => {
      Body.pipe(writeStream)
        .on('finish', resolve)
        .on('error', reject);
    });

    // Verify download
    if (!fs.existsSync(inputPath)) {
      throw new Error('Failed to download video file from S3');
    }
    const fileStats = fs.statSync(inputPath);
    console.log(`✅ Video downloaded successfully (${(fileStats.size / 1024 / 1024).toFixed(2)} MB)`);

    // 5. Get video metadata
    console.log('📊 Analyzing video metadata...');
    const metadata = await getVideoMetadata(inputPath);
    const { duration, videoStream } = metadata;

    // 6. Generate thumbnail
    console.log('🖼️ Generating thumbnail...');
    await runFFmpeg([
      '-i', inputPath,
      '-ss', '00:00:05',
      '-vframes', '1',
      '-vf', 'scale=320:-1',
      '-y',
      thumbnailPath
    ], { logStderr: true });
    console.log('✅ Thumbnail generated');

    // 7. Multi-rendition HLS transcoding (adaptive)
    const renditionsToGenerate = getAppropriateRenditions(videoStream.width, videoStream.height);
    console.log(`🎥 Starting multi-rendition HLS transcoding for ${renditionsToGenerate.length} renditions...`);

    // Build filter complex for adaptive renditions
    const filterComplex = renditionsToGenerate.map((_, i) =>
      `[v${i}]scale=${renditionsToGenerate[i].resolution}[v${i}out]`
    ).join('; ');

    const baseFilter = `[0:v]split=${renditionsToGenerate.length}${renditionsToGenerate.map((_, i) => `[v${i}]`).join('')}; `;
    const fullFilterComplex = baseFilter + filterComplex;

    // Build FFmpeg arguments for multi-rendition HLS
    const ffmpegArgs = [
      '-hide_banner',
      '-y',
      '-i', inputPath,
      '-filter_complex', fullFilterComplex,
    ];

    // Add video and audio mapping for each rendition
    renditionsToGenerate.forEach((rendition, i) => {
      ffmpegArgs.push(
        '-map', `[v${i}out]`,
        '-c:v:' + i, 'libx264',
        '-b:v:' + i, rendition.bitrate.toString(),
        '-maxrate:v:' + i, (rendition.bitrate * 1.5).toString(),
        '-bufsize:v:' + i, (rendition.bitrate * 2).toString(),
        '-preset', 'medium',
        '-crf', '23',
        '-map', '0:a:0',
        '-c:a:' + i, 'aac',
        '-b:a:' + i, rendition.audioBitrate,
        '-ac', '2'
      );
    });

    // Add HLS options
    ffmpegArgs.push(
      '-f', 'hls',
      '-hls_time', '6',
      '-hls_list_size', '0',
      '-hls_playlist_type', 'vod',
      '-hls_segment_filename', path.join(outputDir, 'stream_%v', 'segment%03d.ts'),
      '-master_pl_name', 'master.m3u8',
      '-var_stream_map', renditionsToGenerate.map((_, i) => `v:${i},a:${i},name:${renditionsToGenerate[i].name}`).join(' '),
      path.join(outputDir, 'stream_%v', 'playlist.m3u8')
    );

    await runFFmpeg(ffmpegArgs, { logStderr: true });
    console.log('✅ Multi-rendition HLS transcoding completed');

    // 8. Upload HLS files to S3
    console.log('☁️ Uploading HLS files to S3...');

    // Upload master playlist
    const masterKey = `hls/${video.userId}/${fileId}/master.m3u8`;
    await uploadToS3(
      path.join(outputDir, 'master.m3u8'),
      masterKey,
      'application/vnd.apple.mpegurl',
      'max-age=300'
    );

    // Upload each rendition's files
    for (let i = 0; i < renditionsToGenerate.length; i++) {
      const streamDir = path.join(outputDir, `stream_${i}`);
      if (!fs.existsSync(streamDir)) {
        console.log(`   ⚠️ Stream directory not found: ${streamDir}`);
        continue;
      }

      console.log(`   Uploading rendition ${i + 1}/${renditionsToGenerate.length}: ${renditionsToGenerate[i].name}`);

      const files = fs.readdirSync(streamDir);
      for (const file of files) {
        const filePath = path.join(streamDir, file);
        const fileKey = `hls/${video.userId}/${fileId}/stream_${i}/${file}`;
        const contentType = file.endsWith('.m3u8')
          ? 'application/vnd.apple.mpegurl'
          : 'video/MP2T';
        const cacheControl = file.endsWith('.ts')
          ? 'max-age=2592000'  // 30 days for segments
          : 'max-age=300';     // 5 minutes for playlists

        await uploadToS3(filePath, fileKey, contentType, cacheControl);
      }
    }

    // 9. Upload thumbnail
    console.log('🖼️ Uploading thumbnail...');
    const thumbnailKey = `thumbnails/${video.userId}/${fileId}.jpg`;
    await uploadToS3(
      thumbnailPath,
      thumbnailKey,
      'image/jpeg',
      'max-age=2592000'
    );

    // 10. Prepare renditions data for database
    const renditions = renditionsToGenerate.map((rendition, i) => ({
      resolution: rendition.resolution,
      bitrate: rendition.bitrate,
      name: rendition.name,
      playlistKey: `hls/${video.userId}/${fileId}/stream_${i}/playlist.m3u8`,
      codecs: 'avc1.42e01e,mp4a.40.2'
    }));

    // 11. Update database with complete information
    console.log('💾 Updating database...');
    await Video.findByIdAndUpdate(fileId, {
      status: 'completed',
      hlsMasterKey: masterKey,
      thumbnailKey,
      duration,
      renditions,
      processingEnd: new Date(),
      'metadata.originalResolution': `${videoStream.width}x${videoStream.height}`,
      'metadata.originalCodec': videoStream.codec_name,
      'sizes.processed': await getDirectorySize(outputDir),
    });

    console.log('✅ Database updated successfully');
    console.log(`🎉 Video processing completed: ${fileId}`);
    console.log('═'.repeat(60));

  } catch (error) {
    console.error(`\n❌ Error processing video ${fileId}:`, error);

    // Clean up any uploaded files on error
    if (video && video.userId && fileId) {
      console.log('🧹 Cleaning up uploaded files due to error...');
      await deleteS3Prefix(`hls/${video.userId}/${fileId}/`);
      await deleteS3Prefix(`thumbnails/${video.userId}/${fileId}`);
    }

    // Update video status to failed
    if (video) {
      await Video.findByIdAndUpdate(fileId, {
        status: 'failed',
        error: error.message,
        processingEnd: new Date()
      });
    }

    throw error;
  } finally {
    // Clean up temporary files
    if (tempDir && fs.existsSync(tempDir)) {
      try {
        console.log('🧹 Cleaning up temporary files...');
        fs.rmSync(tempDir, { recursive: true, force: true });
        console.log('✅ Temporary files cleaned up');
      } catch (cleanupError) {
        console.error('❌ Error cleaning up temp files:', cleanupError);
      }
    }
  }
}

// Helper function to calculate directory size
async function getDirectorySize(dirPath) {
  let totalSize = 0;

  function calculateSize(currentPath) {
    const stats = fs.statSync(currentPath);
    if (stats.isFile()) {
      totalSize += stats.size;
    } else if (stats.isDirectory()) {
      fs.readdirSync(currentPath).forEach(file => {
        calculateSize(path.join(currentPath, file));
      });
    }
  }

  if (fs.existsSync(dirPath)) {
    calculateSize(dirPath);
  }
  return totalSize;
}

// Main worker loop with concurrency control
async function processVideoWorker() {
  console.log('\n🚀 Starting video processing worker...');
  console.log('═'.repeat(60));

  // Test FFmpeg availability
  try {
    await getFFmpegPath();
    console.log('✅ FFmpeg is available and working');
  } catch (error) {
    console.error('❌ FFmpeg initialization failed:', error.message);
    process.exit(1);
  }

  const MAX_CONCURRENT_JOBS = 2; // Adjust based on system capabilities
  let activeJobs = 0;
  let processedJobs = 0;

  console.log(`⚙️ Worker configuration:`);
  console.log(`   Max concurrent jobs: ${MAX_CONCURRENT_JOBS}`);
  console.log(`   Redis queue: video-processing-queue`);
  console.log('═'.repeat(60));

  while (true) {
    try {
      if (activeJobs >= MAX_CONCURRENT_JOBS) {
        console.log(`⏳ Maximum concurrent jobs reached (${activeJobs}/${MAX_CONCURRENT_JOBS}), waiting...`);
        await new Promise(resolve => setTimeout(resolve, 5000));
        continue;
      }

      console.log('📭 Waiting for job from Redis queue (30s timeout)...');
      const result = await redisClient.brpop('video-processing-queue', 30);

      if (result) {
        const fileId = result[1];
        processedJobs++;
        activeJobs++;

        console.log(`\n📥 Received job #${processedJobs}: ${fileId}`);
        console.log(`   Active jobs: ${activeJobs}`);
        console.log(`   Total processed: ${processedJobs}`);

        // Process job asynchronously
        processVideo(fileId)
          .then(() => {
            console.log(`✅ Job ${fileId} completed successfully`);
          })
          .catch(error => {
            console.error(`❌ Job ${fileId} failed:`, error.message);
          })
          .finally(() => {
            activeJobs--;
            console.log(`   Active jobs: ${activeJobs}`);
          });
      } else {
        console.log('⏰ Queue timeout, checking for new jobs...');
      }
    } catch (error) {
      console.error('❌ Error in worker loop:', error);
      console.log('🔄 Retrying in 5 seconds...');
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }
}

// Graceful shutdown handling
let isShuttingDown = false;

async function gracefulShutdown() {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log('\n🛑 Received shutdown signal, initiating graceful shutdown...');
  console.log('⏳ Waiting for active jobs to complete...');

  // Give some time for active jobs to complete
  await new Promise(resolve => setTimeout(resolve, 10000));

  try {
    await redisClient.quit();
    console.log('✅ Redis connection closed');
  } catch (error) {
    console.error('❌ Error closing Redis connection:', error);
  }

  try {
    await mongoose.connection.close();
    console.log('✅ MongoDB connection closed');
  } catch (error) {
    console.error('❌ Error closing MongoDB connection:', error);
  }

  console.log('👋 Worker shutdown completed');
  process.exit(0);
}

process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);
process.on('uncaughtException', (error) => {
  console.error('💥 Uncaught Exception:', error);
  gracefulShutdown();
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('💥 Unhandled Rejection at:', promise, 'reason:', reason);
});

// Start the worker
if (process.argv[1].endsWith('worker.js')) {
  processVideoWorker().catch(console.error);
}

export { processVideo, processVideoWorker };