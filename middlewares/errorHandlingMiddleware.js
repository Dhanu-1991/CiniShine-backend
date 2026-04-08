const errorHandlingMiddleware = (err, req, res, next) => {
    // If headers already sent, delegate to Express default handler
    if (res.headersSent) {
        return next(err);
    }

    let statusCode = err.statuscode || err.status || 500;
    let message = err.message || "Internal Server Error";

    // Mongoose bad ObjectId error
    if (err.name === "CastError") {
        statusCode = 400;
        message = `Resource not found. Invalid: ${err.path}`;
    }

    // Mongoose duplicate key error
    if (err.code === 11000) {
        statusCode = 400;
        const field = Object.keys(err.keyValue || {}).join(", ") || "field";
        message = `Duplicate value entered for: ${field}`;
    }

    // Mongoose validation error
    if (err.name === "ValidationError") {
        statusCode = 400;
        message = Object.values(err.errors).map(val => val.message).join(", ");
    }

    // JWT errors
    if (err.name === "JsonWebTokenError") {
        statusCode = 401;
        message = "Invalid token";
    }
    if (err.name === "TokenExpiredError") {
        statusCode = 401;
        message = "Token expired";
    }

    console.error(`[Error ${statusCode}] ${req.method} ${req.originalUrl}:`, message);

    res.status(statusCode).json({
        success: false,
        message,
    });
};

export default errorHandlingMiddleware;
