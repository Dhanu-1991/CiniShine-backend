// worker.js (Production-ready implementation)
import 'dotenv/config'; // this loads environment variables from .env
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
import ffmpegPath from 'ffmpeg-static';
import ffprobe from 'ffprobe-static';

// ffprobePath equivalent
const ffprobePath = ffprobe.path;


// Configure S3 client
const s3Client = new S3Client({
  region: process.env.AWS_REGION,
  maxAttempts: 3,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

// Configure Redis with connection handling
const redisClient = new Redis(process.env.REDIS_URL, {
  retryStrategy: (times) => {
    const delay = Math.min(times * 50, 2000);
    return delay;
  },
});

// Connect to MongoDB with better error handling
mongoose.connect(process.env.MONGO_URI, {
  maxPoolSize: 10,
  serverSelectionTimeoutMS: 5000,
  socketTimeoutMS: 45000,
}).catch(err => {
  console.error('MongoDB connection error:', err);
  process.exit(1);
});

// Ensure directory exists
function ensureDirectoryExists(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

// Delete S3 prefix correctly
async function deleteS3Prefix(prefix) {
  try {
    const list = await s3Client.send(new ListObjectsV2Command({
      Bucket: process.env.S3_BUCKET,
      Prefix: prefix
    }));

    if (!list.Contents || list.Contents.length === 0) return;

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
    }
  } catch (error) {
    console.error('Error deleting S3 prefix:', error);
  }
}

// Run ffmpeg with spawn (not exec)
function runFFmpeg(args, options = {}) {
  return new Promise((resolve, reject) => {
    console.log('Running ffmpeg with args:', args.join(' '));

    const ffmpeg = spawn(ffmpegPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      ...options
    });

    let stdout = '';
    let stderr = '';

    ffmpeg.stdout.on('data', (data) => {
      stdout += data.toString();
      if (options.logStdout) {
        console.log('ffmpeg stdout:', data.toString());
      }
    });

    ffmpeg.stderr.on('data', (data) => {
      stderr += data.toString();
      if (options.logStderr) {
        console.log('ffmpeg stderr:', data.toString());
      }
    });

    ffmpeg.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`FFmpeg exited with code ${code}: ${stderr}`));
      }
    });

    ffmpeg.on('error', (err) => {
      reject(err);
    });
  });
}

// Process video with HLS transcoding
async function processVideo(fileId) {
  console.log(`Processing video: ${fileId}`);

  const video = await Video.findById(fileId);
  if (!video) {
    console.error(`Video ${fileId} not found in database`);
    return;
  }

  let tempDir;

  try {
    // Update video status and record start time
    await Video.findByIdAndUpdate(fileId, {
      status: 'processing',
      processingStart: new Date()
    });

    // Create temporary directories
    tempDir = `/tmp/${fileId}`;
    const inputPath = path.join(tempDir, 'input');
    const outputDir = path.join(tempDir, 'hls');
    const thumbnailPath = path.join(tempDir, 'thumbnail.jpg');

    ensureDirectoryExists(tempDir);
    ensureDirectoryExists(outputDir);

    // Download from S3 using streaming
    console.log(`Downloading video ${fileId} from S3`);
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

    // Get video duration using ffprobe
    console.log(`Getting video duration for ${fileId}`);
    const { stdout: probeOutput } = await runFFmpeg([
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_format',
      inputPath
    ], { logStderr: true });

    const probeData = JSON.parse(probeOutput);
    const duration = parseFloat(probeData.format.duration);

    // Generate thumbnail
    console.log(`Generating thumbnail for ${fileId}`);
    await runFFmpeg([
      '-i', inputPath,
      '-ss', '00:00:05',
      '-vframes', '1',
      '-vf', 'scale=320:-1',
      '-y',
      thumbnailPath
    ], { logStderr: true });

    // Transcode to HLS with multiple renditions (including 1080p)
    console.log(`Transcoding video ${fileId} to HLS`);

    const ffmpegArgs = [
      '-hide_banner',
      '-y',
      '-i', inputPath,
      '-filter_complex',
      // 5 variants: 240p, 360p, 480p, 720p, 1080p
      '[0:v]split=5[v0][v1][v2][v3][v4];' +
      '[v0]scale=w=426:h=240[v0out];' +
      '[v1]scale=w=640:h=360[v1out];' +
      '[v2]scale=w=854:h=480[v2out];' +
      '[v3]scale=w=1280:h=720[v3out];' +
      '[v4]scale=w=1920:h=1080[v4out]',
      // Variant 0: 240p
      '-map', '[v0out]', '-map', '0:a',
      '-c:v:0', 'libx264', '-b:v:0', '400k', '-maxrate:v:0', '600k', '-bufsize:v:0', '800k',
      '-preset', 'fast', '-g', '48', '-sc_threshold', '0', '-keyint_min', '48',
      '-c:a:0', 'aac', '-b:a:0', '64k',
      // Variant 1: 360p
      '-map', '[v1out]', '-map', '0:a',
      '-c:v:1', 'libx264', '-b:v:1', '800k', '-maxrate:v:1', '1200k', '-bufsize:v:1', '1600k',
      '-preset', 'fast', '-g', '48', '-sc_threshold', '0', '-keyint_min', '48',
      '-c:a:1', 'aac', '-b:a:1', '96k',
      // Variant 2: 480p
      '-map', '[v2out]', '-map', '0:a',
      '-c:v:2', 'libx264', '-b:v:2', '1500k', '-maxrate:v:2', '2250k', '-bufsize:v:2', '3000k',
      '-preset', 'fast', '-g', '48', '-sc_threshold', '0', '-keyint_min', '48',
      '-c:a:2', 'aac', '-b:a:2', '128k',
      // Variant 3: 720p
      '-map', '[v3out]', '-map', '0:a',
      '-c:v:3', 'libx264', '-b:v:3', '2500k', '-maxrate:v:3', '3750k', '-bufsize:v:3', '5000k',
      '-preset', 'fast', '-g', '48', '-sc_threshold', '0', '-keyint_min', '48',
      '-c:a:3', 'aac', '-b:a:3', '128k',
      // Variant 4: 1080p
      '-map', '[v4out]', '-map', '0:a',
      '-c:v:4', 'libx264', '-b:v:4', '5000k', '-maxrate:v:4', '7500k', '-bufsize:v:4', '10000k',
      '-preset', 'fast', '-g', '48', '-sc_threshold', '0', '-keyint_min', '48',
      '-c:a:4', 'aac', '-b:a:4', '192k',
      // HLS options
      '-f', 'hls',
      '-hls_time', '6',
      '-hls_playlist_type', 'vod',
      '-hls_segment_filename', `${outputDir}/stream_%v/data%03d.ts`,
      '-master_pl_name', 'master.m3u8',
      '-var_stream_map', 'v:0,a:0 v:1,a:1 v:2,a:2 v:3,a:3 v:4,a:4',
      `${outputDir}/stream_%v/playlist.m3u8`
    ];

    await runFFmpeg(ffmpegArgs, { logStderr: true });

    // Upload HLS files to S3 using streaming
    console.log(`Uploading HLS files for ${fileId}`);

    // Upload master playlist
    const masterKey = `hls/${video.userId}/${fileId}/master.m3u8`;
    const masterReadStream = fs.createReadStream(path.join(outputDir, 'master.m3u8'));
    await s3Client.send(new PutObjectCommand({
      Bucket: process.env.S3_BUCKET,
      Key: masterKey,
      Body: masterReadStream,
      ContentType: 'application/vnd.apple.mpegurl',
      CacheControl: 'max-age=300', // 5 minutes cache for playlists
    }));

    // Upload variant playlists and segments
    for (let i = 0; i < 5; i++) {
      const streamDir = path.join(outputDir, `stream_${i}`);
      if (!fs.existsSync(streamDir)) continue;

      const files = fs.readdirSync(streamDir);

      for (const file of files) {
        const filePath = path.join(streamDir, file);
        const fileKey = `hls/${video.userId}/${fileId}/stream_${i}/${file}`;
        const fileReadStream = fs.createReadStream(filePath);
        const contentType = file.endsWith('.m3u8')
          ? 'application/vnd.apple.mpegurl'
          : 'video/MP2T';

        await s3Client.send(new PutObjectCommand({
          Bucket: process.env.S3_BUCKET,
          Key: fileKey,
          Body: fileReadStream,
          ContentType: contentType,
          CacheControl: file.endsWith('.ts') ? 'max-age=2592000' : 'max-age=300', // 30 days for segments
        }));
      }
    }

    // Upload thumbnail
    console.log(`Uploading thumbnail for ${fileId}`);
    const thumbnailKey = `thumbnails/${video.userId}/${fileId}.jpg`;
    const thumbnailReadStream = fs.createReadStream(thumbnailPath);
    await s3Client.send(new PutObjectCommand({
      Bucket: process.env.S3_BUCKET,
      Key: thumbnailKey,
      Body: thumbnailReadStream,
      ContentType: 'image/jpeg',
      CacheControl: 'max-age=2592000', // 30 days cache
    }));

    // Update database with HLS information
    const renditions = [
      { resolution: '426x240', bitrate: 400000, playlistKey: `hls/${video.userId}/${fileId}/stream_0/playlist.m3u8`, codecs: 'avc1.4d401f,mp4a.40.2' },
      { resolution: '640x360', bitrate: 800000, playlistKey: `hls/${video.userId}/${fileId}/stream_1/playlist.m3u8`, codecs: 'avc1.4d401f,mp4a.40.2' },
      { resolution: '854x480', bitrate: 1500000, playlistKey: `hls/${video.userId}/${fileId}/stream_2/playlist.m3u8`, codecs: 'avc1.4d401f,mp4a.40.2' },
      { resolution: '1280x720', bitrate: 2500000, playlistKey: `hls/${video.userId}/${fileId}/stream_3/playlist.m3u8`, codecs: 'avc1.4d401f,mp4a.40.2' },
      { resolution: '1920x1080', bitrate: 5000000, playlistKey: `hls/${video.userId}/${fileId}/stream_4/playlist.m3u8`, codecs: 'avc1.4d401f,mp4a.40.2' },
    ];

    await Video.findByIdAndUpdate(fileId, {
      status: 'completed',
      hlsMasterKey: masterKey,
      thumbnailKey,
      duration,
      renditions,
      'sizes.processed': await getDirectorySize(outputDir),
      processingEnd: new Date(),
    });

    console.log(`Completed processing video: ${fileId}`);

  } catch (error) {
    console.error(`Error processing video ${fileId}:`, error);

    // Clean up any uploaded files on error
    if (video && video.userId && fileId) {
      await deleteS3Prefix(`hls/${video.userId}/${fileId}/`);
    }

    await Video.findByIdAndUpdate(fileId, {
      status: 'failed',
      processingEnd: new Date()
    });

    throw error;
  } finally {
    // Clean up temporary files
    if (tempDir && fs.existsSync(tempDir)) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch (cleanupError) {
        console.error('Error cleaning up temp files:', cleanupError);
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

  calculateSize(dirPath);
  return totalSize;
}

// Main worker loop with concurrency control
async function processVideoWorker() {
  console.log('Starting video processing worker...');

  const MAX_CONCURRENT_JOBS = 2; // Limit concurrency to avoid disk exhaustion
  let activeJobs = 0;

  while (true) {
    try {
      if (activeJobs >= MAX_CONCURRENT_JOBS) {
        // Wait before checking for new jobs
        await new Promise(resolve => setTimeout(resolve, 5000));
        continue;
      }

      // Use blocking pop with timeout
      const result = await redisClient.brpop('video-processing-queue', 30);

      if (result) {
        const fileId = result[1];
        activeJobs++;

        // Process job without blocking the loop
        processVideo(fileId)
          .catch(error => {
            console.error(`Job ${fileId} failed:`, error);
          })
          .finally(() => {
            activeJobs--;
          });
      }
    } catch (error) {
      console.error('Error in worker loop:', error);
      // Wait before retrying
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }
}

// Handle graceful shutdown
process.on('SIGINT', async () => {
  console.log('Shutting down worker...');
  await redisClient.quit();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('Shutting down worker...');
  await redisClient.quit();
  process.exit(0);
});
// Start the worker
if (import.meta.url === `file://${process.argv[1]}`) {
  processVideoWorker().catch(console.error);
}

export { processVideo, processVideoWorker };
