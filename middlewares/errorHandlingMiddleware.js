const errorHandlingMiddleware = (err, req, res, next) => {
    try{
        let error={...err};
        error.message = err.message;
        console.error(err);
        // Mongoose bad ObjectId error
        if(err.name === "CastError"){
            error.status = 400;
            error.message = `Resource not found. Invalid: ${err.path}`;
            error=new Error(error.message);
            console .error(error);
        }
        // Mongoose duplicate key error
        if(err.code === 11000){
            error.status = 400;
            error.message = `Duplicate field value entered: ${err.keyValue.name}`;
            error=new Error(error.message);
            console.error(error);
        }
        // Mongoose validation error
        if(err.name === "ValidationError"){
            error.status = 400;
            error.message = Object.values(err.errors).map(val => val.message);
            error=new Error(error.message.join(', '));
            console.error(error);
        }
    }
    catch(err){
        console.error(err);
    }
};

export default errorHandlingMiddleware;
