import mongoose from 'mongoose';

const Video = mongoose.model('Video', new mongoose.Schema({
  title: String,
  description: String,
  originalKey: String,
  hlsMasterKey: String,
  thumbnailKey: String,
  views: {
    type: Number,
    default: 0
  },
  status: {
    type: String,
    enum: ['uploading', 'processing', 'completed', 'failed'],
    default: 'uploading'
  },
  duration: Number,
  sizes: {
    original: Number,
    processed: Number,
  },
  renditions: [{
    resolution: String,
    bitrate: Number,
    playlistKey: String,
    codecs: String,
  }],
  viewHistory: [{
    lastViewedAt: {
      type: Date
      // removed default: Date.now — only set when view is actually recorded
    },
    ipAddress: String,
    userAgent: String
  }],
  lastViewedAt: {
    type: Date
    // removed default: Date.now — only set when view is actually recorded
  },
  userId: mongoose.Schema.Types.ObjectId,
  createdAt: { type: Date, default: Date.now },
  processingStart: Date,
  processingEnd: Date,
}));

export default Video;