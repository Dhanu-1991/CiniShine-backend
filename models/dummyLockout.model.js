import mongoose from 'mongoose';

const DummyLockoutSchema = new mongoose.Schema({
    contact: {
        type: String,
        required: true,
        unique: true,
        trim: true,
        lowercase: true
    },
    locked_at: {
        type: Date,
        default: Date.now
    }
}, { timestamps: true });

const DummyLockout = mongoose.model('DummyLockout', DummyLockoutSchema);
export default DummyLockout;
