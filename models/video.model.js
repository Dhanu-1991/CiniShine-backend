import mongoose from 'mongoose';

const Video = mongoose.model('Video', new mongoose.Schema({
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
  originalKey: String,
  hlsMasterKey: String,
  thumbnailKey: String,
  thumbnailSource: {
    type: String,
    enum: ['auto', 'custom'],
    default: 'auto'
  },

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

  // Creator roles associated with this content
  selectedRoles: [{
    type: String,
    trim: true
  }],

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
  fileSize: Number,
  mimeType: String,
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
  likeCount: {
    type: Number,
    default: 0
  },
  dislikeCount: {
    type: Number,
    default: 0
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  createdAt: { type: Date, default: Date.now },
  processingStart: Date,
  processingEnd: Date,
}));

export default Video;