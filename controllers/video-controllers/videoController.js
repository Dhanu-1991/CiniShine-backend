// controllers/video-controllers/videoController.js
import Video from "../../models/video.model.js";
import mongoose from 'mongoose';
import { S3Client, GetObjectCommand, PutObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import Redis from 'ioredis';
import stream from 'stream';
import { promisify } from 'util';

const pipeline = promisify(stream.pipeline);

const redisClient = new Redis(process.env.REDIS_URL, {
    retryStrategy: times => Math.min(times * 50, 2000)
});

const s3Client = new S3Client({
    region: process.env.AWS_REGION,
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
});

// Helper to find HLS files in S3
async function findHLSFiles(videoId, userId) {
    try {
        const prefix = `hls/${userId}/${videoId}/`;
        const command = new ListObjectsV2Command({
            Bucket: process.env.S3_BUCKET,
            Prefix: prefix,
        });
        const response = await s3Client.send(command);
        return response.Contents || [];
    } catch (error) {
        console.error('Error finding HLS files:', error);
        return [];
    }
}

// Helper function to get correct protocol (handles proxies/load balancers)
function getProtocol(req) {
    const forwardedProto = req.headers['x-forwarded-proto'];
    if (forwardedProto) {
        return forwardedProto.split(',')[0].trim();
    }
    if (req.secure) {
        return 'https';
    }
    if (req.headers['x-forwarded-ssl'] === 'on') {
        return 'https';
    }
    return req.protocol;
}

// Get video metadata
export const getVideo = async (req, res) => {
    try {
        const videoId = req.params.id ?? req.params.videoId;
        console.log('📹 Fetching video metadata for ID:', videoId);

        const video = await Video.findById(videoId).populate('userId', 'userName');
        if (!video) {
            console.error('❌ Video not found for ID:', videoId);
            return res.status(404).json({ error: 'Video not found' });
        }

        // Generate signed URL for thumbnail (optional)
        let thumbnailUrl = null;
        if (video.thumbnailKey) {
            try {
                thumbnailUrl = await getSignedUrl(
                    s3Client,
                    new GetObjectCommand({
                        Bucket: process.env.S3_BUCKET,
                        Key: video.thumbnailKey,
                    }),
                    { expiresIn: 3600 }
                );
            } catch (err) {
                console.warn('Could not create signed thumbnail URL:', err.message || err);
                thumbnailUrl = null;
            }
        }

        // Prepare renditions data
        const renditions = (video.renditions || []).map(rendition => ({
            _id: rendition._id,
            name: rendition.name,
            resolution: rendition.resolution,
            bitrate: rendition.bitrate,
            codecs: rendition.codecs
        }));

        res.json({
            _id: video._id,
            title: video.title,
            description: video.description,
            duration: video.duration,
            // point client to backend playlist route (backend will rewrite)
            hlsMasterUrl: `/api/v2/video/${videoId}/master.m3u8`,
            thumbnailUrl,
            renditions,
            status: video.status,
            createdAt: video.createdAt,
            user: video.userId
        });

    } catch (error) {
        console.error('💥 Error fetching video data:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
}

// Get HLS master playlist (rewritten to absolute backend variant URLs)
export const getHLSMasterPlaylist = async (req, res) => {
    try {
        const videoId = req.params.id;
        console.log('🎬 Serving master playlist for video:', videoId);

        if (!mongoose.Types.ObjectId.isValid(videoId)) {
            return res.status(400).json({ error: 'Invalid video ID' });
        }

        const video = await Video.findById(videoId);
        if (!video) {
            console.error('❌ Video not found for ID:', videoId);
            return res.status(404).json({ error: 'Video not found' });
        }

        if (video.status !== 'completed') {
            return res.status(423).json({
                error: 'Video is still processing',
                status: video.status
            });
        }

        if (!video.hlsMasterKey) {
            console.error('❌ No HLS master key found, searching...');
            const hlsFiles = await findHLSFiles(videoId, video.userId);
            const masterFile = hlsFiles.find(file => file.Key && file.Key.includes('master.m3u8'));
            if (!masterFile) {
                return res.status(404).json({ error: 'Master playlist not found' });
            }
            video.hlsMasterKey = masterFile.Key;
            await video.save();
        }

        // Fetch master playlist from S3 (signed URL)
        const signedUrl = await getSignedUrl(
            s3Client,
            new GetObjectCommand({
                Bucket: process.env.S3_BUCKET,
                Key: video.hlsMasterKey,
            }),
            { expiresIn: 3600 }
        );
        console.log('🔑 Generated signed URL for master playlist:', signedUrl);
        const response = await fetch(signedUrl);
        if (!response.ok) {
            console.log("response not ok");
            throw new Error(`S3 responded with status: ${response.status}`);
        }

        let masterContent = await response.text();
        console.log('📄 Master playlist fetched, size:', masterContent.length, 'bytes');

        // Build absolute backend base (so HLS.js won't resolve against blob:)
        // Prefer X-Forwarded-Proto (set by proxies/load-balancers) or req.secure.
        // Falls back to req.protocol if neither is available.
        const protoHeader = req.headers['x-forwarded-proto'];
        const protocol = getProtocol(req);
        const backendBase = `${protocol}://${req.get('host')}`; // e.g. https://example.com

        // Rebuild master playlist: convert variant URIs to absolute backend variant endpoints
        const lines = masterContent.split(/\r?\n/);
        const rebuilt = [];

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];

            if (!line) {
                rebuilt.push(line);
                continue;
            }

            // keep comments/headers
            if (line.startsWith('#')) {
                rebuilt.push(line);

                // when EXT-X-STREAM-INF, next URI line is the variant reference
                if (line.startsWith('#EXT-X-STREAM-INF')) {
                    // find next non-empty, non-comment line
                    let j = i + 1;
                    while (j < lines.length && (!lines[j].trim() || lines[j].startsWith('#'))) {
                        if (lines[j].startsWith('#')) rebuilt.push(lines[j]);
                        j++;
                    }

                    if (j < lines.length) {
                        const variantPath = lines[j].trim();

                        // if absolute, keep it; otherwise map to backend variant endpoint
                        if (/^https?:\/\//i.test(variantPath) || variantPath.startsWith('//')) {
                            rebuilt.push(variantPath);
                        } else {
                            // try to infer quality
                            let quality = 'auto';
                            const pathMatch = variantPath.match(/stream[_\-]?(\d+)p/i);
                            if (pathMatch) {
                                quality = `${pathMatch[1]}p`;
                            } else {
                                const resMatch = line.match(/RESOLUTION=(\d+)x(\d+)/i);
                                if (resMatch) quality = `${resMatch[2]}p`;
                            }

                            const variantFile = variantPath.split('/').pop();
                            const absoluteVariant = `${backendBase}/api/v2/video/${videoId}/variants/${encodeURIComponent(variantFile)}?quality=${encodeURIComponent(quality)}`;
                            console.log(`🔄 Master variant rewrite: ${variantPath} -> ${absoluteVariant}`);
                            rebuilt.push(absoluteVariant);
                        }

                        i = j; // skip the original variant line
                    }
                }
                continue;
            }

            // non-comment lines outside EXT-X-STREAM-INF context: keep absolute or convert to backend variants
            if (/^https?:\/\//i.test(line) || line.startsWith('//')) {
                rebuilt.push(line);
            } else {
                const variantFile = line.split('/').pop();
                const absoluteVariant = `${backendBase}/api/v2/video/${videoId}/variants/${encodeURIComponent(variantFile)}`;
                console.log(`🔄 Master other rewrite: ${line} -> ${absoluteVariant}`);
                rebuilt.push(absoluteVariant);
            }
        }

        const output = rebuilt.join('\n');

        // Set HLS headers
        res.set({
            'Content-Type': 'application/vnd.apple.mpegurl',
            'Content-Disposition': 'inline',
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            'Pragma': 'no-cache',
            'Expires': '0',
            'Access-Control-Allow-Origin': req.headers.origin || '*',
            'Access-Control-Allow-Credentials': 'true'
        });

        console.log('✅ Master playlist served successfully');
        res.send(output);

    } catch (error) {
        console.error('💥 Error serving master playlist:', error);
        res.status(500).json({
            error: 'Failed to load video stream',
            details: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
};

// Get HLS variant playlist (robust key lookup + rewrite nested URIs to absolute backend URLs)
export const getHLSVariantPlaylist = async (req, res) => {
    try {
        const videoId = req.params.id;
        let variantFile = decodeURIComponent(req.params.variantFile || 'playlist.m3u8');
        if (variantFile.includes('?')) variantFile = variantFile.split('?')[0];
        const quality = req.query.quality ? String(req.query.quality).trim() : null;

        console.log('🎬 Serving variant:', variantFile, 'quality:', quality, 'video:', videoId);

        if (!mongoose.Types.ObjectId.isValid(videoId)) {
            return res.status(400).json({ error: 'Invalid video ID' });
        }

        const video = await Video.findById(videoId);
        if (!video) return res.status(404).json({ error: 'Video not found' });
        if (video.status !== 'completed') return res.status(423).json({ error: 'Video is still processing' });

        // Determine base path (folder containing master)
        const basePath = video.hlsMasterKey ?
            video.hlsMasterKey.substring(0, video.hlsMasterKey.lastIndexOf('/') + 1) :
            `hls/${video.userId}/${videoId}/`;

        // build candidate S3 keys
        const q = quality && quality !== 'auto' ? (quality.endsWith('p') ? quality : `${quality}p`) : null;
        const candidates = [];

        if (q) {
            candidates.push(`${basePath}stream_${q}/variants/${variantFile}`);
            candidates.push(`${basePath}variants/stream_${q}/${variantFile}`);
            candidates.push(`${basePath}stream_${q}/${variantFile}`);
        }
        // fallback variants
        candidates.push(`${basePath}variants/${variantFile}`);
        candidates.push(`${basePath}${variantFile}`);

        console.log('🔍 Trying variant S3 keys:', candidates);

        let chosenKey = null;
        let variantContent = null;

        for (const key of candidates) {
            try {
                // create signed URL and try to fetch
                const signedUrl = await getSignedUrl(
                    s3Client,
                    new GetObjectCommand({ Bucket: process.env.S3_BUCKET, Key: key }),
                    { expiresIn: 3600 }
                );

                const response = await fetch(signedUrl);
                if (response && response.ok) {
                    chosenKey = key;
                    variantContent = await response.text();
                    console.log('📄 Found variant at key:', key, 'size:', variantContent.length);
                    break;
                } else {
                    console.warn('⛔ Candidate not available:', key, response?.status);
                }
            } catch (err) {
                console.warn('⛔ Error trying candidate key:', key, err.message || err);
                // continue trying next candidate
            }
        }

        if (!variantContent) {
            console.error('❌ No variant playlist found in candidates');
            return res.status(404).json({ error: 'Variant playlist not found' });
        }

        // Rewrite nested playlist & segment URIs to absolute backend endpoints
        const protocol = getProtocol(req);
        const backendBase = `${protocol}://${req.get('host')}`;
        const qualityParam = quality && quality !== 'auto' ? `?quality=${encodeURIComponent(quality)}` : '';

        variantContent = variantContent.replace(
            /(^|[\r\n])([^#\r\n][^\r\n]*)/g,
            (match, prefix, uri) => {
                const trimmed = uri.trim();
                if (!trimmed) return match;

                // leave absolute URLs alone
                if (/^https?:\/\//i.test(trimmed) || trimmed.startsWith('//')) {
                    return match;
                }

                // If this is a segment file
                if (/\.(ts|m4s|mp4|aac)$/i.test(trimmed)) {
                    const filename = trimmed.split('/').pop();
                    const backendUrl = `${backendBase}/api/v2/video/${videoId}/segments/${encodeURIComponent(filename)}${qualityParam}`;
                    console.log(`🔄 Segment rewrite: ${trimmed} -> ${backendUrl}`);
                    return `${prefix}${backendUrl}`;
                }

                // If this is another playlist file (.m3u8)
                if (trimmed.endsWith('.m3u8')) {
                    const filename = trimmed.split('/').pop();
                    const backendUrl = `${backendBase}/api/v2/video/${videoId}/variants/${encodeURIComponent(filename)}${qualityParam}`;
                    console.log(`🔁 Sub-playlist rewrite: ${trimmed} -> ${backendUrl}`);
                    return `${prefix}${backendUrl}`;
                }

                // Other URIs: leave as-is but ensure no leading blob path
                return `${prefix}${trimmed}`;
            }
        );

        res.set({
            'Content-Type': 'application/vnd.apple.mpegurl',
            'Content-Disposition': 'inline',
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            'Pragma': 'no-cache',
            'Expires': '0',
            'Access-Control-Allow-Origin': req.headers.origin || '*',
            'Access-Control-Allow-Credentials': 'true'
        });

        console.log('✅ Variant served successfully (key):', chosenKey);
        res.send(variantContent);

    } catch (error) {
        console.error('💥 Error serving variant:', error);
        res.status(500).json({
            error: 'Failed to load video variant',
            details: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
};

// Get HLS segment (proxy from S3 instead of redirect)
export const getHLSSegment = async (req, res) => {
    try {
        const videoId = req.params.id; // route uses /video/:id/segments/:segmentFile
        let segmentFile = decodeURIComponent(req.params.segmentFile || '');
        if (segmentFile.includes('?')) segmentFile = segmentFile.split('?')[0];
        const quality = req.query.quality ? String(req.query.quality).trim() : null;

        console.log('🎬 Serving segment:', segmentFile, 'quality:', quality, 'video:', videoId);

        if (!mongoose.Types.ObjectId.isValid(videoId)) {
            return res.status(400).json({ error: 'Invalid video ID' });
        }
        if (!segmentFile || !segmentFile.match(/\.(ts|m4s|mp4|aac)$/i)) {
            return res.status(400).json({ error: 'Invalid segment file' });
        }

        const video = await Video.findById(videoId);
        if (!video) return res.status(404).json({ error: 'Video not found' });
        if (video.status !== 'completed') return res.status(423).json({ error: 'Video is still processing' });

        // Determine base path in S3
        const userId = video.userId;
        const basePath = video.hlsMasterKey ?
            video.hlsMasterKey.substring(0, video.hlsMasterKey.lastIndexOf('/') + 1) :
            `hls/${userId}/${videoId}/`;

        // Candidate keys for segment
        const q = quality && quality !== 'auto' ? (quality.endsWith('p') ? quality : `${quality}p`) : null;
        const candidates = [];
        if (q) {
            candidates.push(`${basePath}stream_${q}/segments/${segmentFile}`);
            candidates.push(`${basePath}stream_${q}/${segmentFile}`);
        }
        candidates.push(`${basePath}segments/${segmentFile}`);
        candidates.push(`${basePath}${segmentFile}`);
        console.log('🔍 Trying segment keys:', candidates);

        // Support Range header for partial requests (important for fMP4 / big files)
        const rangeHeader = req.headers.range;

        let objResponse = null;
        let usedKey = null;

        for (const key of candidates) {
            try {
                const getCmdParams = {
                    Bucket: process.env.S3_BUCKET,
                    Key: key,
                    ...(rangeHeader ? { Range: rangeHeader } : {})
                };
                const getCmd = new GetObjectCommand(getCmdParams);
                objResponse = await s3Client.send(getCmd);
                usedKey = key;
                break;
            } catch (err) {
                const notFound = err && (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404);
                if (notFound) {
                    console.warn('Segment candidate not found:', key);
                    continue;
                }
                console.warn('S3 error while fetching segment candidate:', key, err.message || err);
            }
        }

        if (!objResponse) {
            console.error('❌ No segment found in candidates');
            return res.status(404).json({ error: 'Segment not found in storage' });
        }

        // Prepare headers - forward S3 metadata and range headers where present
        // If Range requested and S3 returned ContentRange, respond 206 Partial Content
        const isPartial = Boolean(rangeHeader) && Boolean(objResponse.ContentRange);
        if (isPartial) {
            res.status(206);
            if (objResponse.ContentRange) res.setHeader('Content-Range', objResponse.ContentRange);
        } else {
            res.status(200);
        }

        if (objResponse.ContentType) res.setHeader('Content-Type', objResponse.ContentType);
        if (objResponse.ContentLength) res.setHeader('Content-Length', String(objResponse.ContentLength));
        if (objResponse.ETag) res.setHeader('ETag', objResponse.ETag);
        if (objResponse.LastModified) res.setHeader('Last-Modified', new Date(objResponse.LastModified).toUTCString());
        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
        res.setHeader('Access-Control-Allow-Credentials', 'true');

        console.log('🔗 Proxying segment from S3 key:', usedKey, isPartial ? '(partial)' : '(full)');
        await pipeline(objResponse.Body, res);

    } catch (error) {
        console.error('💥 Error serving segment:', error);
        res.status(500).json({
            error: 'Failed to load video segment',
            details: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
};

export const getMyContent = async (req, res) => {
    try {
        const userId = req.user;
        console.log("🔍 Fetching videos for user:", userId);

        let userObjectId;
        if (mongoose.Types.ObjectId.isValid(userId)) {
            userObjectId = new mongoose.Types.ObjectId(userId);
        } else {
            userObjectId = userId;
        }

        const videos = await Video.find({ userId: userObjectId })
            .sort({ createdAt: -1 })
            .select('title description duration status thumbnailKey renditions createdAt tags');

        console.log("✅ Videos found:", videos.length);

        const videosWithUrls = await Promise.all(
            videos.map(async (video) => {
                let thumbnailUrl = null;
                if (video.thumbnailKey) {
                    try {
                        thumbnailUrl = await getSignedUrl(
                            s3Client,
                            new GetObjectCommand({
                                Bucket: process.env.S3_BUCKET,
                                Key: video.thumbnailKey,
                            }),
                            { expiresIn: 3600 }
                        );
                    } catch (s3Error) {
                        console.error('❌ Thumbnail error for video:', video._id);
                        thumbnailUrl = null;
                    }
                }

                return {
                    _id: video._id,
                    title: video.title,
                    description: video.description,
                    duration: video.duration,
                    status: video.status,
                    thumbnailUrl,
                    tags: video.tags,
                    createdAt: video.createdAt,
                    renditions: video.renditions || [],
                    adaptiveStreaming: video.status === 'completed'
                };
            })
        );

        res.json(videosWithUrls);
    } catch (error) {
        console.error('💥 Error fetching user videos:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
}

export const getVideoStatus = async (req, res) => {
    try {
        const video = await Video.findById(req.params.id);
        if (!video) {
            return res.status(404).json({ error: 'Video not found' });
        }

        let estimatedTimeRemaining = null;
        if (video.status === 'processing' && video.processingStart) {
            const processingTimeSoFar = Date.now() - video.processingStart.getTime();
            estimatedTimeRemaining = Math.max(0, Math.round((video.duration * 1000 - processingTimeSoFar) / 1000));
        }

        res.json({
            status: video.status,
            progress: video.status === 'processing' ? 'Transcoding in progress' : null,
            estimatedTimeRemaining,
            processingStart: video.processingStart,
            processingEnd: video.processingEnd
        });
    } catch (error) {
        console.error('Error getting video status:', error);
        res.status(500).json({ error: 'Failed to retrieve video status' });
    }
};

export const uploadInit = async (req, res) => {
    try {
        const { fileName, fileType } = req.body;
        const userId = req.user?.id;

        if (!userId) {
            return res.status(401).json({ error: "User not authenticated" });
        }

        const fileId = new mongoose.Types.ObjectId();
        const key = `uploads/${userId}/${fileId}_${fileName}`;

        const video = await Video.create({
            _id: fileId,
            title: fileName,
            originalKey: key,
            userId,
        });

        const command = new PutObjectCommand({
            Bucket: process.env.S3_BUCKET,
            Key: key,
            ContentType: fileType,
        });

        const uploadUrl = await getSignedUrl(s3Client, command, { expiresIn: 3600 });
        res.json({ uploadUrl, fileId });
    } catch (error) {
        console.error("Error generating presigned URL:", error);
        res.status(500).json({ error: "Failed to generate upload URL" });
    }
};

export const uploadComplete = async (req, res) => {
    try {
        const { fileId, fileSize } = req.body;

        if (!mongoose.Types.ObjectId.isValid(fileId)) {
            return res.status(400).json({ error: 'Invalid file ID' });
        }

        await Video.findByIdAndUpdate(fileId, {
            status: 'processing',
            'sizes.original': fileSize,
            processingStart: new Date()
        });

        await redisClient.lpush('video-processing-queue', fileId.toString());
        console.log(`✅ Video ${fileId} added to processing queue`);

        res.json({ success: true, message: 'Video queued for processing' });
    } catch (error) {
        console.error('Error completing upload:', error);
        res.status(500).json({ error: 'Failed to complete upload' });
    }
};
