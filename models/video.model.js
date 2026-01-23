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
  lastViewedAt: {
    type: Date
    // removed default: Date.now — only set when view is actually recorded
  },
  averageWatchTime: {
    type: Number,
    default: 0
  },
  watchCount: {
    type: Number,
    default: 0
  },
  totalWatchTime: {
    type: Number,
    default: 0
  },
  likes: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }],
  dislikes: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }],
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  createdAt: { type: Date, default: Date.now },
  processingStart: Date,
  processingEnd: Date,
}));

export default Video;